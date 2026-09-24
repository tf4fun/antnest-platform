package server

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"log/slog"
	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/session"
)

type bridgeLeaseIdentity struct {
	IdentityService
	active   atomic.Bool
	resolves atomic.Int32
}

func TestBridgeWorkspaceDocumentForwardsVerifiedIdentityAndKeepsAssetPublic(t *testing.T) {
	var seen []*http.Request
	handler := newTestHandlerWithConfig(t,
		&identityServiceStub{resolvePrincipal: ordinaryPrincipal()},
		http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			seen = append(seen, request.Clone(request.Context()))
			if strings.HasPrefix(request.URL.Path, "/workspace/assets/") {
				response.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			response.WriteHeader(http.StatusOK)
		}), time.Now(), Config{})
	document := httptest.NewRequest(http.MethodGet, "/workspace/?agent=agent-1", nil)
	addSessionCookies(document, "token-1", "csrf-1")
	document.Header.Set(HeaderPrincipalID, "forged-user")
	document.Header.Set("Authorization", "Bearer forged")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, document)
	if response.Code != http.StatusOK || len(seen) != 1 ||
		response.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("document status=%d requests=%d", response.Code, len(seen))
	}
	upstream := seen[0]
	if upstream.URL.Host != "agent-ui.internal" || upstream.URL.Path != "/workspace/" ||
		upstream.URL.RawQuery != "agent=agent-1" || upstream.Header.Get(HeaderPrincipalID) != "user-admin" ||
		upstream.Header.Get(HeaderOrganizationID) != "org-1" || upstream.Header.Get(HeaderAdministrator) != "false" ||
		upstream.Header.Get("Cookie") != "" || upstream.Header.Get("Authorization") != "" {
		t.Fatalf("document upstream URL=%s headers=%v", upstream.URL, upstream.Header)
	}
	asset := httptest.NewRequest(http.MethodGet, "/workspace/assets/entry-client-123.js", nil)
	asset.Header.Set(HeaderPrincipalID, "forged-user")
	assetResponse := httptest.NewRecorder()
	handler.ServeHTTP(assetResponse, asset)
	if assetResponse.Code != http.StatusOK || len(seen) != 2 ||
		seen[1].URL.Host != "agent-ui.internal" ||
		seen[1].URL.Path != "/workspace/assets/entry-client-123.js" ||
		seen[1].Header.Get(HeaderPrincipalID) != "" ||
		assetResponse.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" {
		t.Fatalf("asset status=%d upstream=%v headers=%v", assetResponse.Code, seen[1], assetResponse.Header())
	}
}

func (value *bridgeLeaseIdentity) Resolve(context.Context, string) (identity.Principal, error) {
	value.resolves.Add(1)
	principal := ordinaryPrincipal()
	principal.Active = value.active.Load()
	return principal, nil
}

func TestWorkspaceBridgeEventsFlushAndRevalidateBrowserSession(t *testing.T) {
	upstreamRequest := make(chan *http.Request, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		upstreamRequest <- request.Clone(request.Context())
		response.Header().Set("Content-Type", "text/event-stream")
		response.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprint(response, "id: next\nevent: reset\ndata: {}\n\n")
		response.(http.Flusher).Flush()
		<-request.Context().Done()
	}))
	defer upstream.Close()
	identityStub := &bridgeLeaseIdentity{IdentityService: &identityServiceStub{}}
	identityStub.active.Store(true)
	sessions, err := session.NewManager(session.Config{})
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(Config{
		AdminConsoleURL: upstream.URL, AgentUIURL: upstream.URL, AgentACPURL: upstream.URL,
		IdentityURL: upstream.URL, StreamLease: time.Second,
		RequestTimeout: time.Second,
	}, Dependencies{
		Identity: identityStub, Agents: &agentServiceStub{}, Execution: &executionServiceStub{},
		Sessions: sessions, HTTPClient: upstream.Client(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	edge := httptest.NewServer(handler)
	defer edge.Close()
	request, err := http.NewRequest(http.MethodGet,
		edge.URL+"/api/app/workspace/v1/agents/agent-1/events?cursor=initial", nil)
	if err != nil {
		t.Fatal(err)
	}
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set("Last-Event-ID", "resume-1")
	response, err := edge.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("X-Accel-Buffering") != "no" {
		t.Fatalf("SSE response status=%d headers=%v", response.StatusCode, response.Header)
	}
	seen := <-upstreamRequest
	if seen.Header.Get("Last-Event-ID") != "resume-1" || seen.URL.RawQuery != "cursor=initial" ||
		seen.Header.Get(HeaderPrincipalID) != "user-admin" || seen.Header.Get("Cookie") != "" {
		t.Fatalf("SSE upstream headers=%v URL=%s", seen.Header, seen.URL)
	}
	reader := bufio.NewReader(response.Body)
	first, err := reader.ReadString('\n')
	if err != nil || first != "id: next\n" {
		t.Fatalf("first frame=%q err=%v", first, err)
	}
	identityStub.active.Store(false)
	closed := make(chan error, 1)
	go func() { _, err := io.Copy(io.Discard, reader); closed <- err }()
	select {
	case <-closed:
		if identityStub.resolves.Load() < 2 {
			t.Fatal("SSE identity was not revalidated")
		}
	case <-time.After(700 * time.Millisecond):
		t.Fatal("revoked SSE observer remained connected")
	}
}

func TestWorkspaceBridgeAPIAuthenticatesAndReplacesBrowserIdentity(t *testing.T) {
	var upstream []*http.Request
	var bodies []string
	handler := newTestHandlerWithConfig(t,
		&identityServiceStub{resolvePrincipal: ordinaryPrincipal()},
		http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			upstream = append(upstream, request.Clone(request.Context()))
			var body []byte
			if request.Body != nil {
				body, _ = io.ReadAll(request.Body)
			}
			bodies = append(bodies, string(body))
			response.Header().Set("Set-Cookie", "upstream=secret")
			response.Header().Set("Content-Type", "application/json")
			response.WriteHeader(http.StatusOK)
			_, _ = response.Write([]byte(`{"agentId":"agent-1"}`))
		}), time.Now(), Config{},
	)
	path := "/api/app/workspace/v1/agents/agent-1/view?sessionId=session-1"
	request := httptest.NewRequest(http.MethodGet, path, nil)
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set("Authorization", "Bearer forged")
	request.Header.Set(HeaderPrincipalID, "forged")
	request.Header.Set(HeaderAgentID, "agent-2")
	request.Header.Set("Accept", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || len(upstream) != 1 {
		t.Fatalf("status=%d upstream=%d body=%s", response.Code, len(upstream), response.Body.String())
	}
	forwarded := upstream[0]
	if forwarded.URL.Path != "/api/app/workspace/v1/agents/agent-1/view" || forwarded.URL.RawQuery != "sessionId=session-1" || forwarded.URL.Host != "agent-ui.internal" {
		t.Fatalf("upstream URL=%s", forwarded.URL.String())
	}
	for name, expected := range map[string]string{
		HeaderOrganizationID: "org-1", HeaderPrincipalID: "user-admin",
		HeaderUserID: "user-admin", HeaderMembershipID: "membership-1",
		HeaderAgentID: "agent-1",
	} {
		if values := forwarded.Header.Values(name); len(values) != 1 || values[0] != expected {
			t.Errorf("%s=%v want %q", name, values, expected)
		}
	}
	if forwarded.Header.Get("Cookie") != "" || forwarded.Header.Get("Authorization") != "" ||
		response.Header().Get("Set-Cookie") != "" || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("unsafe proxy headers: upstream=%v response=%v", forwarded.Header, response.Header())
	}

	unauthenticated := httptest.NewRecorder()
	handler.ServeHTTP(unauthenticated, httptest.NewRequest(http.MethodGet, path, nil))
	if unauthenticated.Code != http.StatusUnauthorized || len(upstream) != 1 {
		t.Fatalf("unauthenticated status=%d upstream=%d", unauthenticated.Code, len(upstream))
	}
	badCursor := httptest.NewRequest(http.MethodGet,
		"/api/app/workspace/v1/agents/agent-1/events", nil)
	addSessionCookies(badCursor, "token-1", "csrf-1")
	badCursor.Header.Add("Last-Event-ID", "first")
	badCursor.Header.Add("Last-Event-ID", "second")
	badCursorResponse := httptest.NewRecorder()
	handler.ServeHTTP(badCursorResponse, badCursor)
	if badCursorResponse.Code != http.StatusUnprocessableEntity || len(upstream) != 1 {
		t.Fatalf("duplicate cursor status=%d upstream=%d", badCursorResponse.Code, len(upstream))
	}

	for _, bad := range []struct{ name, origin, csrf string }{
		{"foreign origin", "https://evil.example.test", "csrf-1"},
		{"missing CSRF", "http://example.com", ""},
	} {
		t.Run(bad.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts", strings.NewReader(`{}`))
			request.Header.Set("Origin", bad.origin)
			request.Header.Set(session.CSRFHeaderName, bad.csrf)
			addSessionCookies(request, "token-1", "csrf-1")
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != http.StatusForbidden || len(upstream) != 1 {
				t.Fatalf("status=%d upstream=%d", response.Code, len(upstream))
			}
		})
	}
	valid := httptest.NewRequest(http.MethodPost, "/api/app/workspace/v1/agents/agent-1/sessions/session-1/prompts", strings.NewReader(`{"intentId":"intent-1"}`))
	valid.Header.Set("Origin", "http://example.com")
	valid.Header.Set(session.CSRFHeaderName, "csrf-1")
	valid.Header.Set("Content-Type", "application/json")
	addSessionCookies(valid, "token-1", "csrf-1")
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, valid)
	if response.Code != http.StatusOK || len(upstream) != 2 {
		t.Fatalf("valid POST status=%d upstream=%d body=%s", response.Code, len(upstream), response.Body.String())
	}
	if bodies[1] != `{"intentId":"intent-1"}` {
		t.Fatalf("forwarded body=%q", bodies[1])
	}
}

func TestWorkspaceBridgeBootstrapInjectsVerifiedAdministratorWithoutAgentScope(t *testing.T) {
	var forwarded http.Header
	handler := newTestHandlerWithConfig(t,
		&identityServiceStub{resolvePrincipal: administratorPrincipal()},
		http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			forwarded = request.Header.Clone()
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"agents":[]}`))
		}), time.Now(), Config{},
	)
	request := httptest.NewRequest(http.MethodGet, "/api/app/workspace/v1/bootstrap", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set("X-Antnest-Administrator", "false")
	request.Header.Set(HeaderAgentID, "forged-agent")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || forwarded == nil {
		t.Fatalf("status=%d forwarded=%v body=%s", response.Code, forwarded, response.Body.String())
	}
	if forwarded.Get("X-Antnest-Administrator") != "true" || forwarded.Get(HeaderAgentID) != "" ||
		forwarded.Get(HeaderOrganizationID) != "org-1" || forwarded.Get(HeaderPrincipalID) != "user-admin" {
		t.Fatalf("bootstrap identity headers=%v", forwarded)
	}
}

func TestWorkspaceBridgeBootstrapRejectsForgedAdministratorForOrdinaryPrincipal(t *testing.T) {
	var forwarded http.Header
	handler := newTestHandlerWithConfig(t,
		&identityServiceStub{resolvePrincipal: ordinaryPrincipal()},
		http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			forwarded = request.Header.Clone()
			response.WriteHeader(http.StatusOK)
		}), time.Now(), Config{},
	)
	request := httptest.NewRequest(http.MethodGet, "/api/app/workspace/v1/bootstrap", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set(HeaderAdministrator, "true")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || forwarded.Get(HeaderAdministrator) != "false" {
		t.Fatalf("status=%d administrator=%q", response.Code, forwarded.Get(HeaderAdministrator))
	}
}

func TestWorkspaceDocumentRequiresSessionAndPreservesSafeDeepLink(t *testing.T) {
	var forwarded []string
	handler := newTestHandlerWithConfig(t,
		&identityServiceStub{resolvePrincipal: ordinaryPrincipal()},
		http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			forwarded = append(forwarded, request.URL.Path+"|"+request.Header.Get("Cookie"))
			response.WriteHeader(http.StatusOK)
		}), time.Now(), Config{},
	)
	path := "/workspace/?agent=agent-1&session=session-2"
	visitor := httptest.NewRecorder()
	handler.ServeHTTP(visitor, httptest.NewRequest(http.MethodGet, path, nil))
	if visitor.Code != http.StatusSeeOther ||
		visitor.Header().Get("Location") != "/?return_to=%2Fworkspace%2F%3Fagent%3Dagent-1%26session%3Dsession-2" ||
		len(forwarded) != 0 {
		t.Fatalf("visitor status=%d location=%q forwarded=%v", visitor.Code, visitor.Header().Get("Location"), forwarded)
	}
	request := httptest.NewRequest(http.MethodGet, path, nil)
	addSessionCookies(request, "token-1", "csrf-1")
	member := httptest.NewRecorder()
	handler.ServeHTTP(member, request)
	if member.Code != http.StatusOK || member.Header().Get("Cache-Control") != "private, no-store" ||
		len(forwarded) != 1 || forwarded[0] != "/workspace/|" {
		t.Fatalf("member status=%d cache=%q forwarded=%v", member.Code, member.Header().Get("Cache-Control"), forwarded)
	}
	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/workspace/assets/app.js", nil))
	if asset.Code != http.StatusOK || len(forwarded) != 2 || forwarded[1] != "/workspace/assets/app.js|" {
		t.Fatalf("asset status=%d forwarded=%v", asset.Code, forwarded)
	}
	unsafe := httptest.NewRecorder()
	handler.ServeHTTP(unsafe, httptest.NewRequest(http.MethodGet,
		"/workspace/?agent=agent-1&return_to=https://evil.example", nil))
	if unsafe.Header().Get("Location") != "/?return_to=%2Fworkspace%2F" {
		t.Fatalf("unsafe redirect=%q", unsafe.Header().Get("Location"))
	}
	control := httptest.NewRecorder()
	handler.ServeHTTP(control, httptest.NewRequest(http.MethodGet,
		"/workspace/?agent=agent-1%01", nil))
	if control.Header().Get("Location") != "/?return_to=%2Fworkspace%2F" {
		t.Fatalf("control character redirect=%q", control.Header().Get("Location"))
	}
}
