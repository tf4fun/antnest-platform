package postgres

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type mcpSecretClock struct{}

func (mcpSecretClock) Now() time.Time { return time.Unix(200, 0).UTC() }

func TestManagedMCPSecretsPersistAtomicallyAndRotateWithoutSnapshotChanges(t *testing.T) {
	repository := providerTestRepository(t)
	old, ring, retired := providerRotationBoxes(t)
	provider := createRekeyProvider(t, repository, old, "mcp-rekey-provider")
	models, _, err := repository.ListModelProfiles(t.Context(), provider.OrganizationID, "", 10)
	if err != nil || len(models) == 0 {
		t.Fatal("load real encrypted Provider model", err)
	}
	model := models[0]
	service := application.NewCatalogService(repository, old, mcpSecretClock{}, application.WithProviderCredentialReader(repository, old))
	runtime := integrationTemplateRecord(t, model.Revision).Revision.Snapshot().Runtime
	value := "managed-mcp-postgres-private-canary"
	runtime.MCPServers = []domain.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]domain.MCPSecret{"API_KEY": {Value: &value}}}}
	view, err := service.CreateTemplate(t.Context(), application.CreateTemplateInput{RequestID: "secret-create", OrganizationID: model.OrganizationID, TemplateKey: "mcp-secret", Name: "MCP", ModelProfileID: model.ModelProfileID, MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime})
	if err != nil {
		t.Fatal(err)
	}
	location := ports.MCPSecretLocation{OrganizationID: model.OrganizationID, TemplateID: view.TemplateID, Revision: 1, ServerID: "docs", Name: "API_KEY"}
	sealed, err := repository.GetMCPSecret(t.Context(), location)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(sealed.Sealed.Ciphertext, []byte(value)) || len(sealed.Sealed.WrappedDataKey) == 0 {
		t.Fatal("secret stored without an envelope")
	}
	var before string
	if err := repository.pool.QueryRow(t.Context(), `SELECT runtime_input::text FROM agent_controller.agent_template_revisions WHERE template_id=$1 AND revision=1`, view.TemplateID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains([]byte(before), []byte(value)) {
		t.Fatal("Runtime JSON contains plaintext")
	}
	payload, _ := json.Marshal(view)
	if bytes.Contains(payload, []byte(value)) {
		t.Fatal("Template view leaked secret")
	}
	if err := repository.RekeyProviderCredentials(t.Context(), ring, 1, nil); err != nil {
		t.Fatal(err)
	}
	var after string
	if err := repository.pool.QueryRow(t.Context(), `SELECT runtime_input::text FROM agent_controller.agent_template_revisions WHERE template_id=$1 AND revision=1`, view.TemplateID).Scan(&after); err != nil || before != after {
		t.Fatal("rotation changed frozen snapshot", err)
	}
	reader := application.NewCatalogService(repository, retired, mcpSecretClock{}, application.WithProviderCredentialReader(repository, retired))
	resolved, err := reader.ResolveMCPSecrets(t.Context(), ports.MCPTemplateSource{OrganizationID: model.OrganizationID, TemplateID: view.TemplateID, Revision: 1})
	if err != nil || resolved["docs"]["API_KEY"] != value {
		t.Fatal("retiring old master key broke bootstrap", err)
	}
	runtime.MCPServers[0].SecretEnv["API_KEY"] = domain.MCPSecret{Keep: true}
	kept, err := reader.ReviseTemplate(t.Context(), application.ReviseTemplateInput{RequestID: "secret-keep", OrganizationID: model.OrganizationID, TemplateID: view.TemplateID, Name: "MCP", ModelProfileID: model.ModelProfileID, MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime})
	if err != nil || kept.Revision != 2 {
		t.Fatal("keep failed", err)
	}
	location.Revision = 2
	newSecret, err := repository.GetMCPSecret(t.Context(), location)
	if err != nil || newSecret.Sealed.KeyVersion != "kid2" {
		t.Fatal("keep did not bind active key", err)
	}
	location.Revision = 1
	if _, err := retired.Open(t.Context(), location.CredentialIdentity(), newSecret.Sealed); err == nil {
		t.Fatal("copying envelope to old revision worked")
	}
}
