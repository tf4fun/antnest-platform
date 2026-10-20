package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

var browserSSERoutes = []struct{ path, profile string }{
	{"/api/admin/agents/agent-1/events/watch", "console"},
	{"/api/app/workspace/v1/agents/agent-1/events", "workspace"},
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
			h := newTestHandler(t, service, upstream, time.Now())
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
			h := newTestHandler(t, service, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { calls++ }), time.Now())
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
