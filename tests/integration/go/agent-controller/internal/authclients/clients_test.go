package authclients

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/config"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/egressclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/identityclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/registryclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/runtimeclient"
)

// Production composition uses these concrete clients. A rejecting dependency
// still lets this test inspect the real wire request without claiming that a
// completed producer is a complete cross-service workflow.
func TestConfiguredDependencyClientsSendReceiverSpecificCredentials(t *testing.T) {
	dir := t.TempDir()
	callers := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callers, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	settings := map[string]string{
		"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir, "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers,
		"ANTNEST_AGENT_CONTROLLER_DATABASE_URL":   "postgres://fixture/controller_test",
		"ANTNEST_AGENT_CONTROLLER_ENCRYPTION_KEY": base64.StdEncoding.EncodeToString(make([]byte, 32)),
	}
	var mu sync.Mutex
	calls := map[string]int{}
	tokens := map[string]string{}
	for service, variable := range map[string]string{
		"identity-service": "ANTNEST_IDENTITY_SERVICE_URL", "agent-acp-service": "ANTNEST_AGENT_ACP_CONTROL_URL",
		"runtime-controller": "ANTNEST_RUNTIME_CONTROLLER_URL", "runtime-egress": "ANTNEST_RUNTIME_EGRESS_URL",
		"skill-registry": "ANTNEST_SKILL_REGISTRY_URL",
	} {
		raw := make([]byte, 32)
		if _, err := rand.Read(raw); err != nil {
			t.Fatal(err)
		}
		tokens[service] = base64.RawURLEncoding.EncodeToString(raw)
		if err := os.WriteFile(filepath.Join(dir, service), []byte(tokens[service]), 0600); err != nil {
			t.Fatal(err)
		}
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			mu.Lock()
			defer mu.Unlock()
			if r.Header.Get("Antnest-Service-Authorization") != "Bearer "+tokens[service] {
				t.Error("wrong receiver credential")
			}
			if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
				t.Error("user credential forwarded")
			}
			wantContext := ""
			if service == "skill-registry" {
				wantContext = "verified-cct-from-private-context"
			}
			if r.Header.Get("Antnest-Caller-Context") != wantContext {
				t.Error("incorrect user context forwarding")
			}
			calls[service]++
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(503)
			_, _ = w.Write([]byte(`{"code":"internal_error","message":"fixture rejection","retryable":true}`))
		}))
		t.Cleanup(server.Close)
		settings[variable] = server.URL
	}
	cfg, err := config.Load(func(key string) (string, bool) { value, ok := settings[key]; return value, ok })
	if err != nil {
		t.Fatal(err)
	}
	defer cfg.Authentication.CloseIdleConnections()
	identity, err := identityclient.New(cfg.IdentityServiceURL, time.Second, cfg.Authentication.HTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := runtimeclient.New(cfg.RuntimeControllerURL, time.Second, cfg.Authentication.HTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	egress, err := egressclient.New(cfg.RuntimeEgressURL, time.Second, cfg.Authentication.HTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	acp, err := acpclient.New(cfg.Execution.URL, time.Second, cfg.Authentication.HTTPClient())
	if err != nil {
		t.Fatal(err)
	}
	registry, err := registryclient.New(cfg.SkillRegistryURL, time.Second, cfg.Authentication)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	for range 2 {
		_, _ = identity.ResolveOwnerAuthorization(ctx, "org-1", "user-1")
		_, _ = runtime.ListRuntimes(ctx)
		_, _ = egress.EnsureAgentNetwork(ctx, "agent-1")
		_, _ = acp.ApplyExecutionSnapshot(ctx, ports.ExecutionSnapshot{OrganizationID: "org-1", Revision: 1, Agents: []ports.ExecutionAgent{}, Providers: []ports.ExecutionProvider{}, Models: []ports.ExecutionModel{}})
		_, _ = registry.Resolve(callercontext.WithToken(ctx, "verified-cct-from-private-context"), "org-1", nil)
		mu.Lock()
		for service := range tokens {
			raw := make([]byte, 32)
			if _, err := rand.Read(raw); err != nil {
				t.Fatal(err)
			}
			tokens[service] = base64.RawURLEncoding.EncodeToString(raw)
			if err := os.WriteFile(filepath.Join(dir, service), []byte(tokens[service]), 0600); err != nil {
				t.Fatal(err)
			}
		}
		mu.Unlock()
	}
	mu.Lock()
	defer mu.Unlock()
	for service := range tokens {
		if calls[service] != 2 {
			t.Errorf("%s calls=%d", service, calls[service])
		}
	}
}
