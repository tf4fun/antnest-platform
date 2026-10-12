package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
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
		{"partial-provenance", false}, {"slow-live-rpc", false}, {"slow-hit-invocation", false}, {"cache-expired-during-delivery", false},
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
				case "cache-expired-during-delivery":
					service.principal.ResolveValidUntil = time.Now().Add(time.Millisecond)
					service.initialDelay = 2 * time.Millisecond
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

func TestWorkspaceSSEPeriodicCacheDeliveryExpiry(t *testing.T) {
	for _, scenario := range []string{"fresh-recheck", "expired-recheck", "blocked-recheck"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				started := time.Now()
				original := ordinaryPrincipal()
				original.ActivityIntervalMS = 30_000
				original.ExpiresAt, original.IdleExpiresAt = started.Add(time.Hour), started.Add(time.Minute)
				original.ContextExpiresAt = started.Add(time.Hour)
				calls := 0
				var deadlines []time.Time
				service := &browserAdmissionIdentity{}
				service.resolve = func(ctx context.Context) identity.Principal {
					calls++
					if calls == 1 {
						time.Sleep(time.Millisecond)
						original.ResolveStartedAt, original.ResolveCompletedAt = time.Now(), time.Now()
						original.ResolveValidUntil = time.Now().Add(10 * time.Second)
						return original
					}
					current := original
					if calls == 2 || calls == 3 {
						deadline, ok := ctx.Deadline()
						if !ok {
							t.Error("periodic resolver lost its deadline")
						}
						deadlines = append(deadlines, deadline)
					}
					if calls == 2 {
						if !current.ResolveValidUntil.After(time.Now()) {
							t.Error("fixture lookup was already expired")
						}
						current.ResolveCacheHit = true
						time.Sleep(2 * time.Millisecond)
						return current
					}
					if calls == 3 && scenario != "fresh-recheck" {
						if scenario == "blocked-recheck" {
							<-ctx.Done()
						}
						current.ResolveCacheHit = true
						return current
					}
					current.ResolveStartedAt, current.ResolveCompletedAt = time.Now(), time.Now()
					current.ResolveValidUntil = time.Now().Add(10 * time.Second)
					return current
				}
				second := make(chan struct{})
				execution := &executionServiceStub{watchState: func(ctx context.Context, emit agentacp.WorkspaceStateEmitter) error {
					if err := emit(readyState()); err != nil {
						return err
					}
					select {
					case <-ctx.Done():
						return ctx.Err()
					case <-second:
					}
					if err := emit(readyState()); err != nil {
						return err
					}
					<-ctx.Done()
					return ctx.Err()
				}}
				h := newTestHandlerWithServices(t, service, &agentServiceStub{}, execution, http.NotFoundHandler(), started, Config{}).(*handler)
				h.requestTimeout, h.maximumSessionStale = 15*time.Second, 30*time.Second
				h.now = time.Now
				ctx, cancel := context.WithCancel(context.Background())
				response := httptest.NewRecorder()
				done := make(chan struct{})
				go func() { defer close(done); h.ServeHTTP(response, stateRequest("/watch").WithContext(ctx)) }()
				defer func() { cancel(); <-done }()
				time.Sleep(10*time.Second + 3*time.Millisecond)
				synctest.Wait()
				if calls != 3 {
					t.Fatalf("periodic delivery did not recheck exactly once: calls=%d", calls)
				}
				if len(deadlines) != 2 || !deadlines[0].Equal(started.Add(20*time.Second)) || !deadlines[1].Equal(deadlines[0]) {
					t.Fatalf("periodic retry reset deadline: %v", deadlines)
				}
				wantFrames := 1
				switch scenario {
				case "fresh-recheck":
					select {
					case <-done:
						t.Fatal("healthy SSE closed at TTL delivery expiry")
					default:
					}
					close(second)
					synctest.Wait()
					if calls != 4 {
						t.Fatalf("second frame did not keep its own admission: calls=%d", calls)
					}
					wantFrames = 2
					cancel()
				case "blocked-recheck":
					time.Sleep(time.Until(started.Add(20 * time.Second)))
				}
				if scenario != "fresh-recheck" {
					synctest.Wait()
					select {
					case <-done:
					default:
						t.Fatal("failed periodic recheck did not close at its original rejection/deadline checkpoint")
					}
				}
				<-done
				if response.Code != http.StatusOK || strings.Count(response.Body.String(), "event: workspace_state\n") != wantFrames || len(response.Result().Cookies()) != 0 || len(h.stateConnections) != 0 {
					t.Fatalf("SSE admission/cleanup changed: status=%d frames=%d capacity=%d", response.Code, strings.Count(response.Body.String(), "event: workspace_state\n"), len(h.stateConnections))
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
