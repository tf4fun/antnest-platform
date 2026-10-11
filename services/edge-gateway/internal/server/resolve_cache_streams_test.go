package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentacp"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func TestPerMessageResolveChecksActualAuthorityAndInvocationTiming(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		valid bool
	}{
		{"valid-old-hit", true}, {"old-authority", false}, {"expired-cache", false},
		{"partial-provenance", false}, {"slow-live-rpc", false}, {"slow-hit-invocation", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				principal := administratorPrincipal()
				principal.ActivityIntervalMS = 10
				principal.ResolveStartedAt, principal.ResolveCompletedAt = time.Now().Add(-20*time.Millisecond), time.Now().Add(-19*time.Millisecond)
				principal.ResolveValidUntil, principal.ResolveCacheHit = time.Now().Add(time.Second), true
				service := &streamIdentity{principal: principal}
				switch scenario.name {
				case "old-authority":
					service.principal.ResolveStartedAt = time.Now().Add(-60 * time.Millisecond)
				case "expired-cache":
					service.principal.ResolveValidUntil = time.Now()
				case "partial-provenance":
					service.principal.ResolveCompletedAt = time.Time{}
				case "slow-live-rpc":
					service.principal.ResolveCacheHit = false
					service.principal.ResolveCompletedAt = time.Now()
				case "slow-hit-invocation":
					service.initialDelay = 20 * time.Millisecond
				}
				h := &handler{identity: service, maximumSessionStale: 90 * time.Millisecond, requestTimeout: time.Second}
				err := h.validateStreamIdentity(context.Background(), "token", principal)
				if scenario.valid != (err == nil) {
					t.Fatalf("per-message cached authority valid=%v err=%v", scenario.valid, err)
				}
			})
		})
	}
}

func TestCachedPrincipalAdmitsEverySSEEntryWithoutCookieWrites(t *testing.T) {
	for _, route := range browserSSERoutes {
		t.Run(route.path, func(t *testing.T) {
			service := newStreamIdentity()
			service.principal = cacheStreamPrincipal(service.principal)
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
			request := newBrowserRequest("GET", route.path, nil).WithContext(ctx)
			addSessionCookies(request, "token", testCSRFToken)
			response := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { defer close(done); h.ServeHTTP(response, request) }()
			defer func() { cancel(); <-done }()
			select {
			case <-entered:
			case <-done:
				t.Fatalf("valid cache hit was rejected: status=%d", response.Code)
			case <-time.After(2 * time.Second):
				t.Fatal("valid cache hit did not admit upstream")
			}
			cancel()
			<-done
			if len(response.Result().Cookies()) != 0 {
				t.Fatal("cache-hit stream admission rewrote browser cookies")
			}
		})
	}
}

func TestCachedPrincipalAdmitsBothWebSocketVersionsAndMessages(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			fixture := newRelayFixture(t, version, func(h *handler) {
				service := h.identity.(*relayIdentity)
				service.principal = cacheStreamPrincipal(service.principal)
			})
			fixture.roundTrip(t, `{"jsonrpc":"2.0","id":1,"method":"session/list"}`)
		})
	}
}

func cacheStreamPrincipal(principal identity.Principal) identity.Principal {
	principal.ActivityIntervalMS = 1000
	principal.ResolveStartedAt = time.Now().Add(-2 * time.Second)
	principal.ResolveCompletedAt = principal.ResolveStartedAt.Add(time.Millisecond)
	principal.ResolveValidUntil, principal.ResolveCacheHit = principal.ResolveStartedAt.Add(10*time.Second), true
	return principal
}
