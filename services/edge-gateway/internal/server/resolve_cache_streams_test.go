package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

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
				producerDone := make(chan struct{})
				cancelHookDone := make(chan struct{})
				transportStarted := false
				h := newTestHandler(t, service, http.NotFoundHandler(), started).(*handler)
				h.workspaceBridgeProxy.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
					transportStarted = true
					reader, writer := io.Pipe()
					go func() {
						defer close(cancelHookDone)
						<-request.Context().Done()
						_ = writer.CloseWithError(request.Context().Err())
					}()
					go func() {
						defer close(producerDone)
						defer func() { _ = writer.Close() }()
						for frame := range 2 {
							if frame > 0 {
								select {
								case <-request.Context().Done():
									return
								case <-second:
								}
							}
							if _, err := io.WriteString(writer, "event: view\ndata: {\"agentId\":\"agent-1\"}\n\n"); err != nil {
								return
							}
						}
						<-request.Context().Done()
					}()
					return &http.Response{StatusCode: http.StatusOK, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader, Request: request}, nil
				})
				h.requestTimeout, h.maximumSessionStale = 15*time.Second, 30*time.Second
				h.now = time.Now
				ctx, cancel := context.WithCancel(context.Background())
				response := httptest.NewRecorder()
				done := make(chan struct{})
				request := newBrowserRequest(http.MethodGet, "/api/app/workspace/v1/agents/agent-1/events", nil).WithContext(ctx)
				addSessionCookies(request, "token-1", testCSRFToken)
				go func() { defer close(done); h.ServeHTTP(response, request) }()
				defer func() {
					cancel()
					<-done
					if transportStarted {
						<-producerDone
						<-cancelHookDone
					}
				}()
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
					if calls != 3 {
						t.Fatalf("Bridge frame unexpectedly changed periodic Resolve accounting: calls=%d", calls)
					}
					wantFrames = 2
					cancel()
				case "blocked-recheck":
					select {
					case <-done:
						t.Fatal("blocked periodic recheck closed before its original deadline")
					default:
					}
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
				if response.Code != http.StatusOK || strings.Count(response.Body.String(), "event: view\n") != wantFrames || len(response.Result().Cookies()) != 0 || len(h.bridgeStreams) != 0 {
					t.Fatalf("SSE admission/cleanup changed: status=%d frames=%d capacity=%d", response.Code, strings.Count(response.Body.String(), "event: view\n"), len(h.bridgeStreams))
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
			h := newTestHandler(t, service, upstream, time.Now())
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

func cacheStreamPrincipal(principal identity.Principal) identity.Principal {
	principal.ActivityIntervalMS = 1000
	principal.ResolveStartedAt = time.Now().Add(-2 * time.Second)
	principal.ResolveCompletedAt = principal.ResolveStartedAt.Add(time.Millisecond)
	principal.ResolveValidUntil, principal.ResolveCacheHit = principal.ResolveStartedAt.Add(10*time.Second), true
	return principal
}
