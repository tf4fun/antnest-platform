package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveCacheSessionRevocationIsScopedAtCompletionAndDelivery(t *testing.T) {
	for _, phase := range []string{"in-flight", "ready"} {
		for _, revoked := range []string{"same-session", "unrelated-session"} {
			t.Run(phase+"/"+revoked, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					gate := make(chan struct{})
					var release sync.Once
					unblock := func() { release.Do(func() { close(gate) }) }
					var calls atomic.Int64
					client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
						calls.Add(1)
						payload := cacheTestPayload(request)
						<-gate
						return cacheTestResponse(payload), nil
					})
					defer client.Close()
					defer unblock()
					client.SessionFeedCaughtUp(time.Now())
					flight := cachePendingDelivery(client, "token", "session")
					synctest.Wait()
					if phase == "ready" {
						unblock()
						synctest.Wait()
					}
					sid := cacheTestSID("token")
					if revoked == "unrelated-session" {
						sid = cacheTestSID("another-token")
					}
					client.ApplySessionRevocation(SessionRevocation{TokenID: sid})
					if phase == "in-flight" {
						unblock()
					}
					principal, err := client.cache.wait(context.Background(), flight, nil)
					if revoked == "same-session" {
						if err == nil || principal.Active {
							t.Fatal("revoked authority escaped to its waiter")
						}
					} else if err != nil || !principal.Active || principal.SessionID != cacheTestSID("token") || principal.ResolveCacheHit {
						t.Fatalf("unrelated revocation discarded valid live authority: %v", err)
					}
					if calls.Load() != 1 {
						t.Fatalf("scoped invalidation retried Resolve: calls=%d", calls.Load())
					}
					synctest.Wait()
					client.cache.mu.Lock()
					defer client.cache.mu.Unlock()
					if client.cache.active != 0 || client.cache.waiters != 0 || len(client.cache.retained) != 0 {
						t.Fatal("completed delivery retained work ownership")
					}
				})
			})
		}
	}
}

func TestResolveCacheSessionRevocationWindowBoundaries(t *testing.T) {
	for _, phase := range []string{"in-flight", "ready"} {
		for _, count := range []int{128, 129} {
			for _, matching := range []int{-1, 0, count - 1} {
				t.Run(fmt.Sprintf("%s/events-%d/match-%d", phase, count, matching), func(t *testing.T) {
					synctest.Test(t, func(t *testing.T) {
						gate := make(chan struct{})
						var release sync.Once
						unblock := func() { release.Do(func() { close(gate) }) }
						var calls atomic.Int64
						client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
							calls.Add(1)
							payload := cacheTestPayload(request)
							<-gate
							return cacheTestResponse(payload), nil
						})
						defer client.Close()
						defer unblock()
						flight := cachePendingDelivery(client, "token", "session")
						synctest.Wait()
						if phase == "ready" {
							unblock()
							synctest.Wait()
						}
						for n := 0; n < count; n++ {
							sid := fmt.Sprintf("unrelated-session-%d", n)
							if n == matching {
								sid = cacheTestSID("token")
							}
							// The producer sequence is sparse; only locally applied events
							// consume the bounded window.
							client.ApplySessionRevocation(SessionRevocation{Sequence: int64(10000 * (n + 1)), TokenID: sid})
						}
						if phase == "in-flight" {
							unblock()
						}
						principal, err := client.cache.wait(context.Background(), flight, nil)
						rejected := count > 128 || matching >= 0
						if rejected && (err == nil || principal.Active) {
							t.Fatal("revoked or incomplete-history authority escaped")
						}
						if !rejected && (err != nil || !principal.Active || principal.ResolveCacheHit) {
							t.Fatalf("complete unrelated history rejected live authority: %v", err)
						}
						if calls.Load() != 1 {
							t.Fatal("window check retried Resolve")
						}
						client.cache.mu.Lock()
						entries := len(client.cache.entries)
						client.cache.mu.Unlock()
						if phase == "in-flight" && rejected && entries != 0 {
							t.Fatal("rejected old authority refilled cache before final delivery")
						}
					})
				})
			}
		}
	}
}

func TestResolveCacheSessionRevocationFencesBackgroundRefill(t *testing.T) {
	for _, scenario := range []string{"matching", "overflow", "unrelated"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				gate := make(chan struct{})
				var release sync.Once
				unblock := func() { release.Do(func() { close(gate) }) }
				var calls atomic.Int64
				client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
					payload := cacheTestPayload(request)
					if calls.Add(1) == 2 {
						<-gate
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				defer unblock()
				client.SessionFeedCaughtUp(time.Now())
				original, err := client.Resolve(context.Background(), "token")
				if err != nil {
					t.Fatal(err)
				}
				time.Sleep(5 * time.Second)
				if hit, err := client.Resolve(context.Background(), "token"); err != nil || !hit.ResolveCacheHit {
					t.Fatalf("background refresh trigger failed: %v", err)
				}
				synctest.Wait()
				events := 1
				if scenario == "overflow" {
					events = 129
				}
				for n := 0; n < events; n++ {
					sid := "unrelated-session"
					if scenario == "matching" {
						sid = cacheTestSID("token")
					}
					client.ApplySessionRevocation(SessionRevocation{TokenID: sid})
				}
				unblock()
				synctest.Wait()
				client.cache.mu.Lock()
				defer client.cache.mu.Unlock()
				if calls.Load() != 2 || client.cache.active != 0 || len(client.cache.retained) != 0 {
					t.Fatal("background invalidation retried or retained completed work")
				}
				if scenario == "matching" {
					if len(client.cache.entries) != 0 {
						t.Fatal("revoked background response refilled cache")
					}
					return
				}
				if len(client.cache.entries) != 1 {
					t.Fatal("unrelated events evicted the prior valid entry")
				}
				for _, entry := range client.cache.entries {
					renewed := entry.principal.ResolveStartedAt.After(original.ResolveStartedAt)
					if renewed != (scenario == "unrelated") {
						t.Fatalf("background refill violated its revocation window: renewed=%v", renewed)
					}
				}
			})
		})
	}
}

func TestResolveCacheSessionRevocationDoesNotBecomeANegativeCache(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		defer client.Close()
		for n := 0; n < 129; n++ {
			client.ApplySessionRevocation(SessionRevocation{TokenID: cacheTestSID("token")})
		}
		principal, err := client.Resolve(context.Background(), "token")
		if err != nil || !principal.Active || principal.ResolveCacheHit {
			t.Fatalf("historical events replaced new live authority: %v", err)
		}
	})
}

func TestResolveCacheLiveResultMustAgreeWithPreviouslyKnownSID(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			payload := cacheTestPayload(request)
			if calls.Add(1) == 2 {
				encoded := payload["caller_context"].(string)
				// Decode only the fixture's signed claims, then sign a different SID
				// while leaving the response's User, Organization and scope valid.
				segments := strings.Split(encoded, ".")
				claimsJSON, err := base64.RawURLEncoding.DecodeString(segments[1])
				if err != nil {
					panic(err)
				}
				var claims map[string]any
				if err := json.Unmarshal(claimsJSON, &claims); err != nil {
					panic(err)
				}
				claims["sid"] = cacheTestSID("other-token")
				payload["caller_context"] = cacheTestCCT(claims)
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		if _, err := client.Resolve(context.Background(), "token"); err != nil {
			t.Fatal(err)
		}
		principal, err := client.Resolve(WithResolution(context.Background(), "session", ""), "token")
		if err == nil || principal.Active || calls.Load() != 2 {
			t.Fatalf("inconsistent SID was admitted or retried: err=%v calls=%d", err, calls.Load())
		}
	})
}

func TestResolveCacheSessionRevocationCounterWrapFencesEveryRetainedFlight(t *testing.T) {
	for _, phase := range []string{"in-flight", "ready"} {
		t.Run(phase, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				gate := make(chan struct{})
				var release sync.Once
				unblock := func() { release.Do(func() { close(gate) }) }
				client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
					payload := cacheTestPayload(request)
					<-gate
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				defer unblock()
				client.cache.revocationCount = ^uint64(0) - 1
				flight := cachePendingDelivery(client, "token", "session")
				synctest.Wait()
				if phase == "ready" {
					unblock()
					synctest.Wait()
				}
				client.ApplySessionRevocation(SessionRevocation{TokenID: "unrelated-before-wrap"})
				client.ApplySessionRevocation(SessionRevocation{TokenID: "unrelated-after-wrap"})
				client.cache.mu.Lock()
				invalidated, retained := flight.invalidated, client.cache.active
				client.cache.mu.Unlock()
				if phase == "in-flight" {
					unblock()
				}
				principal, err := client.cache.wait(context.Background(), flight, nil)
				if !invalidated || retained != 1 || err == nil || principal.Active {
					t.Fatalf("counter wrap did not fence retained work: invalidated=%v retained=%d err=%v", invalidated, retained, err)
				}
				// Work created after the reset still uses the real current authority.
				fresh, freshErr := client.Resolve(WithResolution(context.Background(), "session", ""), "fresh-token")
				if freshErr != nil || !fresh.Active || fresh.ResolveCacheHit {
					t.Fatalf("wrap became a persistent denial: %v", freshErr)
				}
			})
		})
	}
}
