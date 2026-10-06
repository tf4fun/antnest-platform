package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type secretResolverCatalog struct {
	catalogServiceStub
	calls int
}

func (catalog *secretResolverCatalog) ResolveMCPSecrets(context.Context, ports.MCPTemplateSource) (map[string]map[string]string, error) {
	catalog.calls++
	return map[string]map[string]string{"docs": {"API_KEY": "private-bootstrap-canary"}}, nil
}

func TestManagedMCPBootstrapIsOnlyAvailableToAuthenticatedRC(t *testing.T) {
	f := newAuthenticationFixture(t)
	catalog := &secretResolverCatalog{}
	h, err := NewHandler(catalog, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
	if err != nil {
		t.Fatal(err)
	}
	for _, caller := range []string{"admin-console", "agent-acp-service", "edge-gateway", "agent-ui", "runtime-controller", ""} {
		r := httptest.NewRequest(http.MethodPost, "/internal/managed-mcp-secrets/resolve", strings.NewReader(`{"organization_id":"org-1","template_id":"template-1","revision":1}`))
		r.Header.Set("Content-Type", "application/json")
		if caller != "" {
			r.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if caller == "runtime-controller" {
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" || !strings.Contains(w.Body.String(), "private-bootstrap-canary") {
				t.Fatal("RC bootstrap refused")
			}
		} else {
			if w.Code != 401 && w.Code != 403 {
				t.Fatalf("foreign caller accepted: %s %d", caller, w.Code)
			}
			if strings.Contains(w.Body.String(), "private-bootstrap-canary") {
				t.Fatal("bootstrap secret leaked")
			}
		}
	}
	if catalog.calls != 1 {
		t.Fatal("unauthorized request reached bootstrap")
	}
}
