package postgres

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"sync"
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
	input := application.CreateTemplateInput{RequestID: "secret-create", OrganizationID: model.OrganizationID, TemplateKey: "mcp-secret", Name: "MCP", ModelProfileID: model.ModelProfileID, MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime}
	view, err := service.CreateTemplate(t.Context(), input)
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
	replayed, err := reader.CreateTemplate(t.Context(), input)
	if err != nil || replayed.TemplateID != view.TemplateID || replayed.Revision != 1 {
		t.Fatal("master-key retirement broke keyed request replay", err)
	}
	changed := input
	changed.Runtime.MCPServers = domain.CloneMCPServers(input.Runtime.MCPServers)
	guess := "other-low-entropy-value"
	changed.Runtime.MCPServers[0].SecretEnv["API_KEY"] = domain.MCPSecret{Value: &guess}
	if _, err := reader.CreateTemplate(t.Context(), changed); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatal("changed secret request replay accepted", err)
	}
	var fingerprint string
	if err := repository.pool.QueryRow(t.Context(), `SELECT request_fingerprint FROM agent_controller.catalog_requests WHERE request_id=$1`, input.RequestID).Scan(&fingerprint); err != nil || !strings.HasPrefix(fingerprint, "hmac-sha256:") {
		t.Fatal("request receipt is not keyed", err)
	}
	resolved, err := reader.ResolveMCPSecrets(t.Context(), ports.MCPTemplateSource{OrganizationID: model.OrganizationID, TemplateID: view.TemplateID, Revision: 1})
	if err != nil || resolved["docs"]["API_KEY"] != value {
		t.Fatal("retiring old master key broke bootstrap", err)
	}
	runtime.MCPServers = domain.CloneMCPServers(runtime.MCPServers)
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
	// Replaying the older value write must not resolve the current Template head.
	if replay, err := reader.CreateTemplate(t.Context(), input); err != nil || replay.Revision != 1 {
		t.Fatal("head advancement broke frozen keyed receipt", err)
	}
	input.RequestID, input.TemplateKey = "secret-concurrent", "mcp-concurrent"
	var wg sync.WaitGroup
	errorsFound := make(chan error, 6)
	for range 6 {
		wg.Go(func() {
			_, err := reader.CreateTemplate(t.Context(), input)
			errorsFound <- err
		})
	}
	wg.Wait()
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal("identical concurrent keyed requests conflict", err)
		}
	}
}
