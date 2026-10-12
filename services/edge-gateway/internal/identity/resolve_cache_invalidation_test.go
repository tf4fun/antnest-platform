package identity

import (
	"context"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveCacheRefreshDenialEvictsEveryTokenScope(t *testing.T) {
	for _, denial := range []string{"inactive", "unauthenticated", "inactive_principal"} {
		t.Run(denial, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int64
				var denied atomic.Bool
				client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
					calls.Add(1)
					payload := cacheTestPayload(request)
					if denied.Load() {
						if denial != "inactive" {
							return jsonResponse(401, `{"code":"`+denial+`"}`), nil
						}
						payload["principal"].(map[string]any)["active"] = false
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				client.SessionFeedCaughtUp(time.Now())
				for _, profile := range []string{"workspace", "console", "acp"} {
					if _, err := client.Resolve(WithResolution(context.Background(), profile, "agent-A"), "token"); err != nil {
						t.Fatal(err)
					}
				}
				denied.Store(true)
				time.Sleep(5 * time.Second)
				ctx := WithResolution(context.Background(), "workspace", "agent-A")
				if hit, err := client.Resolve(ctx, "token"); err != nil || !hit.ResolveCacheHit {
					t.Fatalf("valid hit did not trigger owned background refresh: %v", err)
				}
				synctest.Wait()
				if calls.Load() != 4 {
					t.Fatalf("half-TTL refresh calls=%d, want four total", calls.Load())
				}
				for _, profile := range []string{"workspace", "console", "acp"} {
					result, err := client.Resolve(WithResolution(context.Background(), profile, "agent-A"), "token")
					if result.Active || result.ResolveCacheHit || (denial == "inactive") != (err == nil) {
						t.Fatalf("background denial left an active scope reusable: %v", err)
					}
				}
				if calls.Load() != 7 {
					t.Fatal("authoritative denial was negatively cached")
				}
			})
		})
	}
}

func TestResolveCacheRevocationFencesUnknownInFlightSID(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			select {
			case <-gate:
				return cacheTestResponse(payload), nil
			case <-request.Context().Done():
				return nil, request.Context().Err()
			}
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		finished := make(chan cacheResolveResult, 1)
		go func() {
			p, err := client.Resolve(context.Background(), "token")
			finished <- cacheResolveResult{p, err}
		}()
		synctest.Wait()
		client.ApplySessionRevocation(SessionRevocation{Sequence: 1, TokenID: cacheTestSID("token"), UserID: "user-1", OrganizationID: "org-1", Reason: "session_revoked", OccurredAt: time.Now()})
		close(gate)
		if result := <-finished; result.err == nil || result.principal.Active {
			t.Fatal("a pre-revocation unknown-SID result escaped to its waiter")
		}
	})
}

func TestResolveCacheRechecksReadyResultsAtFinalDelivery(t *testing.T) {
	for _, interruption := range []string{"revocation", "expiry", "logout", "shutdown"} {
		t.Run(interruption, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
					if request.URL.Path == "/rpc/identity/revoke-access-token" {
						return cacheTestResponse(map[string]any{"status": "revoked"}), nil
					}
					return cacheTestResponse(cacheTestPayload(request)), nil
				})
				defer client.Close()
				flight := cachePendingDelivery(client, "token", "workspace")
				synctest.Wait()
				switch interruption {
				case "revocation":
					client.ApplySessionRevocation(SessionRevocation{TokenID: cacheTestSID("token")})
				case "expiry":
					time.Sleep(10 * time.Second)
				case "logout":
					if _, err := client.RevokeByAccessToken(context.Background(), "token"); err != nil {
						t.Fatal(err)
					}
				case "shutdown":
					client.Close()
				}
				if principal, err := client.cache.wait(context.Background(), flight, nil); err == nil || principal.Active {
					t.Error("ready old authority escaped after a later invalidation/deadline")
				}
				client.cache.mu.Lock()
				active, waiters, retained := client.cache.active, client.cache.waiters, len(client.cache.retained)
				client.cache.mu.Unlock()
				if active != 0 || waiters != 0 || retained != 0 {
					t.Fatalf("delivery leaked work ownership: active=%d waiters=%d retained=%d", active, waiters, retained)
				}
			})
		})
	}
}

func TestResolveCacheAuthoritativeDenialFencesOtherScopeInFlight(t *testing.T) {
	for _, denial := range []string{"inactive", "unauthenticated", "inactive_principal"} {
		t.Run(denial, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int64
				gate := make(chan struct{})
				var releaseOnce sync.Once
				client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
					payload := cacheTestPayload(request)
					if calls.Add(1) == 1 {
						<-gate // Complete an old positive even after cancellation.
						return cacheTestResponse(payload), nil
					}
					if denial == "inactive" {
						payload["principal"].(map[string]any)["active"] = false
						return cacheTestResponse(payload), nil
					}
					return jsonResponse(401, `{"code":"`+denial+`"}`), nil
				})
				defer client.Close()
				defer releaseOnce.Do(func() { close(gate) })
				client.SessionFeedCaughtUp(time.Now())
				old := make(chan cacheResolveResult, 1)
				go func() {
					p, err := client.Resolve(WithResolution(context.Background(), "console", ""), "token")
					old <- cacheResolveResult{p, err}
				}()
				synctest.Wait()
				principal, err := client.Resolve(context.Background(), "token")
				if principal.Active || (denial == "inactive") != (err == nil) {
					t.Fatalf("denial semantics changed: %v", err)
				}
				releaseOnce.Do(func() { close(gate) })
				if result := <-old; result.err == nil || result.principal.Active {
					t.Fatal("old scope returned positive after another scope's denial")
				}
				synctest.Wait()
				client.cache.mu.Lock()
				entries := len(client.cache.entries)
				client.cache.mu.Unlock()
				if entries != 0 {
					t.Fatal("late denied-token flight refilled cache")
				}
			})
		})
	}
}
