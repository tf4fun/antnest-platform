package postgres

import (
	"context"
	"errors"
	"os"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCatalogRepositoryPersistsAndReplaysRequests(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}

	record := integrationModelRecord(t)
	created, err := repository.PutModelProfile(ctx, record)
	if err != nil {
		t.Fatalf("put ModelProfile: %v", err)
	}
	replayed, err := repository.PutModelProfile(ctx, record)
	if err != nil {
		t.Fatalf("replay ModelProfile: %v", err)
	}
	if replayed.ModelProfileID != created.ModelProfileID || replayed.Revision.ID() != created.Revision.ID() {
		t.Fatal("idempotent replay returned a different resource")
	}

	conflict := record
	conflict.RequestFingerprint = "different"
	if _, err := repository.PutModelProfile(ctx, conflict); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("request conflict error = %v", err)
	}

	loaded, err := repository.GetModelProfileRevision(ctx, record.Revision.ID())
	if err != nil {
		t.Fatalf("get ModelProfile revision: %v", err)
	}
	if loaded.OrganizationID() != "org-integration" {
		t.Fatalf("loaded organization = %s", loaded.OrganizationID())
	}

	template := integrationTemplateRecord(t, loaded)
	if _, err := repository.PutTemplate(ctx, template); err != nil {
		t.Fatalf("put Template: %v", err)
	}
}

func integrationModelRecord(t *testing.T) ports.ModelProfileRecord {
	t.Helper()
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: "modelrev_integration", ModelProfileID: "model_integration",
		OrganizationID: "org-integration", Revision: 1,
		Model: domain.ModelSpec{
			BaseURL: "https://api.example.com/v1", Model: "model",
			ContextWindow: 32000, MaxOutputTokens: 2048,
		},
		CredentialRef: "credential_integration", CredentialVersion: "credver_integration",
	})
	if err != nil {
		t.Fatalf("model revision: %v", err)
	}
	return ports.ModelProfileRecord{
		RequestID: "request_model_integration", RequestFingerprint: "fingerprint-model",
		ModelProfileID: "model_integration", OrganizationID: "org-integration",
		ProfileKey: "model-key", DisplayName: "Model", Revision: revision,
		CredentialRef: "credential_integration", CredentialVersion: "credver_integration",
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce")},
		CreatedAt:        time.Unix(1, 0).UTC(),
	}
}

func integrationTemplateRecord(t *testing.T, model domain.ModelProfileRevision) ports.TemplateRecord {
	t.Helper()
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template_integration", OrganizationID: "org-integration", Revision: 1,
		ModelProfileRevisionID: model.ID(), SystemPrompt: "prompt", MaxModelRequests: 8,
		ContextPolicyVersion: "context-v1",
		Runtime: domain.RuntimeSpecInput{
			ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Resources: domain.RuntimeResources{
				MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
			},
		},
	})
	if err != nil {
		t.Fatalf("Template revision: %v", err)
	}
	return ports.TemplateRecord{
		RequestID: "request_template_integration", RequestFingerprint: "fingerprint-template",
		TemplateID: "template_integration", OrganizationID: "org-integration",
		TemplateKey: "template-key", Name: "Template", Revision: revision,
		CreatedAt: time.Unix(1, 0).UTC(),
	}
}
