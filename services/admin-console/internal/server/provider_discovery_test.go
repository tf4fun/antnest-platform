package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/providerdiscovery"
)

type modelListerStub struct {
	calls      int
	connection providerdiscovery.Connection
	secret     string
	err        error
}

func (l *modelListerStub) ListModels(_ context.Context, connection providerdiscovery.Connection, secret string) ([]providerdiscovery.Model, error) {
	l.calls++
	l.connection, l.secret = connection, secret
	return []providerdiscovery.Model{{ModelID: "remote", DisplayName: "Remote"}}, l.err
}

func TestProviderDiscoveryUsesCurrentScopedCredentialWithoutWrites(t *testing.T) {
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, `{"connection":{"connection_id":"c1","provider_key":"openrouter","base_url":"https://openrouter.ai/api/v1","enabled":true},"credential":{"method":"api_key","api_key":"synthetic-secret"}}`)
	h := newTestHandler(t, backend).(*handler)
	lister := &modelListerStub{}
	h.modelLister = lister
	response := requestAdmin(t, h, http.MethodGet, "/api/admin/provider-connections/c1/models/discovery", "")
	if response.Code != http.StatusOK || strings.Contains(response.Body.String(), "synthetic-secret") {
		t.Fatalf("discovery response=%s", response.Body.String())
	}
	if len(backend.calls) != 1 || backend.calls[0].Method != http.MethodGet || backend.calls[0].Path != "/internal/provider-connections/c1/access" || backend.calls[0].Query != "organization_id=org-1" {
		t.Fatalf("unscoped discovery: %+v", backend.calls)
	}
	if lister.calls != 1 || lister.secret != "synthetic-secret" || lister.connection.ProviderKey != "openrouter" {
		t.Fatal("did not discover with current access")
	}
	if response.Header().Get("Cache-Control") != "no-store" || strings.Contains(response.Body.String(), "pricing") {
		t.Fatal("cached or invented metadata")
	}
}

func TestDraftDiscoveryDoesNotCreateProviderOrExposeCredential(t *testing.T) {
	backend := newBackendStub()
	h := newTestHandler(t, backend).(*handler)
	lister := &modelListerStub{}
	h.modelLister = lister
	body := `{"provider_key":"deepseek","base_url":"https://api.deepseek.com","credential":{"method":"api_key","api_key":"synthetic-secret"}}`
	response := requestAdmin(t, h, http.MethodPost, "/api/admin/provider-models/discovery", body)
	if response.Code != 200 || len(backend.calls) != 0 || lister.calls != 1 || strings.Contains(response.Body.String(), "synthetic-secret") {
		t.Fatalf("draft response=%s writes=%d", response.Body.String(), len(backend.calls))
	}
	lister.err = errors.New("upstream error with synthetic-secret")
	response = requestAdmin(t, h, http.MethodPost, "/api/admin/provider-models/discovery", body)
	if response.Code != 502 || strings.Contains(response.Body.String(), "synthetic-secret") {
		t.Fatalf("unsafe error: %s", response.Body.String())
	}
}

func TestDiscoveryRejectsInvalidAccessBeforeCallingProvider(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`{"connection":{"connection_id":"other","provider_key":"deepseek","enabled":true},"credential":{"method":"api_key","api_key":"secret"}}`,
		`{"connection":{"connection_id":"c1","provider_key":"deepseek","enabled":false},"credential":{"method":"api_key","api_key":"secret"}}`,
	} {
		backend := newBackendStub()
		backend.enqueue(http.StatusOK, body)
		h := newTestHandler(t, backend).(*handler)
		lister := &modelListerStub{}
		h.modelLister = lister
		response := requestAdmin(t, h, http.MethodGet, "/api/admin/provider-connections/c1/models/discovery", "")
		if response.Code != 502 || lister.calls != 0 {
			t.Fatalf("invalid access accepted: %s", response.Body.String())
		}
	}
}

func TestDiscoveryRequiresAdministratorBeforeReadingCredentials(t *testing.T) {
	for _, route := range []struct{ method, path string }{
		{http.MethodGet, "/api/admin/provider-connections/c1/models/discovery"},
		{http.MethodPost, "/api/admin/provider-models/discovery"},
	} {
		for _, member := range []bool{false, true} {
			backend := newBackendStub()
			h := newTestHandler(t, backend).(*handler)
			lister := &modelListerStub{}
			h.modelLister = lister
			request := httptest.NewRequest(route.method, route.path, nil)
			expected := http.StatusUnauthorized
			if member {
				request.Header.Set(principal.HeaderUserID, "user-1")
				request.Header.Set(principal.HeaderOrganizationID, "org-1")
				request.Header.Set(principal.HeaderMembershipID, "membership-1")
				request.Header.Set(principal.HeaderSystemRole, "user")
				request.Header.Set(principal.HeaderOrganizationRole, "member")
				expected = http.StatusForbidden
			}
			response := httptest.NewRecorder()
			h.ServeHTTP(response, request)
			if response.Code != expected || len(backend.calls) > 0 || lister.calls > 0 {
				t.Fatalf("unexpected authority boundary: status=%d", response.Code)
			}
		}
	}
}
