package identity

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func activityReply(principal Principal) map[string]any {
	return map[string]any{"expires_at": principal.ExpiresAt,
		"idle_expires_at": earliestTime(principal.IdleExpiresAt.Add(5*time.Second), principal.ExpiresAt), "activity_interval_ms": 1000}
}

func activityRead(client *Client, ctx context.Context, token string) <-chan cacheResolveResult {
	done := make(chan cacheResolveResult, 1)
	go func() { principal, err := client.Resolve(ctx, token); done <- cacheResolveResult{principal, err} }()
	return done
}

func TestResolveCacheActivitySeparatesLiveGenerations(t *testing.T) {
	for _, mode := range []string{"foreground", "shared", "background", "background-shared"} {
		for _, order := range []string{"new-first", "old-first"} {
			t.Run(mode+"/"+order, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					oldGate, newGate := make(chan struct{}), make(chan struct{})
					var oldRelease, newRelease sync.Once
					var calls atomic.Int64
					var oldCancelled atomic.Bool
					var authority Principal
					oldContext := make(chan string, 1)
					client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
						if request.URL.Path != "/rpc/identity/resolve-access-token" {
							return cacheTestResponse(activityReply(authority)), nil
						}
						payload := cacheTestPayload(request)
						number := calls.Add(1)
						var gate chan struct{}
						if number == 2 {
							payload["principal"].(map[string]any)["organization_name"] = "old-generation"
							oldContext <- payload["caller_context"].(string)
							gate = oldGate
						} else if number >= 3 {
							payload["principal"].(map[string]any)["organization_name"] = "new-generation"
							gate = newGate
						}
						if gate != nil {
							select {
							case <-gate:
							case <-request.Context().Done():
								if number == 2 {
									oldCancelled.Store(true)
								}
								return nil, request.Context().Err()
							}
						}
						return cacheTestResponse(payload), nil
					})
					defer client.Close()
					defer oldRelease.Do(func() { close(oldGate) })
					defer newRelease.Do(func() { close(newGate) })
					client.SessionFeedCaughtUp(time.Now())
					var err error
					authority, err = client.Resolve(context.Background(), "token")
					if err != nil {
						t.Fatal(err)
					}
					background := strings.HasPrefix(mode, "background")
					if background {
						time.Sleep(5 * time.Second)
					} else {
						time.Sleep(10 * time.Second)
					}
					client.SessionFeedCaughtUp(time.Now())
					started := time.Now()
					var readers []<-chan cacheResolveResult
					if background {
						if hit, err := client.Resolve(context.Background(), "token"); err != nil || !hit.ResolveCacheHit {
							t.Fatalf("refresh not triggered: %v", err)
						}
					} else {
						readers = append(readers, activityRead(client, context.Background(), "token"))
					}
					synctest.Wait()
					if mode == "shared" || mode == "background-shared" {
						// A stale proof requires live resolution and lets this reader join the held refresh.
						if background {
							client.cache.mu.Lock()
							client.cache.proof = time.Time{}
							client.cache.mu.Unlock()
						}
						readers = append(readers, activityRead(client, context.Background(), "token"))
						synctest.Wait()
					}
					if calls.Load() != 2 {
						t.Fatalf("readers did not share the actual old RPC: %d", calls.Load())
					}
					cct := <-oldContext
					time.Sleep(time.Second)
					if err := cacheMutation(client, "activity", authority); err != nil {
						t.Fatal(err)
					}
					synctest.Wait()
					if oldCancelled.Load() {
						t.Fatal("activity cancelled an owned RPC, including a refresh with no waiters")
					}
					for _, reader := range readers {
						select {
						case result := <-reader:
							t.Fatalf("activity completed a held reader: %v", result.err)
						default:
						}
					}
					client.SessionFeedCaughtUp(time.Now())
					newReader := activityRead(client, context.Background(), "token")
					synctest.Wait()
					if calls.Load() != 3 {
						t.Fatalf("post-Touch read joined obsolete work: %d", calls.Load())
					}
					if order == "new-first" {
						newRelease.Do(func() { close(newGate) })
						synctest.Wait()
					}
					oldRelease.Do(func() { close(oldGate) })
					synctest.Wait()
					for _, reader := range readers {
						result := <-reader
						if result.err != nil || !result.principal.Active || result.principal.ResolveCacheHit || result.principal.OrganizationName != "old-generation" || result.principal.CallerContext != cct || !result.principal.ResolveStartedAt.Equal(started) || !result.principal.ResolveValidUntil.Equal(started.Add(10*time.Second)) {
							t.Fatalf("old live result was lost or renewed: active=%v hit=%v err=%v", result.principal.Active, result.principal.ResolveCacheHit, result.err)
						}
					}
					var joined <-chan cacheResolveResult
					if order == "old-first" {
						joined = activityRead(client, context.Background(), "token")
						synctest.Wait()
						if calls.Load() != 3 {
							t.Fatal("old completion removed the newer flight")
						}
						newRelease.Do(func() { close(newGate) })
					}
					result := <-newReader
					if result.err != nil || result.principal.OrganizationName != "new-generation" || result.principal.ResolveCacheHit {
						t.Fatalf("new live generation failed: %v", result.err)
					}
					if joined != nil {
						if result := <-joined; result.err != nil || result.principal.OrganizationName != "new-generation" {
							t.Fatalf("new waiter lost its generation: %v", result.err)
						}
					}
					synctest.Wait()
					if hit, err := client.Resolve(context.Background(), "token"); err != nil || !hit.ResolveCacheHit || hit.OrganizationName != "new-generation" || calls.Load() != 3 {
						t.Fatalf("old result refilled or replaced newer cache: calls=%d err=%v", calls.Load(), err)
					}
				})
			})
		}
	}
}

func TestResolveCacheActivityReadyResultRetainsFinalSecurityAndDeadlineChecks(t *testing.T) {
	for _, interruption := range []string{"none", "revocation", "logout", "password", "denial", "caller", "shutdown", "ttl", "idle", "absolute", "cct"} {
		t.Run(interruption, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var authority Principal
				var denied atomic.Bool
				client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
					if request.URL.Path != "/rpc/identity/resolve-access-token" {
						if request.URL.Path == "/rpc/identity/touch-browser-session" {
							return cacheTestResponse(activityReply(authority)), nil
						}
						return cacheTestResponse(cacheMutationReply(interruption, authority)), nil
					}
					payload := cacheTestPayload(request)
					if denied.Load() {
						payload["principal"].(map[string]any)["active"] = false
					}
					if interruption == "idle" || interruption == "absolute" {
						payload["idle_expires_at"] = time.Now().Add(2 * time.Second)
					}
					if interruption == "absolute" {
						payload["expires_at"] = time.Now().Add(2 * time.Second)
					}
					if interruption == "cct" {
						body, _ := base64.RawURLEncoding.DecodeString(strings.Split(payload["caller_context"].(string), ".")[1])
						var claims map[string]any
						if err := json.Unmarshal(body, &claims); err != nil {
							return nil, err
						}
						claims["exp"] = time.Now().Unix() + 2
						payload["caller_context"] = cacheTestCCT(claims)
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				client.SessionFeedCaughtUp(time.Now())
				flight := cachePendingDelivery(client, "alice", "workspace")
				synctest.Wait()
				client.cache.mu.Lock()
				authority = flight.principal
				client.cache.mu.Unlock()
				if !authority.Active {
					t.Fatal("fixture Resolve did not complete")
				}
				if err := cacheMutation(client, "activity", authority); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				switch interruption {
				case "revocation":
					client.ApplySessionRevocation(SessionRevocation{TokenID: authority.SessionID})
				case "logout", "password":
					if err := cacheMutation(client, interruption, authority); err != nil {
						t.Fatal(err)
					}
				case "denial":
					denied.Store(true)
					if principal, err := client.Resolve(context.Background(), "alice"); err != nil || principal.Active {
						t.Fatalf("inactive denial fixture failed: %v", err)
					}
				case "caller":
					cancel()
				case "shutdown":
					client.Close()
				case "ttl", "idle", "absolute", "cct":
					time.Sleep(time.Until(authority.ResolveValidUntil))
				}
				principal, err := client.cache.wait(ctx, flight, nil)
				if interruption == "none" {
					if err != nil || principal != authority {
						t.Fatalf("activity changed ready authority: %v", err)
					}
				} else if err == nil || principal.Active {
					t.Fatal("activity exception bypassed a final security/deadline check")
				}
				client.cache.mu.Lock()
				active, waiters, retained := client.cache.active, client.cache.waiters, len(client.cache.retained)
				client.cache.mu.Unlock()
				if active != 0 || waiters != 0 || retained != 0 {
					t.Fatalf("ready delivery leaked capacity: %d/%d/%d", active, waiters, retained)
				}
			})
		})
	}
}

func TestResolveCacheRepeatedActivityRetainsOldWorkCapacity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		var release sync.Once
		var calls atomic.Int64
		var authority Principal
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/rpc/identity/resolve-access-token" {
				return cacheTestResponse(activityReply(authority)), nil
			}
			payload := cacheTestPayload(request)
			if calls.Add(1) > 1 {
				<-gate
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now())
		var err error
		authority, err = client.Resolve(context.Background(), "token")
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(10 * time.Second)
		client.SessionFeedCaughtUp(time.Now())
		var readers []<-chan cacheResolveResult
		for generation := range 32 {
			readers = append(readers, activityRead(client, context.Background(), "token"))
			synctest.Wait()
			if calls.Load() != int64(generation+2) {
				t.Fatalf("activity did not isolate generation %d", generation)
			}
			if err := cacheMutation(client, "activity", authority); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := client.Resolve(context.Background(), "token"); !IsCode(err, "identity_unavailable") || calls.Load() != 33 {
			t.Fatalf("activity escaped old-generation work capacity: %v", err)
		}
		client.cache.mu.Lock()
		active, waiters := client.cache.active, client.cache.waiters
		client.cache.mu.Unlock()
		if active != 32 || waiters != 32 {
			t.Fatalf("activity discarded existing owners: %d/%d", active, waiters)
		}
		release.Do(func() { close(gate) })
		for _, reader := range readers {
			if result := <-reader; result.err != nil || !result.principal.Active {
				t.Errorf("obsolete live reader failed: %v", result.err)
			}
		}
		synctest.Wait()
		if principal, err := client.Resolve(context.Background(), "token"); err != nil || principal.ResolveCacheHit || calls.Load() != 34 {
			t.Fatalf("obsolete work stored a result or leaked capacity: %v", err)
		}
	})
}

// Entry evidence can identify an unknown-SID flight for another profile. The
// token digest is private cache state; activity must cover that whole token.
func TestResolveCacheActivityEntryEvidenceCoversUnknownTokenFlight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		var release sync.Once
		var hold atomic.Bool
		var authority Principal
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/rpc/identity/resolve-access-token" {
				return cacheTestResponse(activityReply(authority)), nil
			}
			payload := cacheTestPayload(request)
			if hold.Load() {
				select {
				case <-gate:
				case <-request.Context().Done():
					return nil, request.Context().Err()
				}
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now())
		var err error
		authority, err = client.Resolve(context.Background(), "token")
		if err != nil {
			t.Fatal(err)
		}
		hold.Store(true)
		flight := cachePendingDelivery(client, "token", "console") // Intentionally cold SID, warm token in workspace.
		synctest.Wait()
		if err := cacheMutation(client, "activity", authority); err != nil {
			t.Fatal(err)
		}
		release.Do(func() { close(gate) })
		synctest.Wait()
		if principal, err := client.cache.wait(context.Background(), flight, nil); err != nil || !principal.Active {
			t.Fatalf("activity cancelled a token-identified reader: %v", err)
		}
		client.cache.mu.Lock()
		entry := client.cache.entries[resolveKey{token: sha256.Sum256([]byte("token")), profile: "console"}]
		client.cache.mu.Unlock()
		if entry != nil {
			t.Fatal("entry-identified obsolete flight refilled cache")
		}
	})
}
