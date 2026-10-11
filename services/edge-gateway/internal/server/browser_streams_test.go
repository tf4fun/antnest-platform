package server

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

var browserSSERoutes = []struct{ path, profile string }{
	{"/api/admin/agents/agent-1/events/watch", "console"},
	{"/api/app/agents/agent-1/state/watch", "workspace"},
	{"/api/app/workspace/v1/agents/agent-1/events", "workspace"},
	{"/api/app/agents/agent-1/acp", "acp"},
	{"/api/app/agents/agent-1/v1/acp", "acp"},
}

type streamIdentity struct {
	identityServiceStub
	mu           sync.Mutex
	principal    identity.Principal
	failure      error
	initialDelay time.Duration
	calls        int
	scopes       [][2]string
}

func (service *streamIdentity) Resolve(ctx context.Context, _ string) (identity.Principal, error) {
	service.mu.Lock()
	service.calls++
	principal, failure, delay := service.principal, service.failure, time.Duration(0)
	if service.calls == 1 {
		delay = service.initialDelay
	}
	profile, agent := identity.ResolutionScope(ctx)
	service.scopes = append(service.scopes, [2]string{profile, agent})
	service.mu.Unlock()
	if delay > 0 {
		timer := time.NewTimer(delay)
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return identity.Principal{}, ctx.Err()
		case <-timer.C:
		}
	}
	return principal, failure
}

func newStreamIdentity() *streamIdentity {
	principal := administratorPrincipal()
	principal.ActivityIntervalMS = 20
	principal.ContextExpiresAt = time.Now().Add(time.Minute)
	return &streamIdentity{principal: principal}
}

func TestBrowserEverySSEEntryRevalidatesWhileUpstreamIsSilent(t *testing.T) {
	for _, route := range browserSSERoutes {
		t.Run(route.path, func(t *testing.T) {
			service := newStreamIdentity()
			entered := make(chan struct{})
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(entered)
				<-r.Context().Done()
				w.Header().Set("Content-Type", "text/event-stream")
			})
			execution := &executionServiceStub{watchState: func(ctx context.Context, _ agentacp.WorkspaceStateEmitter) error {
				close(entered)
				<-ctx.Done()
				return ctx.Err()
			}}
			h := newTestHandlerWithServices(t, service, &agentServiceStub{}, execution, upstream, time.Now(), Config{})
			ctx, cancel := context.WithCancel(context.Background())
			r := newBrowserRequest("GET", route.path, nil).WithContext(ctx)
			addSessionCookies(r, "token", testCSRFToken)
			w := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); h.ServeHTTP(w, r) }()
			defer func() { cancel(); <-done }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("stream did not reach upstream")
			}
			service.mu.Lock()
			service.failure = &identity.RemoteError{Code: "unauthenticated"}
			service.mu.Unlock()
			select {
			case <-done:
			case <-time.After(300 * time.Millisecond):
				t.Fatal("silent stream retained revoked authority")
			}
			if len(w.Result().Cookies()) != 0 {
				t.Fatal("stream rejection rewrote cookies")
			}
			service.mu.Lock()
			defer service.mu.Unlock()
			if service.calls < 2 {
				t.Fatal("silent stream never performed live check")
			}
			for _, scope := range service.scopes {
				if scope != [2]string{route.profile, "agent-1"} {
					t.Fatalf("live check lost route scope: %v", scope)
				}
			}
		})
	}
}

func TestBrowserLateInitialResolutionNeverStartsSSEUpstream(t *testing.T) {
	for _, route := range browserSSERoutes {
		t.Run(route.path, func(t *testing.T) {
			service := newStreamIdentity()
			service.initialDelay = 30 * time.Millisecond
			calls := 0
			execution := &executionServiceStub{watchState: func(context.Context, agentacp.WorkspaceStateEmitter) error {
				calls++
				return errors.New("unexpected upstream")
			}}
			h := newTestHandlerWithServices(t, service, &agentServiceStub{}, execution, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }), time.Now(), Config{})
			r := newBrowserRequest("GET", route.path, nil)
			addSessionCookies(r, "token", testCSRFToken)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 503 || calls != 0 || len(w.Result().Cookies()) != 0 {
				t.Fatalf("late admission status=%d upstream=%d", w.Code, calls)
			}
		})
	}
}

func TestBrowserSilentWebSocketsRevalidateWithoutClientFrames(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			fixture := newRelayFixture(t, version, func(h *handler) {
				service := h.identity.(*relayIdentity)
				service.principal.ActivityIntervalMS = 20
				service.principal.ContextExpiresAt = time.Now().Add(time.Minute)
			})
			fixture.identity.reject(ordinaryPrincipal(), &identity.RemoteError{Code: "unauthenticated"}, false)
			_ = fixture.client.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
			_, _, err := fixture.client.ReadMessage()
			var closed *websocket.CloseError
			if !errors.As(err, &closed) || closed.Code != websocket.ClosePolicyViolation {
				t.Fatalf("silent browser close=%v", err)
			}
			select {
			case <-fixture.closed:
			case <-time.After(time.Second):
				t.Fatal("upstream reader was not joined")
			}
		})
	}
}

func TestBrowserWebSocketKeepsOriginalHandshakeExpiryDespiteFreshContexts(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			fixture := newRelayFixture(t, version, func(h *handler) {
				h.maximumSessionStale = 300 * time.Millisecond
				service := h.identity.(*relayIdentity)
				service.principal.ActivityIntervalMS = 20
				service.principal.ContextExpiresAt = time.Now().Add(250 * time.Millisecond)
			})
			fixture.identity.mu.Lock()
			fixture.identity.principal.ContextExpiresAt = time.Now().Add(time.Hour)
			fixture.identity.mu.Unlock()
			_ = fixture.client.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
			_, _, err := fixture.client.ReadMessage()
			var closed *websocket.CloseError
			if !errors.As(err, &closed) || closed.Code != websocket.ClosePolicyViolation || closed.Text != "caller_context_expired" {
				t.Fatalf("fresh CCT extended the original WebSocket handshake: %v", err)
			}
		})
	}
}
