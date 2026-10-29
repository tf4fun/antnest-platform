package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type executionCredentialResolverCatalog struct {
	catalogServiceStub
	calls  int
	input  ports.ExecutionCredentialRequest
	result ports.ResolvedExecutionCredential
	err    error
}

func (catalog *executionCredentialResolverCatalog) ResolveExecutionCredential(_ context.Context, input ports.ExecutionCredentialRequest) (ports.ResolvedExecutionCredential, error) {
	catalog.calls++
	catalog.input = input
	if catalog.err != nil {
		return ports.ResolvedExecutionCredential{}, catalog.err
	}
	return catalog.result, nil
}

func newCredentialResolveBoundary(t *testing.T, catalog CatalogService) (*businessFixture, *executionCredentialResolverCatalog) {
	t.Helper()
	f := newAuthenticationFixture(t)
	resolver, _ := catalog.(*executionCredentialResolverCatalog)
	handler, err := NewHandler(catalog, &lifecycleServiceStub{}, &agentConfigurationServiceStub{}, &agentQueryServiceStub{}, &agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil }, f.security)
	if err != nil {
		t.Fatal(err)
	}
	f.raw = handler
	return f, resolver
}

func credentialResolveRequest(f *businessFixture, caller, path, body string, cct bool) (*httptest.ResponseRecorder, *http.Request) {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if caller != "" {
		r.Header.Set(serviceauth.Header, "Bearer "+f.tokens[caller])
	}
	if cct {
		r.Header.Set("X-Antnest-Caller-Context", "forged-user-context")
	}
	w := httptest.NewRecorder()
	return w, r
}

func TestExecutionCredentialResolveIsACPSelfServiceOnly(t *testing.T) {
	catalog := &executionCredentialResolverCatalog{result: ports.ResolvedExecutionCredential{
		OrganizationID: "org-1", ConnectionID: "provider-1", CredentialVersion: "credential-current", Method: "api_key", Secret: "resolve-canary-secret"}}
	f, resolver := newCredentialResolveBoundary(t, catalog)
	body := `{"organization_id":"org-1","connection_id":"provider-1","credential_version":"credential-current"}`
	cctIndex := 0
	for _, caller := range []string{"agent-acp-service", "agent-acp-service", "admin-console", "agent-ui", "runtime-controller", "edge-gateway", ""} {
		w, r := credentialResolveRequest(f, caller, "/internal/execution-credentials/resolve", body, cctIndex < 1)
		cctIndex++
		f.raw.ServeHTTP(w, r)
		if caller == "agent-acp-service" {
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("ACP resolve refused: %d", w.Code)
			}
			if !strings.Contains(w.Body.String(), "resolve-canary-secret") || !strings.Contains(w.Body.String(), `"method":"api_key"`) {
				t.Fatalf("resolve response missing contract payload: %s", w.Body.String())
			}
			if resolver.input != (ports.ExecutionCredentialRequest{OrganizationID: "org-1", ConnectionID: "provider-1", CredentialVersion: "credential-current"}) {
				t.Fatalf("request identity mutated: %+v", resolver.input)
			}
		} else {
			if w.Code != 401 && w.Code != 403 {
				t.Fatalf("foreign caller accepted resolve: %s %d", caller, w.Code)
			}
			if strings.Contains(w.Body.String(), "resolve-canary-secret") {
				t.Fatal("resolve secret leaked to foreign caller")
			}
		}
	}
	if resolver.calls != 2 {
		t.Fatalf("unauthorized requests reached resolver: %d", resolver.calls)
	}
}

func TestExecutionCredentialResolveRejectsMalformedAndQueryBodies(t *testing.T) {
	catalog := &executionCredentialResolverCatalog{result: ports.ResolvedExecutionCredential{}}
	f, resolver := newCredentialResolveBoundary(t, catalog)
	for _, scenario := range []struct{ path, body string }{
		{"/internal/execution-credentials/resolve?organization_id=org-1", `{"organization_id":"org-1"}`},
		{"/internal/execution-credentials/resolve", `{"organization_id":"org-1",}`},
		{"/internal/execution-credentials/resolve", `{"organization_id":"org-1","organization_id":"other"}`},
		{"/internal/execution-credentials/resolve", `{"organization_id":"org-1","connection_id":"provider-1","credential_version":"v","extra":1}`},
		{"/internal/execution-credentials/resolve", `\xed\xa0\x80`},
	} {
		w, r := credentialResolveRequest(f, "agent-acp-service", scenario.path, scenario.body, false)
		f.raw.ServeHTTP(w, r)
		if w.Code != 400 {
			t.Fatalf("malformed input reached resolver: %s %d", scenario.path, w.Code)
		}
	}
	if resolver.calls != 0 {
		t.Fatal("rejected request reached resolver")
	}
}

func TestExecutionCredentialResolveMapsServiceFailures(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"invalid", application.ErrInvalidInput, 400, "invalid_request"},
		{"missing", ports.ErrNotFound, 404, "not_found"},
		{"conflict", ports.ErrConcurrentChange, 409, "configuration_conflict"},
		{"dependency", application.ErrDependencyUnavailable, 503, "dependency_unavailable"},
		{"opaque", errors.New("resolver sk-canary"), 503, "dependency_unavailable"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			catalog := &executionCredentialResolverCatalog{err: scenario.err}
			f, _ := newCredentialResolveBoundary(t, catalog)
			w, r := credentialResolveRequest(f, "agent-acp-service", "/internal/execution-credentials/resolve", `{"organization_id":"org-1","connection_id":"provider-1","credential_version":"v"}`, false)
			f.raw.ServeHTTP(w, r)
			if w.Code != scenario.status || !strings.Contains(w.Body.String(), `"code":"`+scenario.code+`"`) {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
			if strings.Contains(w.Body.String(), "sk-canary") {
				t.Fatal("resolver failure leaked secret material")
			}
		})
	}
}

type interfaceOnlyCatalogStub struct{ CatalogService }

func TestExecutionCredentialResolveWithoutResolverIsUnavailable(t *testing.T) {
	f, _ := newCredentialResolveBoundary(t, &interfaceOnlyCatalogStub{})
	w, r := credentialResolveRequest(f, "agent-acp-service", "/internal/execution-credentials/resolve", `{"organization_id":"org-1","connection_id":"provider-1","credential_version":"v"}`, false)
	f.raw.ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("missing resolver status=%d", w.Code)
	}
}
