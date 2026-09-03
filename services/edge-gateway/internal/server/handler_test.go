package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"soft/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/session"
)

func TestWorkspaceBootstrapReturnsOnlyBrowserSafeAgentFacts(t *testing.T) {
	t.Parallel()

	agents := &agentServiceStub{agents: []agentcontroller.WorkspaceAgent{{
		AgentID: "agent-1", Name: "Research Agent", Availability: "busy",
		AgentAccessSubject: "subject-must-stay-server-side",
	}}}
	handler := newTestHandlerWithAgents(
		t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents,
		http.NotFoundHandler(), time.Now(), Config{},
	)
	request := httptest.NewRequest(http.MethodGet, "/api/app/bootstrap", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d cache=%q body=%s", response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	if strings.Contains(response.Body.String(), "subject-must-stay-server-side") {
		t.Fatalf("Agent access subject leaked to browser: %s", response.Body.String())
	}
	if !strings.Contains(response.Body.String(), `"agent_id":"agent-1"`) ||
		!strings.Contains(response.Body.String(), `"availability":"busy"`) {
		t.Fatalf("bootstrap body=%s", response.Body.String())
	}
	if agents.input.OrganizationID != "org-1" || agents.input.PrincipalID != "user-admin" {
		t.Fatalf("Agent scope = %+v", agents.input)
	}
}

func TestWorkspaceACPRequiresSameOriginAndInjectsServerCredential(t *testing.T) {
	t.Parallel()

	received := make(chan http.Header, 1)
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	acp := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		received <- request.Header.Clone()
		connection, err := upgrader.Upgrade(response, request, nil)
		if err != nil {
			return
		}
		defer func() { _ = connection.Close() }()
		_ = connection.WriteMessage(websocket.TextMessage, []byte("connected"))
	}))
	defer acp.Close()
	static := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/status" {
			response.WriteHeader(http.StatusOK)
			return
		}
		response.WriteHeader(http.StatusOK)
	}))
	defer static.Close()
	sessions, err := session.NewManager(session.Config{})
	if err != nil {
		t.Fatalf("session manager: %v", err)
	}
	agents := &agentServiceStub{agents: []agentcontroller.WorkspaceAgent{{
		AgentID: "agent-1", Name: "Research Agent", Availability: "ready",
		AgentAccessSubject: "subject-authoritative",
	}}}
	handler, err := NewHandler(Config{
		AdminConsoleURL: static.URL, AgentUIURL: static.URL, AgentACPURL: acp.URL,
		IdentityURL:    static.URL,
		RequestTimeout: time.Second, NewRequestID: func() string { return "edge-request" },
	}, Dependencies{
		Identity: &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, Agents: agents,
		Sessions: sessions, HTTPClient: acp.Client(), Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	edge := httptest.NewServer(handler)
	defer edge.Close()
	websocketURL := strings.Replace(edge.URL, "http://", "ws://", 1) + "/api/app/agents/agent-1/acp"
	headers := http.Header{}
	headers.Set("Origin", edge.URL)
	headers.Set("Cookie", session.AccessTokenCookieName+"=token-1; "+session.CSRFCookieName+"=csrf-1")
	headers.Set(HeaderAgentAccessSubject, "forged-subject")
	connection, _, err := websocket.DefaultDialer.Dial(websocketURL, headers)
	if err != nil {
		t.Fatalf("dial workspace ACP: %v", err)
	}
	defer func() { _ = connection.Close() }()
	messageType, message, err := connection.ReadMessage()
	if err != nil || messageType != websocket.TextMessage || string(message) != "connected" {
		t.Fatalf("ACP message=%q type=%d err=%v", message, messageType, err)
	}
	upstreamHeaders := <-received
	if upstreamHeaders.Get(HeaderAgentAccessSubject) != "subject-authoritative" ||
		upstreamHeaders.Get("Cookie") != "" || upstreamHeaders.Get("Authorization") != "" {
		t.Fatalf("ACP upstream headers = %v", upstreamHeaders)
	}

	wrongOrigin := httptest.NewRequest(http.MethodGet, "/api/app/agents/agent-1/acp", nil)
	wrongOrigin.Host = "edge.example.test"
	wrongOrigin.Header.Set("Connection", "Upgrade")
	wrongOrigin.Header.Set("Upgrade", "websocket")
	wrongOrigin.Header.Set("Origin", "https://evil.example.test")
	addSessionCookies(wrongOrigin, "token-1", "csrf-1")
	rejected := httptest.NewRecorder()
	handler.ServeHTTP(rejected, wrongOrigin)
	if rejected.Code != http.StatusForbidden {
		t.Fatalf("cross-origin status=%d body=%s", rejected.Code, rejected.Body.String())
	}
}

func TestWorkspaceApplicationStripsPublicPrefix(t *testing.T) {
	t.Parallel()

	received := ""
	handler := newTestHandler(
		t, &identityServiceStub{}, http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
			received = request.URL.Path
			response.WriteHeader(http.StatusOK)
		}), time.Now(),
	)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/workspace/assets/app.js", nil))
	if response.Code != http.StatusOK || received != "/assets/app.js" {
		t.Fatalf("status=%d upstream path=%q", response.Code, received)
	}
}

func TestLoginCreatesCookieSessionWithoutLeakingIdentityToken(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	identityStub := &identityServiceStub{loginResult: identity.LoginResult{
		TokenID: "token-1", AccessToken: "ant_api_top_secret", ExpiresAt: now.Add(time.Hour),
		Principal: administratorPrincipal(),
	}}
	handler := newTestHandler(t, identityStub, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("login reached Admin Console")
	}), now)

	request := httptest.NewRequest(http.MethodPost, "/api/session/login", strings.NewReader(`{
		"organization_slug":"engineering","email":"admin@example.com","password":"correct password"
	}`))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "ant_api_top_secret") ||
		strings.Contains(response.Body.String(), "token-1") {
		t.Fatalf("identity credential leaked: %s", response.Body.String())
	}
	if identityStub.loginInput.OrganizationSlug != "engineering" ||
		identityStub.loginInput.Email != "admin@example.com" ||
		identityStub.loginInput.Password != "correct password" ||
		identityStub.loginInput.RequestID != "edge-request-1" {
		t.Fatalf("login input=%#v", identityStub.loginInput)
	}
	assertCookie(t, response.Result().Cookies(), session.AccessTokenCookieName, true)
	assertCookie(t, response.Result().Cookies(), session.CSRFCookieName, false)
}

func TestLoginAdmissionRejectsBeforeAnotherIdentityPasswordCheck(t *testing.T) {
	identityStub := &identityServiceStub{}
	handler := newTestHandlerWithConfig(
		t, identityStub, http.NotFoundHandler(), time.Now(),
		Config{LoginWindow: time.Minute, LoginSourceMax: 2, LoginAccountMax: 2},
	)
	for attempt := 1; attempt <= 3; attempt++ {
		request := httptest.NewRequest(
			http.MethodPost, "/api/session/login",
			strings.NewReader(`{"organization_slug":"engineering","email":"admin@example.com","password":"wrong password"}`),
		)
		request.Header.Set("Content-Type", "application/json")
		request.RemoteAddr = "192.0.2.10:1234"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if attempt < 3 && response.Code == http.StatusTooManyRequests {
			t.Fatalf("attempt %d was limited early", attempt)
		}
		if attempt == 3 && (response.Code != http.StatusTooManyRequests ||
			response.Header().Get("Retry-After") == "") {
			t.Fatalf("attempt 3 status=%d headers=%v body=%s",
				response.Code, response.Header(), response.Body.String())
		}
	}
	if identityStub.loginCalls != 2 {
		t.Fatalf("Identity password checks=%d want=2", identityStub.loginCalls)
	}
}

func TestOIDCStartUsesThePublicLoginAdmissionWindow(t *testing.T) {
	identityStub := &identityServiceStub{startOIDCResult: identity.StartOIDCLoginResult{
		AuthorizationURL: "https://id.example.test/authorize", ExpiresAt: time.Now().Add(time.Minute),
	}}
	handler := newTestHandlerWithConfig(
		t, identityStub, http.NotFoundHandler(), time.Now(),
		Config{LoginWindow: time.Minute, LoginSourceMax: 1, LoginAccountMax: 1},
	)
	for attempt := 1; attempt <= 2; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/api/session/oidc/start",
			strings.NewReader(`{"organization_slug":"engineering","provider_name":"workforce"}`))
		request.Header.Set("Content-Type", "application/json")
		request.RemoteAddr = "192.0.2.20:1234"
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if attempt == 1 && response.Code != http.StatusOK {
			t.Fatalf("initial OIDC start status=%d body=%s", response.Code, response.Body.String())
		}
		if attempt == 2 && (response.Code != http.StatusTooManyRequests ||
			response.Header().Get("Retry-After") == "") {
			t.Fatalf("limited OIDC start status=%d headers=%v body=%s",
				response.Code, response.Header(), response.Body.String())
		}
	}
	if identityStub.startOIDCCalls != 1 {
		t.Fatalf("Identity OIDC start calls=%d want=1", identityStub.startOIDCCalls)
	}
}

func TestAdminProxyResolvesPrincipalAndReplacesSpoofedHeaders(t *testing.T) {
	identityStub := &identityServiceStub{resolvePrincipal: administratorPrincipal()}
	received := make(chan *http.Request, 1)
	console := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		received <- request.Clone(request.Context())
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(`{"status":"created"}`))
	})
	handler := newTestHandler(t, identityStub, console, time.Now())

	previousProvider := otel.GetTracerProvider()
	previousPropagator := otel.GetTextMapPropagator()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSampler(sdktrace.AlwaysSample()))
	otel.SetTracerProvider(provider)
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() {
		_ = provider.Shutdown(context.Background())
		otel.SetTracerProvider(previousProvider)
		otel.SetTextMapPropagator(previousPropagator)
	})
	ctx, span := otel.Tracer("edge-test").Start(context.Background(), "request")
	defer span.End()

	request := httptest.NewRequest(http.MethodGet, "/api/admin/agents?limit=20", nil).WithContext(ctx)
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set(HeaderUserID, "forged-user")
	request.Header.Set(HeaderSystemRole, "admin")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated || response.Body.String() != `{"status":"created"}` {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	forwarded := <-received
	if forwarded.URL.Path != "/api/admin/agents" || forwarded.URL.RawQuery != "limit=20" {
		t.Fatalf("forwarded URL=%s", forwarded.URL.String())
	}
	if forwarded.Header.Get(HeaderUserID) != "user-admin" ||
		forwarded.Header.Get(HeaderOrganizationID) != "org-1" ||
		forwarded.Header.Get(HeaderSystemRole) != "admin" {
		t.Fatalf("trusted headers=%v", forwarded.Header)
	}
	if forwarded.Header.Get("traceparent") == "" {
		t.Fatal("trace context was not propagated")
	}
}

func TestAdminProxyRejectsNonAdministratorAndMissingCSRF(t *testing.T) {
	called := 0
	console := http.HandlerFunc(func(http.ResponseWriter, *http.Request) { called++ })

	for _, test := range []struct {
		name      string
		principal identity.Principal
		method    string
		csrf      string
		code      int
	}{
		{name: "ordinary user", principal: ordinaryPrincipal(), method: http.MethodGet, code: http.StatusForbidden},
		{name: "missing csrf", principal: administratorPrincipal(), method: http.MethodPost, code: http.StatusForbidden},
		{name: "wrong csrf", principal: administratorPrincipal(), method: http.MethodPost, csrf: "wrong", code: http.StatusForbidden},
	} {
		t.Run(test.name, func(t *testing.T) {
			identityStub := &identityServiceStub{resolvePrincipal: test.principal}
			handler := newTestHandler(t, identityStub, console, time.Now())
			request := httptest.NewRequest(test.method, "/api/admin/agents", strings.NewReader(`{}`))
			addSessionCookies(request, "token-1", "csrf-1")
			if test.csrf != "" {
				request.Header.Set(session.CSRFHeaderName, test.csrf)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)
			if response.Code != test.code {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
		})
	}
	if called != 0 {
		t.Fatalf("rejected requests reached Admin Console %d times", called)
	}
}

func TestAgentEventWatchHasABoundedAuthenticationLease(t *testing.T) {
	identityStub := &identityServiceStub{resolvePrincipal: administratorPrincipal()}
	upstreamCancelled := make(chan struct{})
	console := http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		<-request.Context().Done()
		close(upstreamCancelled)
	})
	handler := newTestHandlerWithConfig(
		t, identityStub, console, time.Now(), Config{StreamLease: 20 * time.Millisecond},
	)
	request := httptest.NewRequest(http.MethodGet, "/api/admin/agents/agent-1/events/watch", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	response := httptest.NewRecorder()
	started := time.Now()
	handler.ServeHTTP(response, request)

	select {
	case <-upstreamCancelled:
	case <-time.After(time.Second):
		t.Fatal("event watch upstream was not cancelled at the stream lease")
	}
	if elapsed := time.Since(started); elapsed > 500*time.Millisecond {
		t.Fatalf("event watch lease elapsed=%s", elapsed)
	}
}

func TestPublicOIDCLoginDiscoveryAndStartUseIdentityService(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	identityStub := &identityServiceStub{
		loginMethods: []identity.LoginMethod{{Name: "workforce", DisplayName: "Workforce SSO"}},
		startOIDCResult: identity.StartOIDCLoginResult{
			AuthorizationURL: "https://id.example.test/authorize?state=opaque-state",
			ExpiresAt:        now.Add(10 * time.Minute),
		},
	}
	handler := newTestHandler(t, identityStub, http.NotFoundHandler(), now)

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/session/login-methods",
		strings.NewReader(`{"organization_slug":"engineering"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), `"name":"workforce"`) {
		t.Fatalf("discovery status=%d cache=%q body=%s",
			response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	if identityStub.loginMethodsOrganization != "engineering" {
		t.Fatalf("login methods organization=%q", identityStub.loginMethodsOrganization)
	}

	response = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodPost, "/api/session/oidc/start",
		strings.NewReader(`{"organization_slug":"engineering","provider_name":"workforce"}`))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Header().Get("Cache-Control") != "no-store" ||
		!strings.Contains(response.Body.String(), "opaque-state") {
		t.Fatalf("start status=%d cache=%q body=%s",
			response.Code, response.Header().Get("Cache-Control"), response.Body.String())
	}
	if identityStub.startOIDCInput.OrganizationSlug != "engineering" ||
		identityStub.startOIDCInput.ProviderName != "workforce" ||
		identityStub.startOIDCInput.RequestID != "edge-request-1" {
		t.Fatalf("start input=%+v", identityStub.startOIDCInput)
	}
}

func TestOIDCCallbackEstablishesBrowserSessionWithoutDisclosingToken(t *testing.T) {
	now := time.Date(2026, 9, 2, 12, 0, 0, 0, time.UTC)
	identityStub := &identityServiceStub{completeOIDCResult: identity.OIDCCallbackResult{
		Principal: ordinaryPrincipal(), TokenID: "token-1", AccessToken: "ant_api_secret",
		ExpiresAt: now.Add(time.Hour),
	}}
	handler := newTestHandler(t, identityStub, http.NotFoundHandler(), now)
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet,
		"/protocol/oidc/callback?state=opaque-state&code=authorization-code", nil)
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusSeeOther || response.Header().Get("Location") != "/" ||
		response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("status=%d location=%q cache=%q body=%s", response.Code,
			response.Header().Get("Location"), response.Header().Get("Cache-Control"), response.Body.String())
	}
	if strings.Contains(response.Header().Get("Location"), "ant_api_secret") ||
		strings.Contains(response.Body.String(), "ant_api_secret") {
		t.Fatalf("access token leaked through callback response")
	}
	assertCookie(t, response.Result().Cookies(), session.AccessTokenCookieName, true)
	assertCookie(t, response.Result().Cookies(), session.CSRFCookieName, false)
	if identityStub.completeOIDCInput.State != "opaque-state" ||
		identityStub.completeOIDCInput.Code != "authorization-code" {
		t.Fatalf("callback input=%+v", identityStub.completeOIDCInput)
	}
}

func TestOIDCCallbackFailureRedirectsWithOnlyAStableErrorCode(t *testing.T) {
	handler := newTestHandler(t, &identityServiceStub{completeOIDCErr: context.DeadlineExceeded},
		http.NotFoundHandler(), time.Now())
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet,
		"/protocol/oidc/callback?state=secret-state&code=secret-code", nil)
	handler.ServeHTTP(response, request)

	location := response.Header().Get("Location")
	if response.Code != http.StatusSeeOther || location != "/?auth_error=oidc_login_failed" ||
		strings.Contains(location, "secret-state") || strings.Contains(location, "secret-code") {
		t.Fatalf("status=%d location=%q body=%s", response.Code, location, response.Body.String())
	}
	if len(response.Result().Cookies()) != 0 {
		t.Fatalf("failed callback established cookies: %#v", response.Result().Cookies())
	}
}

func TestSCIMProtocolProxyPreservesBearerAndStripsBrowserIdentity(t *testing.T) {
	var received struct {
		method, path, query, authorization, cookie, userID, body string
	}
	upstream := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		received.method = request.Method
		received.path = request.URL.Path
		received.query = request.URL.RawQuery
		received.authorization = request.Header.Get("Authorization")
		received.cookie = request.Header.Get("Cookie")
		received.userID = request.Header.Get(HeaderUserID)
		payload, _ := io.ReadAll(request.Body)
		received.body = string(payload)
		response.Header().Set("Content-Type", "application/scim+json")
		response.WriteHeader(http.StatusCreated)
		_, _ = response.Write([]byte(`{"id":"user-1"}`))
	})
	handler := newTestHandler(t, &identityServiceStub{}, upstream, time.Now())
	request := httptest.NewRequest(http.MethodPost, "/scim/v2/Users?attributes=id",
		strings.NewReader(`{"userName":"person@example.com"}`))
	request.Header.Set("Authorization", "Bearer scim-secret")
	request.Header.Set("Cookie", "antnest_session=browser-secret")
	request.Header.Set(HeaderUserID, "forged-user")
	request.Header.Set("Content-Type", "application/scim+json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusCreated || response.Header().Get("Content-Type") != "application/scim+json" ||
		response.Body.String() != `{"id":"user-1"}` {
		t.Fatalf("status=%d content-type=%q body=%s",
			response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	if received.method != http.MethodPost || received.path != "/scim/v2/Users" ||
		received.query != "attributes=id" || received.authorization != "Bearer scim-secret" ||
		received.cookie != "" || received.userID != "" ||
		received.body != `{"userName":"person@example.com"}` {
		t.Fatalf("upstream request=%+v", received)
	}
}

func TestUnknownOIDCProtocolPathNeverFallsThroughToSPA(t *testing.T) {
	consoleCalls := 0
	handler := newTestHandler(t, &identityServiceStub{}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		consoleCalls++
	}), time.Now())
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/protocol/oidc/unknown", nil))
	if response.Code != http.StatusNotFound ||
		!strings.Contains(response.Header().Get("Content-Type"), "application/json") ||
		!strings.Contains(response.Body.String(), "not_found") {
		t.Fatalf("status=%d content-type=%s body=%s",
			response.Code, response.Header().Get("Content-Type"), response.Body.String())
	}
	if consoleCalls != 0 {
		t.Fatalf("unknown protocol path reached SPA %d times", consoleCalls)
	}
}

func TestLogoutRevokesTokenAndExpiresAllCookies(t *testing.T) {
	identityStub := &identityServiceStub{revokeStatus: identity.RevokeStatusRevoked}
	handler := newTestHandler(t, identityStub, http.NotFoundHandler(), time.Now())
	request := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set(session.CSRFHeaderName, "csrf-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNoContent {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if identityStub.revokedAccessToken != "token-1" {
		t.Fatalf("revoked token=%q", identityStub.revokedAccessToken)
	}
	if len(response.Result().Cookies()) != 2 {
		t.Fatalf("cleared cookies=%d", len(response.Result().Cookies()))
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.MaxAge >= 0 {
			t.Errorf("cookie %s was not expired", cookie.Name)
		}
	}
}

func TestLogoutPreservesCookiesWhenRevocationIsRetryable(t *testing.T) {
	identityStub := &identityServiceStub{revokeErr: context.DeadlineExceeded}
	handler := newTestHandler(t, identityStub, http.NotFoundHandler(), time.Now())
	request := httptest.NewRequest(http.MethodDelete, "/api/session", nil)
	addSessionCookies(request, "token-1", "csrf-1")
	request.Header.Set(session.CSRFHeaderName, "csrf-1")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if len(response.Result().Cookies()) != 0 {
		t.Fatalf("retry credential was cleared: %#v", response.Result().Cookies())
	}
}

func TestStatusRequiresBothDependencies(t *testing.T) {
	identityStub := &identityServiceStub{}
	consoleStatus := http.StatusOK
	console := http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/status" {
			t.Fatalf("status probe path=%s", request.URL.Path)
		}
		response.WriteHeader(consoleStatus)
	})
	handler := newTestHandler(t, identityStub, console, time.Now())

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ready status=%d body=%s", response.Code, response.Body.String())
	}
	identityStub.readyErr = context.DeadlineExceeded
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("identity failure status=%d", response.Code)
	}
	identityStub.readyErr = nil
	consoleStatus = http.StatusServiceUnavailable
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/status", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("console failure status=%d", response.Code)
	}
}

func newTestHandler(t *testing.T, identityService IdentityService, console http.Handler, now time.Time) http.Handler {
	return newTestHandlerWithConfig(t, identityService, console, now, Config{})
}

func newTestHandlerWithConfig(
	t *testing.T,
	identityService IdentityService,
	console http.Handler,
	now time.Time,
	config Config,
) http.Handler {
	return newTestHandlerWithAgents(
		t, identityService, &agentServiceStub{}, console, now, config,
	)
}

func newTestHandlerWithAgents(
	t *testing.T,
	identityService IdentityService,
	agents agentcontroller.Service,
	console http.Handler,
	now time.Time,
	config Config,
) http.Handler {
	t.Helper()
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		recorder := httptest.NewRecorder()
		console.ServeHTTP(recorder, request)
		return recorder.Result(), nil
	})}
	sessions, err := session.NewManager(session.Config{
		Now:     func() time.Time { return now },
		NewCSRF: func() (string, error) { return "csrf-1", nil },
	})
	if err != nil {
		t.Fatalf("session.NewManager: %v", err)
	}
	config.AdminConsoleURL = "http://admin-console.internal"
	config.AgentUIURL = "http://agent-ui.internal"
	config.AgentACPURL = "http://agent-acp.internal"
	config.IdentityURL = "http://identity.internal"
	config.RequestTimeout = time.Second
	config.NewRequestID = func() string { return "edge-request-1" }
	config.Now = func() time.Time { return now }
	handler, err := NewHandler(config, Dependencies{
		Identity: identityService, Agents: agents, Sessions: sessions,
		HTTPClient: httpClient, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

type agentServiceStub struct {
	agents   []agentcontroller.WorkspaceAgent
	input    agentcontroller.ListWorkspaceAgentsInput
	listErr  error
	readyErr error
}

func (stub *agentServiceStub) ListWorkspaceAgents(
	_ context.Context, input agentcontroller.ListWorkspaceAgentsInput,
) ([]agentcontroller.WorkspaceAgent, error) {
	stub.input = input
	return stub.agents, stub.listErr
}

func (stub *agentServiceStub) Ready(context.Context) error { return stub.readyErr }

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func addSessionCookies(request *http.Request, token, csrf string) {
	request.AddCookie(&http.Cookie{Name: session.AccessTokenCookieName, Value: token})
	request.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: csrf})
}

func assertCookie(t *testing.T, cookies []*http.Cookie, name string, httpOnly bool) {
	t.Helper()
	for _, cookie := range cookies {
		if cookie.Name == name {
			if cookie.HttpOnly != httpOnly {
				t.Fatalf("cookie %s HttpOnly=%v want=%v", name, cookie.HttpOnly, httpOnly)
			}
			return
		}
	}
	t.Fatalf("cookie %s missing", name)
}

func administratorPrincipal() identity.Principal {
	return identity.Principal{
		UserID: "user-admin", OrganizationID: "org-1", MembershipID: "membership-1",
		SystemRole: "admin", OrganizationRole: "admin", Active: true,
	}
}

func ordinaryPrincipal() identity.Principal {
	principal := administratorPrincipal()
	principal.SystemRole = "user"
	principal.OrganizationRole = "member"
	return principal
}

type identityServiceStub struct {
	mu                       sync.Mutex
	loginInput               identity.LoginInput
	loginResult              identity.LoginResult
	loginCalls               int
	resolvePrincipal         identity.Principal
	resolveErr               error
	readyErr                 error
	revokedAccessToken       string
	revokeStatus             identity.RevokeStatus
	revokeErr                error
	loginMethodsOrganization string
	loginMethods             []identity.LoginMethod
	loginMethodsErr          error
	startOIDCInput           identity.StartOIDCLoginInput
	startOIDCResult          identity.StartOIDCLoginResult
	startOIDCErr             error
	startOIDCCalls           int
	completeOIDCInput        identity.OIDCCallbackInput
	completeOIDCResult       identity.OIDCCallbackResult
	completeOIDCErr          error
}

func (stub *identityServiceStub) Login(_ context.Context, input identity.LoginInput) (identity.LoginResult, error) {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	stub.loginCalls++
	stub.loginInput = input
	return stub.loginResult, nil
}

func (stub *identityServiceStub) Resolve(context.Context, string) (identity.Principal, error) {
	return stub.resolvePrincipal, stub.resolveErr
}

func (stub *identityServiceStub) RevokeByAccessToken(
	_ context.Context, accessToken string,
) (identity.RevokeStatus, error) {
	stub.revokedAccessToken = accessToken
	return stub.revokeStatus, stub.revokeErr
}

func (stub *identityServiceStub) ListLoginMethods(
	_ context.Context, organizationSlug string,
) ([]identity.LoginMethod, error) {
	stub.loginMethodsOrganization = organizationSlug
	return stub.loginMethods, stub.loginMethodsErr
}

func (stub *identityServiceStub) StartOIDCLogin(
	_ context.Context, input identity.StartOIDCLoginInput,
) (identity.StartOIDCLoginResult, error) {
	stub.startOIDCCalls++
	stub.startOIDCInput = input
	return stub.startOIDCResult, stub.startOIDCErr
}

func (stub *identityServiceStub) CompleteOIDCLogin(
	_ context.Context, input identity.OIDCCallbackInput,
) (identity.OIDCCallbackResult, error) {
	stub.completeOIDCInput = input
	return stub.completeOIDCResult, stub.completeOIDCErr
}

func (stub *identityServiceStub) Ready(context.Context) error { return stub.readyErr }
