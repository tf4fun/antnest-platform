package application

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestManagedMCPSecretCatalogIsWriteOnly(t *testing.T) {
	assertSecretCatalog(t, "managed-secret-canary-123456789")
}

func FuzzManagedMCPTemplateViewsNeverReturnSecretValues(f *testing.F) {
	f.Add("generated-secret-123456789")
	f.Add("quoted-secret-\"-\\-\n-123456789")
	f.Fuzz(func(t *testing.T, secret string) {
		if len(secret) > 512 || !utf8.ValidString(secret) || bytes.ContainsRune([]byte(secret), 0) {
			t.Skip()
		}
		assertSecretCatalog(t, "fuzz-secret-canary:"+secret)
	})
}

func assertSecretCatalog(t *testing.T, secret string) {
	t.Helper()
	store := &catalogStoreStub{modelRevision: mustModelRevision(t, "model-revision-1", "org-1")}
	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{29}, 32))
	if err != nil {
		t.Fatal(err)
	}
	service := NewCatalogService(store, box, fixedClock{now: time.Unix(1, 0).UTC()})
	service.opener = box
	runtime := validRuntimeInput()
	encoded, _ := json.Marshal([]any{map[string]any{"id": "docs", "command": "node", "secret_env": map[string]any{"API_KEY": map[string]any{"value": secret}}}})
	if err := json.Unmarshal(encoded, &runtime.MCPServers); err != nil {
		t.Fatalf("secret write rejected: %v", err)
	}
	created, err := service.CreateTemplate(t.Context(), CreateTemplateInput{RequestID: "request-secret", OrganizationID: "org-1", TemplateKey: "secret", Name: "Secret", ModelProfileID: "model-1", MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime})
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{created, store.templateRecord.Revision.Snapshot()} {
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		quoted, _ := json.Marshal(secret)
		if bytes.Contains(payload, quoted) || bytes.Contains(payload, []byte(`"value"`)) {
			t.Fatal("Template view or stored Runtime leaked a secret")
		}
		if !bytes.Contains(payload, []byte(`"fingerprint":"sha256:`)) {
			t.Fatal("secret descriptor is missing")
		}
	}
	if len(store.templateRecord.MCPSecrets) != 1 || len(store.templateRecord.MCPSecrets[0].Sealed.WrappedDataKey) == 0 {
		t.Fatal("secret was not sealed separately")
	}
	views := []func() (TemplateView, error){
		func() (TemplateView, error) { return service.GetTemplate(t.Context(), "org-1", created.TemplateID) },
		func() (TemplateView, error) {
			return service.GetTemplateRevision(t.Context(), "org-1", created.TemplateID, 1)
		},
	}
	for _, read := range views {
		view, err := read()
		if err != nil {
			t.Fatal(err)
		}
		payload, _ := json.Marshal(view)
		quoted, _ := json.Marshal(secret)
		if bytes.Contains(payload, quoted) {
			t.Fatal("catalog read returned plaintext")
		}
	}
}

type mcpCatalogStore struct {
	catalogStoreStub
	secrets map[ports.MCPSecretLocation]ports.MCPSecretRecord
}

func (store *mcpCatalogStore) PutTemplate(ctx context.Context, record ports.TemplateRecord) (ports.TemplateRecord, error) {
	for _, secret := range record.MCPSecrets {
		store.secrets[secret.Location] = secret
	}
	return store.catalogStoreStub.PutTemplate(ctx, record)
}
func (store *mcpCatalogStore) ReviseTemplate(ctx context.Context, expected int64, record ports.TemplateRecord) (ports.TemplateRecord, error) {
	for _, secret := range record.MCPSecrets {
		store.secrets[secret.Location] = secret
	}
	return store.catalogStoreStub.ReviseTemplate(ctx, expected, record)
}
func (store *mcpCatalogStore) GetMCPSecret(_ context.Context, location ports.MCPSecretLocation) (ports.MCPSecretRecord, error) {
	record, ok := store.secrets[location]
	if !ok {
		return record, ports.ErrNotFound
	}
	return record, nil
}

func TestManagedMCPKeepRebindsAndClearDoesNotChangeHistory(t *testing.T) {
	store := &mcpCatalogStore{secrets: make(map[ports.MCPSecretLocation]ports.MCPSecretRecord)}
	store.modelRevision = mustModelRevision(t, "model-revision-1", "org-1")
	box, _ := credentials.NewSecretBox(bytes.Repeat([]byte{29}, 32))
	service := NewCatalogService(store, box, fixedClock{now: time.Unix(1, 0).UTC()})
	service.opener = box
	runtime := validRuntimeInput()
	value := "synthetic-mcp-secret-canary"
	runtime.MCPServers = []domain.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]domain.MCPSecret{"API_KEY": {Value: &value}}}}
	created, err := service.CreateTemplate(t.Context(), CreateTemplateInput{RequestID: "create-secret", OrganizationID: "org-1", TemplateKey: "secret", Name: "Secret", ModelProfileID: "model-1", MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime})
	if err != nil {
		t.Fatal(err)
	}
	first := store.templateRecord.Revision
	runtime.MCPServers[0].SecretEnv["API_KEY"] = domain.MCPSecret{Keep: true}
	revise := ReviseTemplateInput{RequestID: "keep-secret", OrganizationID: "org-1", TemplateID: created.TemplateID, Name: "Secret", ModelProfileID: "model-1", MaxModelRequests: 8, ContextPolicyVersion: domain.ContextPolicyV1, Runtime: runtime}
	kept, err := service.ReviseTemplate(t.Context(), revise)
	if err != nil {
		t.Fatal(err)
	}
	if kept.Runtime.MCPServers[0].SecretEnv["API_KEY"].Fingerprint != created.Runtime.MCPServers[0].SecretEnv["API_KEY"].Fingerprint {
		t.Fatal("keep changed content identity")
	}
	for location, record := range store.secrets {
		if location.Revision != 1 {
			continue
		}
		for _, mutate := range []func(*ports.MCPSecretLocation){func(l *ports.MCPSecretLocation) { l.OrganizationID = "org-2" }, func(l *ports.MCPSecretLocation) { l.TemplateID = "other" }, func(l *ports.MCPSecretLocation) { l.Revision = 2 }, func(l *ports.MCPSecretLocation) { l.ServerID = "other" }, func(l *ports.MCPSecretLocation) { l.Name = "OTHER" }} {
			changed := location
			mutate(&changed)
			if _, err := box.Open(t.Context(), changed.CredentialIdentity(), record.Sealed); err == nil {
				t.Fatal("AAD location substitution accepted")
			}
		}
	}
	resolved, err := service.ResolveMCPSecrets(t.Context(), ports.MCPTemplateSource{OrganizationID: "org-1", TemplateID: created.TemplateID, Revision: 2})
	if err != nil || resolved["docs"]["API_KEY"] != value {
		t.Fatal("frozen resolution failed", err)
	}
	if _, err := service.ResolveMCPSecrets(t.Context(), ports.MCPTemplateSource{OrganizationID: "org-2", TemplateID: created.TemplateID, Revision: 2}); !errors.Is(err, ports.ErrNotFound) {
		t.Fatal("cross-organization resolution allowed")
	}
	revise.RequestID = "clear-secret"
	revise.Runtime.MCPServers[0].SecretEnv = nil
	cleared, err := service.ReviseTemplate(t.Context(), revise)
	if err != nil || len(cleared.Runtime.MCPServers[0].SecretEnv) != 0 {
		t.Fatal("clear failed", err)
	}
	store.templateRevision = first
	old, err := service.ResolveMCPSecrets(t.Context(), ports.MCPTemplateSource{OrganizationID: "org-1", TemplateID: created.TemplateID, Revision: 1})
	if err != nil || old["docs"]["API_KEY"] != value {
		t.Fatal("clear changed history", err)
	}
}
