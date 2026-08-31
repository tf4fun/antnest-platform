package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCreateModelProfileSealsCredentialAndPersistsImmutableRevision(t *testing.T) {
	t.Parallel()

	store := &catalogStoreStub{}
	sealer := &sealerStub{sealed: ports.SealedSecret{Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce")}}
	service := NewCatalogService(store, sealer, fixedClock{now: time.Unix(1, 0).UTC()})

	created, err := service.CreateModelProfile(context.Background(), CreateModelProfileInput{
		RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Model: validModelInput(), CredentialSecret: "secret-value",
	})
	if err != nil {
		t.Fatalf("create model profile: %v", err)
	}
	if created.ModelProfileID == "" || created.RevisionID == "" || created.CredentialRef == "" {
		t.Fatalf("generated identities are incomplete: %+v", created)
	}
	if store.modelRecord.Revision.ID() != created.RevisionID {
		t.Fatal("persisted revision differs from response")
	}
	if string(store.modelRecord.SealedCredential.Ciphertext) != "ciphertext" {
		t.Fatal("sealed credential was not persisted")
	}
	if sealer.plaintext != "secret-value" {
		t.Fatal("credential was not passed to sealer")
	}
	if store.modelRecord.RequestFingerprint == "" || store.modelRecord.RequestFingerprint == "secret-value" {
		t.Fatal("request fingerprint is missing or leaks the secret")
	}
}

func TestCreateModelProfileRetryUsesDeterministicResourceIdentities(t *testing.T) {
	t.Parallel()

	store := &catalogStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()})
	input := CreateModelProfileInput{
		RequestID: "request-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Model: validModelInput(), CredentialSecret: "secret-value",
	}
	first, err := service.CreateModelProfile(context.Background(), input)
	if err != nil {
		t.Fatalf("first create: %v", err)
	}
	firstRecord := store.modelRecord
	second, err := service.CreateModelProfile(context.Background(), input)
	if err != nil {
		t.Fatalf("retry create: %v", err)
	}
	if first.ModelProfileID != second.ModelProfileID || first.RevisionID != second.RevisionID {
		t.Fatalf("retry identities changed: %+v %+v", first, second)
	}
	if firstRecord.RequestFingerprint != store.modelRecord.RequestFingerprint {
		t.Fatal("retry fingerprint changed")
	}
}

func TestCreateTemplateMaterializesOnlyMatchingOrganizationModel(t *testing.T) {
	t.Parallel()

	model, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
		Revision: 1, Model: validModelInput(), CredentialRef: "credential-1",
		CredentialVersion: "credential-version-1",
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	store := &catalogStoreStub{modelRevision: model}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(1, 0).UTC()})

	created, err := service.CreateTemplate(context.Background(), CreateTemplateInput{
		RequestID: "request-2", OrganizationID: "org-1", TemplateKey: "personal",
		Name: "Personal Agent", ModelProfileRevisionID: "model-revision-1",
		SystemPrompt: "You are helpful.", MaxModelRequests: 16,
		ContextPolicyVersion: "context-v1", Runtime: validRuntimeInput(),
	})
	if err != nil {
		t.Fatalf("create template: %v", err)
	}
	if created.TemplateID == "" || created.Revision != 1 {
		t.Fatalf("unexpected Template response: %+v", created)
	}
	if store.templateRecord.Revision.ModelProfileRevisionID() != model.ID() {
		t.Fatal("Template did not retain the resolved model revision")
	}

	store.modelRevision = mustModelRevision(t, "model-revision-2", "org-2")
	_, err = service.CreateTemplate(context.Background(), CreateTemplateInput{
		RequestID: "request-3", OrganizationID: "org-1", TemplateKey: "invalid",
		Name: "Invalid", ModelProfileRevisionID: "model-revision-2",
		SystemPrompt: "prompt", MaxModelRequests: 8,
		ContextPolicyVersion: "context-v1", Runtime: validRuntimeInput(),
	})
	if !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization model error = %v", err)
	}
}

type catalogStoreStub struct {
	modelRevision  domain.ModelProfileRevision
	modelRecord    ports.ModelProfileRecord
	templateRecord ports.TemplateRecord
}

func (store *catalogStoreStub) PutModelProfile(_ context.Context, record ports.ModelProfileRecord) (ports.ModelProfileRecord, error) {
	store.modelRecord = record
	return record, nil
}

func (store *catalogStoreStub) GetModelProfileRevision(_ context.Context, id string) (domain.ModelProfileRevision, error) {
	if store.modelRevision.ID() == "" || store.modelRevision.ID() != id {
		return domain.ModelProfileRevision{}, ports.ErrNotFound
	}
	return store.modelRevision, nil
}

func (store *catalogStoreStub) PutTemplate(_ context.Context, record ports.TemplateRecord) (ports.TemplateRecord, error) {
	store.templateRecord = record
	return record, nil
}

type sealerStub struct {
	plaintext string
	sealed    ports.SealedSecret
}

func (sealer *sealerStub) Seal(_ context.Context, plaintext string) (ports.SealedSecret, error) {
	sealer.plaintext = plaintext
	return sealer.sealed, nil
}

type fixedClock struct{ now time.Time }

func (clock fixedClock) Now() time.Time { return clock.now }

func validModelInput() domain.ModelSpec {
	return domain.ModelSpec{
		BaseURL: "https://api.example.com/v1", Model: "deepseek-chat",
		ContextWindow: 128000, MaxOutputTokens: 8192,
	}
}

func validRuntimeInput() domain.RuntimeSpecInput {
	return domain.RuntimeSpecInput{
		ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Resources: domain.RuntimeResources{
			MemoryBytes: 512 * 1024 * 1024, PIDsLimit: 256, TmpfsBytes: 64 * 1024 * 1024,
		},
	}
}

func mustModelRevision(t *testing.T, id string, organizationID string) domain.ModelProfileRevision {
	t.Helper()
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: id, ModelProfileID: "model-1", OrganizationID: organizationID,
		Revision: 1, Model: validModelInput(), CredentialRef: "credential-1",
		CredentialVersion: "credential-version-1",
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	return revision
}
