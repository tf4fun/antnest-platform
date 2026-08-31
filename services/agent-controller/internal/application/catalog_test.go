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
	if sealer.credentialRef != created.CredentialRef {
		t.Fatal("credential identity was not bound as authenticated encryption context")
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

func TestReviseModelProfileBuildsNextRevisionAgainstLockedHead(t *testing.T) {
	t.Parallel()

	current := ports.ModelProfileRecord{
		ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Revision: mustModelRevision(t, "model-revision-1", "org-1"),
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
	store := &catalogStoreStub{modelRecord: current}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})

	view, err := service.ReviseModelProfile(context.Background(), ReviseModelProfileInput{
		RequestID: "request-revise", ModelProfileID: "model-1", DisplayName: "DeepSeek V2",
		Model: validModelInput(), CredentialSecret: "new-secret",
	})
	if err != nil {
		t.Fatalf("revise ModelProfile: %v", err)
	}
	if store.expectedModelRevision != 1 || store.modelRecord.Revision.Revision() != 2 {
		t.Fatalf("revision CAS was not preserved: expected=%d record=%+v", store.expectedModelRevision, store.modelRecord)
	}
	if view.ModelProfileID != "model-1" || view.Revision != 2 || view.DisplayName != "DeepSeek V2" {
		t.Fatalf("unexpected revised profile: %+v", view)
	}
}

func TestReviseTemplateRejectsCrossOrganizationModelAndBuildsNextRevision(t *testing.T) {
	t.Parallel()

	currentRevision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileRevisionID: "model-revision-1", SystemPrompt: "old",
		MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: validRuntimeInput(),
	})
	if err != nil {
		t.Fatalf("create current Template revision: %v", err)
	}
	store := &catalogStoreStub{
		templateRecord: ports.TemplateRecord{
			TemplateID: "template-1", OrganizationID: "org-1", TemplateKey: "personal",
			Name: "Personal", Revision: currentRevision, Enabled: true,
			CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
		},
		modelRevision: mustModelRevision(t, "model-revision-2", "org-2"),
	}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})
	input := ReviseTemplateInput{
		RequestID: "request-template-revise", TemplateID: "template-1", Name: "Personal V2",
		ModelProfileRevisionID: "model-revision-2", SystemPrompt: "new", MaxModelRequests: 16,
		ContextPolicyVersion: domain.ContextPolicyV1, Runtime: validRuntimeInput(),
	}
	if _, err := service.ReviseTemplate(context.Background(), input); !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("cross-organization revision error = %v", err)
	}

	store.modelRevision = mustModelRevision(t, "model-revision-2", "org-1")
	view, err := service.ReviseTemplate(context.Background(), input)
	if err != nil {
		t.Fatalf("revise Template: %v", err)
	}
	if store.expectedTemplateRevision != 1 || view.Revision != 2 || view.Name != "Personal V2" {
		t.Fatalf("Template revision CAS was not preserved: expected=%d view=%+v", store.expectedTemplateRevision, view)
	}
}

func TestCatalogReadsCurrentHeadsWithBoundedPagination(t *testing.T) {
	t.Parallel()

	model := ports.ModelProfileRecord{
		ModelProfileID: "model-1", OrganizationID: "org-1", ProfileKey: "deepseek",
		DisplayName: "DeepSeek", Revision: mustModelRevision(t, "model-revision-1", "org-1"),
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(2, 0).UTC(),
	}
	store := &catalogStoreStub{modelRecord: model, modelPage: []ports.ModelProfileRecord{model}}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{now: time.Unix(2, 0).UTC()})

	loaded, err := service.GetModelProfile(context.Background(), "model-1")
	if err != nil {
		t.Fatalf("get ModelProfile: %v", err)
	}
	if loaded.Model.Model != "deepseek-chat" || !loaded.Enabled {
		t.Fatalf("current ModelProfile view is incomplete: %+v", loaded)
	}
	page, err := service.ListModelProfiles(context.Background(), ListCatalogInput{
		OrganizationID: "org-1", AfterID: "model-0", Limit: 20,
	})
	if err != nil {
		t.Fatalf("list ModelProfiles: %v", err)
	}
	if len(page.Items) != 1 || store.listLimit != 20 || store.listAfterID != "model-0" {
		t.Fatalf("pagination was not preserved: page=%+v store=%+v", page, store)
	}
	if _, err := service.ListModelProfiles(context.Background(), ListCatalogInput{
		OrganizationID: "org-1", Limit: 501,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("oversized page error = %v", err)
	}
}

type catalogStoreStub struct {
	modelRevision            domain.ModelProfileRevision
	modelRecord              ports.ModelProfileRecord
	modelPage                []ports.ModelProfileRecord
	templateRecord           ports.TemplateRecord
	templatePage             []ports.TemplateRecord
	expectedModelRevision    int64
	expectedTemplateRevision int64
	listAfterID              string
	listLimit                int
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

func (store *catalogStoreStub) GetModelProfile(_ context.Context, id string) (ports.ModelProfileRecord, error) {
	if store.modelRecord.ModelProfileID != id {
		return ports.ModelProfileRecord{}, ports.ErrNotFound
	}
	return store.modelRecord, nil
}

func (store *catalogStoreStub) ReviseModelProfile(
	_ context.Context, expectedRevision int64, record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	store.expectedModelRevision = expectedRevision
	store.modelRecord = record
	return record, nil
}

func (store *catalogStoreStub) ListModelProfiles(
	_ context.Context, _ string, afterID string, limit int,
) ([]ports.ModelProfileRecord, string, error) {
	store.listAfterID = afterID
	store.listLimit = limit
	return store.modelPage, "", nil
}

func (store *catalogStoreStub) PutTemplate(_ context.Context, record ports.TemplateRecord) (ports.TemplateRecord, error) {
	store.templateRecord = record
	return record, nil
}

func (store *catalogStoreStub) GetTemplate(_ context.Context, id string) (ports.TemplateRecord, error) {
	if store.templateRecord.TemplateID != id {
		return ports.TemplateRecord{}, ports.ErrNotFound
	}
	return store.templateRecord, nil
}

func (store *catalogStoreStub) ReviseTemplate(
	_ context.Context, expectedRevision int64, record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	store.expectedTemplateRevision = expectedRevision
	store.templateRecord = record
	return record, nil
}

func (store *catalogStoreStub) ListTemplates(
	_ context.Context, _ string, afterID string, limit int,
) ([]ports.TemplateRecord, string, error) {
	store.listAfterID = afterID
	store.listLimit = limit
	return store.templatePage, "", nil
}

type sealerStub struct {
	credentialRef string
	plaintext     string
	sealed        ports.SealedSecret
}

func (sealer *sealerStub) Seal(
	_ context.Context, credentialRef string, plaintext string,
) (ports.SealedSecret, error) {
	sealer.credentialRef = credentialRef
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
