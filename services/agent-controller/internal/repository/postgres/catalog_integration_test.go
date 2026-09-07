package postgres

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
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
	resetCatalogSchema(t, ctx, repository)
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
	conflict.RequestFingerprint = strings.Repeat("f", 64)
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

	revisedModel := integrationRevisedModelRecord(t, record)
	if _, err := repository.ReviseModelProfile(ctx, 1, revisedModel); err != nil {
		t.Fatalf("revise ModelProfile: %v", err)
	}
	currentModel, err := repository.GetModelProfile(ctx, record.ModelProfileID)
	if err != nil {
		t.Fatalf("get current ModelProfile: %v", err)
	}
	if currentModel.Revision.Revision() != 2 || currentModel.DisplayName != "Model V2" {
		t.Fatalf("current ModelProfile = %+v", currentModel)
	}
	staleRevision := integrationRevisedModelRecord(t, record)
	staleRevision.RequestID = "request_model_stale"
	staleRevision.RequestFingerprint = strings.Repeat("e", 64)
	staleRevision.Revision = mustIntegrationModelRevision(t, "modelrev_stale", 2, "credential_stale", "credver_stale")
	staleRevision.CredentialRef = "credential_stale"
	staleRevision.CredentialVersion = "credver_stale"
	if _, err := repository.ReviseModelProfile(ctx, 1, staleRevision); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale ModelProfile revision error = %v", err)
	}
	models, _, err := repository.ListModelProfiles(ctx, "org-integration", "", 10)
	if err != nil || len(models) != 1 || models[0].Revision.Revision() != 2 {
		t.Fatalf("list current ModelProfiles: models=%+v err=%v", models, err)
	}

	template := integrationTemplateRecord(t, revisedModel.Revision)
	if _, err := repository.PutTemplate(ctx, template); err != nil {
		t.Fatalf("put Template: %v", err)
	}
	loadedTemplate, err := repository.GetTemplate(ctx, template.TemplateID)
	if err != nil || !reflect.DeepEqual(loadedTemplate.Revision.Snapshot().Runtime.MCPServers, template.Revision.Snapshot().Runtime.MCPServers) {
		t.Fatalf("MCP configuration did not survive template persistence: %v", err)
	}
	if replayed, found, err := repository.ReplayTemplateRequest(
		ctx, ports.CreateTemplateRequest, template.RequestID, template.RequestFingerprint,
	); err != nil || !found || replayed.TemplateID != template.TemplateID {
		t.Fatalf("replay Template request: record=%+v found=%t err=%v", replayed, found, err)
	}
	revisedTemplate := integrationRevisedTemplateRecord(t, template, revisedModel.Revision)
	if _, err := repository.ReviseTemplate(ctx, 1, revisedTemplate); err != nil {
		t.Fatalf("revise Template: %v", err)
	}
	currentTemplate, err := repository.GetTemplate(ctx, template.TemplateID)
	if err != nil || currentTemplate.Revision.Revision() != 2 {
		t.Fatalf("get current Template: record=%+v err=%v", currentTemplate, err)
	}
	templates, _, err := repository.ListTemplates(ctx, "org-integration", "", 10)
	if err != nil || len(templates) != 1 || templates[0].Revision.Revision() != 2 {
		t.Fatalf("list current Templates: templates=%+v err=%v", templates, err)
	}

	crossKind := template
	crossKind.RequestID = record.RequestID
	if _, err := repository.PutTemplate(ctx, crossKind); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("cross-kind request identity error = %v", err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.model_profiles SET enabled = FALSE WHERE id = $1`, record.ModelProfileID); err != nil {
		t.Fatalf("disable ModelProfile fixture: %v", err)
	}
	if _, err := repository.GetModelProfileRevision(ctx, revisedModel.Revision.ID()); !errors.Is(err, ports.ErrDisabledReference) {
		t.Fatalf("disabled ModelProfile revision error = %v", err)
	}
}

func TestCatalogRepositorySerializesConcurrentRequestReplay(t *testing.T) {
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
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}

	record := integrationModelRecord(t)
	const callers = 20
	results := make(chan ports.ModelProfileRecord, callers)
	errorsFound := make(chan error, callers)
	var group sync.WaitGroup
	group.Add(callers)
	for range callers {
		go func() {
			defer group.Done()
			created, createErr := repository.PutModelProfile(ctx, record)
			if createErr != nil {
				errorsFound <- createErr
				return
			}
			results <- created
		}()
	}
	group.Wait()
	close(results)
	close(errorsFound)
	for err := range errorsFound {
		t.Errorf("concurrent replay: %v", err)
	}
	for created := range results {
		if created.ModelProfileID != record.ModelProfileID || created.Revision.ID() != record.Revision.ID() {
			t.Errorf("concurrent replay returned %+v", created)
		}
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
		RequestID: "request_model_integration", RequestFingerprint: strings.Repeat("a", 64),
		ModelProfileID: "model_integration", OrganizationID: "org-integration",
		ProfileKey: "model-key", DisplayName: "Model", Revision: revision,
		CredentialRef: "credential_integration", CredentialVersion: "credver_integration",
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("ciphertext"), Nonce: []byte("nonce")},
		Enabled:          true,
		CreatedAt:        time.Unix(1, 0).UTC(),
		UpdatedAt:        time.Unix(1, 0).UTC(),
	}
}

func integrationRevisedModelRecord(t *testing.T, current ports.ModelProfileRecord) ports.ModelProfileRecord {
	t.Helper()
	revision := mustIntegrationModelRevision(t, "modelrev_integration_v2", 2, "credential_integration_v2", "credver_integration_v2")
	return ports.ModelProfileRecord{
		RequestID: "request_model_integration_v2", RequestFingerprint: strings.Repeat("b", 64),
		ModelProfileID: current.ModelProfileID, OrganizationID: current.OrganizationID,
		ProfileKey: current.ProfileKey, DisplayName: "Model V2", Revision: revision,
		CredentialRef: "credential_integration_v2", CredentialVersion: "credver_integration_v2",
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("ciphertext-v2"), Nonce: []byte("nonce-v2")},
		Enabled:          true, CreatedAt: current.CreatedAt, UpdatedAt: time.Unix(2, 0).UTC(),
	}
}

func mustIntegrationModelRevision(
	t *testing.T, id string, revisionNumber int64, credentialRef string, credentialVersion string,
) domain.ModelProfileRevision {
	t.Helper()
	revision, err := domain.NewModelProfileRevision(domain.ModelProfileRevisionInput{
		ID: id, ModelProfileID: "model_integration", OrganizationID: "org-integration",
		Revision: revisionNumber,
		Model: domain.ModelSpec{
			BaseURL: "https://api.example.com/v1", Model: "model-v2",
			ContextWindow: 64000, MaxOutputTokens: 4096,
		},
		CredentialRef: credentialRef, CredentialVersion: credentialVersion,
	})
	if err != nil {
		t.Fatalf("model revision: %v", err)
	}
	return revision
}

func integrationTemplateRecord(t *testing.T, model domain.ModelProfileRevision) ports.TemplateRecord {
	t.Helper()
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template_integration", OrganizationID: "org-integration", Revision: 1,
		ModelProfileRevisionID: model.ID(), SystemPrompt: "prompt", MaxModelRequests: 8,
		ContextPolicyVersion: "context-v1",
		Runtime: domain.RuntimeSpecInput{
			ImageRef:   "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			MCPServers: []domain.MCPServer{{ID: "documents", Command: "node", Args: []string{"server.js"}, Env: map[string]string{"TOKEN": "synthetic-mcp-token"}}},
			Resources: domain.RuntimeResources{
				MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
			},
		},
	})
	if err != nil {
		t.Fatalf("Template revision: %v", err)
	}
	return ports.TemplateRecord{
		RequestID: "request_template_integration", RequestFingerprint: strings.Repeat("c", 64),
		TemplateID: "template_integration", OrganizationID: "org-integration",
		TemplateKey: "template-key", Name: "Template", Revision: revision,
		Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
}

func integrationRevisedTemplateRecord(
	t *testing.T, current ports.TemplateRecord, model domain.ModelProfileRevision,
) ports.TemplateRecord {
	t.Helper()
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: current.TemplateID, OrganizationID: current.OrganizationID, Revision: 2,
		ModelProfileRevisionID: model.ID(), SystemPrompt: "prompt-v2", MaxModelRequests: 16,
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
		RequestID: "request_template_integration_v2", RequestFingerprint: strings.Repeat("d", 64),
		TemplateID: current.TemplateID, OrganizationID: current.OrganizationID,
		TemplateKey: current.TemplateKey, Name: "Template V2", Revision: revision,
		Enabled: true, CreatedAt: current.CreatedAt, UpdatedAt: time.Unix(2, 0).UTC(),
	}
}

func resetCatalogSchema(t *testing.T, ctx context.Context, repository *Repository) {
	t.Helper()
	if _, err := repository.pool.Exec(ctx, `DROP SCHEMA IF EXISTS agent_controller CASCADE`); err != nil {
		t.Fatalf("reset Agent Controller schema: %v", err)
	}
}
