package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestWorkspaceBridgeRejectsRequestsBeforeForwarding(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		mutate             func(*http.Request)
		status             int
	}{
		{"missing cookie", "POST", "commands", func(r *http.Request) { r.Header.Del("Cookie") }, 401},
		{"command csrf", "POST", "commands", func(r *http.Request) { r.Header.Del(session.CSRFHeaderName) }, 403},
		{"prompt csrf", "POST", "sessions/session-1/prompts", func(r *http.Request) { r.Header.Del(session.CSRFHeaderName) }, 403},
		{"cross origin", "GET", "view", func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, 403},
		{"unsupported delete", "DELETE", "commands", func(*http.Request) {}, 405},
		{"oversized body", "POST", "commands", func(r *http.Request) { r.ContentLength = maximumWorkspaceBodyBytes + 1 }, 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newTestHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("rejected request reached upstream") }), time.Now())
			r := workspaceHTTPRequest(tc.method, "/api/app/workspace/v1/agents/agent-1/"+tc.path)
			tc.mutate(r)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status || len(w.Result().Cookies()) != 0 {
				t.Fatalf("status=%d want=%d cookies=%d body=%s", w.Code, tc.status, len(w.Result().Cookies()), w.Body.String())
			}
			if strings.Contains(tc.name, "csrf") && !strings.Contains(w.Body.String(), `"code":"csrf_failed"`) {
				t.Fatalf("CSRF assertion was masked by another rejection: %s", w.Body.String())
			}
		})
	}
}

func TestWorkspaceBridgeRevalidatesIdentityOnEveryRequest(t *testing.T) {
	issuer := &originIdentity{identityServiceStub: identityServiceStub{resolvePrincipal: ordinaryPrincipal()}}
	calls := 0
	h := newTestHandler(t, issuer, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(202) }), time.Now())
	w := httptest.NewRecorder()
	h.ServeHTTP(w, workspaceHTTPRequest("POST", "/api/app/workspace/v1/agents/agent-1/commands"))
	if w.Code != 202 {
		t.Fatalf("initial request: %d", w.Code)
	}
	issuer.resolvePrincipal.Active = false
	for _, route := range []struct{ method, suffix string }{
		{"POST", "commands"}, {"POST", "sessions/session-1/prompts"}, {"GET", "view"},
	} {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, workspaceHTTPRequest(route.method, "/api/app/workspace/v1/agents/agent-1/"+route.suffix))
		if w.Code != http.StatusUnauthorized || len(w.Result().Cookies()) != 0 {
			t.Fatalf("%s after revocation: %d cookies=%d", route.suffix, w.Code, len(w.Result().Cookies()))
		}
	}
	if calls != 1 || issuer.resolveCalls != 4 {
		t.Fatalf("upstream=%d resolves=%d", calls, issuer.resolveCalls)
	}
}

func TestWorkspaceBridgeSSEFlushesAndDisconnectReleasesCapacity(t *testing.T) {
	const frame = "id: first\nevent: reset\ndata: {}\n\n"
	upstreamDone := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(upstreamDone)
		w.Header().Set("Content-Type", "text/event-stream")
		if _, err := io.WriteString(w, frame); err != nil {
			t.Error(err)
			return
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			t.Error(err)
			return
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	h := newNetworkBridgeTestHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, upstream)
	gatewayDone := make(chan struct{})
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(gatewayDone)
		h.ServeHTTP(w, r)
	}))
	defer edge.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	r := workspaceHTTPRequest("GET", edge.URL+"/api/app/workspace/v1/agents/agent-1/events").WithContext(ctx)
	r.RequestURI = ""
	response, err := edge.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK || response.Header.Get("X-Accel-Buffering") != "no" || len(response.Cookies()) != 0 {
		t.Fatalf("SSE status=%d headers=%v", response.StatusCode, response.Header)
	}
	body := make([]byte, len(frame))
	if _, err := io.ReadFull(response.Body, body); err != nil || string(body) != frame {
		t.Fatalf("frame=%q error=%v", body, err)
	}
	select {
	case <-upstreamDone:
		t.Fatal("upstream ended before browser cancellation")
	default:
	}
	if len(h.bridgeStreams) != 1 {
		t.Fatalf("active Bridge streams=%d", len(h.bridgeStreams))
	}
	cancel()
	for _, done := range []<-chan struct{}{upstreamDone, gatewayDone} {
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("browser disconnect left stream work active")
		}
	}
	if len(h.bridgeStreams) != 0 {
		t.Fatal("browser disconnect leaked Bridge capacity")
	}
}

type capacityIdentity struct{ identityServiceStub }

func (s *capacityIdentity) Resolve(_ context.Context, token string) (identity.Principal, error) {
	p := s.resolvePrincipal
	if token == "second-token" {
		p.UserID = "second-user"
		p.SessionID = "second-session"
	}
	return p, nil
}

// This proves Gateway admission isolation with actual held HTTP streams. The
// Agent UI / Runtime capacity and cancellation outcome are separate acceptance.
func TestWorkspaceBridgeFullReceiveCapacityDoesNotBlockOtherUserCommand(t *testing.T) {
	const frame = "event: reset\ndata: {}\n\n"
	var streams, commands atomic.Int32
	upstreamStopped := make(chan struct{}, 64)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			streams.Add(1)
			defer func() {
				select {
				case upstreamStopped <- struct{}{}:
				default:
					t.Error("unexpected extra upstream stream finished")
				}
			}()
			if r.Header.Get(HeaderPrincipalID) != "user-admin" || r.Header.Get(HeaderAgentID) != "agent-1" {
				t.Error("receive stream lost first user's scope")
			}
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = io.WriteString(w, frame)
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Error(err)
				return
			}
			<-r.Context().Done()
			return
		}
		commands.Add(1)
		if r.Method != http.MethodPost || r.URL.Path != "/api/app/workspace/v1/agents/agent-2/commands" || r.Header.Get(HeaderPrincipalID) != "second-user" || r.Header.Get(HeaderAgentID) != "agent-2" {
			t.Error("command lost second user's scope")
		}
		body, err := io.ReadAll(r.Body)
		if err != nil || string(body) != `{"text":"/stop","sessionId":"session-2","operationId":"operation-2","expectedRunId":"run-2"}` {
			t.Errorf("command body=%q error=%v", body, err)
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer upstream.Close()
	h := newNetworkBridgeTestHandler(t, &capacityIdentity{identityServiceStub{resolvePrincipal: ordinaryPrincipal()}}, upstream)
	gatewayStopped := make(chan struct{}, 65)
	edge := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/events") {
			defer func() {
				select {
				case gatewayStopped <- struct{}{}:
				default:
					t.Error("unexpected extra Gateway stream finished")
				}
			}()
		}
		h.ServeHTTP(w, r)
	}))
	defer edge.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	var responses []*http.Response
	defer func() {
		cancel()
		for _, response := range responses {
			_ = response.Body.Close()
		}
	}()
	for i := 0; i < 64; i++ {
		r, _ := http.NewRequestWithContext(ctx, http.MethodGet, edge.URL+"/api/app/workspace/v1/agents/agent-1/events", nil)
		addSessionCookies(r, "token-1", testCSRFToken)
		response, err := edge.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		responses = append(responses, response)
		body := make([]byte, len(frame))
		if response.StatusCode != http.StatusOK {
			t.Fatalf("stream %d status=%d", i, response.StatusCode)
		}
		if _, err := io.ReadFull(response.Body, body); err != nil || string(body) != frame {
			t.Fatalf("stream %d frame=%q error=%v", i, body, err)
		}
	}
	if len(h.bridgeStreams) != 64 || streams.Load() != 64 {
		t.Fatal("test did not hold 64 actual upstream streams")
	}
	overflow, _ := http.NewRequestWithContext(ctx, http.MethodGet, edge.URL+"/api/app/workspace/v1/agents/agent-1/events", nil)
	addSessionCookies(overflow, "token-1", testCSRFToken)
	response, err := edge.Client().Do(overflow)
	if err != nil {
		t.Fatal(err)
	}
	responses = append(responses, response)
	if response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("overflow status=%d; a full Gateway must reject before opening upstream", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 4096))
	if err != nil || !strings.Contains(string(body), `"code":"workspace_unavailable"`) || streams.Load() != 64 {
		t.Fatalf("overflow=%d %s streams=%d", response.StatusCode, body, streams.Load())
	}
	csrf, err := h.sessions.Establish(httptest.NewRecorder(), "second-token", "second-session", time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	command, _ := http.NewRequestWithContext(ctx, http.MethodPost, edge.URL+"/api/app/workspace/v1/agents/agent-2/commands", strings.NewReader(`{"text":"/stop","sessionId":"session-2","operationId":"operation-2","expectedRunId":"run-2"}`))
	addSessionCookies(command, "second-token", csrf)
	command.Header.Set("Origin", edge.URL)
	command.Header.Set(session.CSRFHeaderName, csrf)
	command.Header.Set("Content-Type", "application/json")
	response, err = edge.Client().Do(command)
	if err != nil {
		t.Fatal(err)
	}
	responses = append(responses, response)
	_, _ = io.Copy(io.Discard, response.Body)
	if response.StatusCode != http.StatusAccepted || commands.Load() != 1 || len(h.bridgeStreams) != 64 {
		t.Fatalf("command status=%d calls=%d active streams=%d", response.StatusCode, commands.Load(), len(h.bridgeStreams))
	}
	cancel()
	for i := 0; i < 64; i++ {
		select {
		case <-upstreamStopped:
		case <-time.After(time.Second):
			t.Fatal("upstream stream did not join")
		}
	}
	for i := 0; i < 65; i++ {
		select {
		case <-gatewayStopped:
		case <-time.After(time.Second):
			t.Fatal("gateway stream did not join")
		}
	}
	if len(h.bridgeStreams) != 0 {
		t.Fatal("receive capacity leaked after cancellation")
	}
}

func workspaceHTTPRequest(method, path string) *http.Request {
	r := newBrowserRequest(method, path, strings.NewReader(`{"opaque":"payload"}`))
	addSessionCookies(r, "token-1", testCSRFToken)
	r.Header.Set(session.CSRFHeaderName, testCSRFToken)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream")
	r.Header.Set(HeaderAgentAccessSubject, "forged")
	r.Header.Set(HeaderUserID, "forged-user")
	r.Header.Set("Authorization", "Bearer forged")
	return r
}
