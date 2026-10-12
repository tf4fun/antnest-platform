package identity

import (
	"context"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveCacheActivityCompletedSIDCoversUnknownSibling(t *testing.T) {
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
			switch calls.Add(1) {
			case 1:
				payload["principal"].(map[string]any)["organization_name"] = strings.Repeat("x", 20000)
			case 2:
				<-gate
			default:
				payload["principal"].(map[string]any)["organization_name"] = "new-generation"
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer release.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now())
		ready := cachePendingDelivery(client, "token", "workspace")
		synctest.Wait()
		client.cache.mu.Lock()
		authority = ready.principal
		isolated := ready.completed && ready.knownSID == "" && len(client.cache.entries) == 0 && len(client.cache.bySID) == 0
		client.cache.mu.Unlock()
		if !isolated || !authority.Active {
			t.Fatal("fixture did not isolate completed-only SID evidence")
		}
		sibling := cachePendingDelivery(client, "token", "console")
		synctest.Wait()
		if err := cacheMutation(client, "activity", authority); err != nil {
			t.Fatal(err)
		}
		console := WithResolution(context.Background(), "console", "")
		newer := activityRead(client, console, "token")
		synctest.Wait()
		if calls.Load() != 3 {
			t.Fatal("completed-only SID evidence allowed joining an obsolete sibling")
		}
		release.Do(func() { close(gate) })
		synctest.Wait()
		if principal, err := client.cache.wait(context.Background(), ready, nil); err != nil || principal != authority {
			t.Fatalf("activity changed oversized ready authority: %v", err)
		}
		if principal, err := client.cache.wait(context.Background(), sibling, nil); err != nil || !principal.Active || principal.ResolveCacheHit {
			t.Fatalf("activity cancelled unknown-SID sibling: %v", err)
		}
		if result := <-newer; result.err != nil || result.principal.OrganizationName != "new-generation" {
			t.Fatalf("newer generation failed: %v", result.err)
		}
		if hit, err := client.Resolve(console, "token"); err != nil || !hit.ResolveCacheHit || hit.OrganizationName != "new-generation" || calls.Load() != 3 {
			t.Fatalf("completed-only SID evidence allowed obsolete refill: %v", err)
		}
	})
}

func TestResolveCacheActivityObsoleteDenialFencesNewGenerations(t *testing.T) {
	for _, denial := range []string{"inactive", "unauthenticated", "inactive_principal"} {
		for _, state := range []string{"held", "ready"} {
			t.Run(denial+"/"+state, func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					oldGate, newGate := make(chan struct{}), make(chan struct{})
					var oldRelease, newRelease sync.Once
					var calls atomic.Int64
					var authority Principal
					client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
						if request.URL.Path != "/rpc/identity/resolve-access-token" {
							return cacheTestResponse(activityReply(authority)), nil
						}
						payload := cacheTestPayload(request)
						switch calls.Add(1) {
						case 2:
							<-oldGate // Even a late authoritative denial must fence newer work.
							if denial != "inactive" {
								return jsonResponse(401, `{"code":"`+denial+`"}`), nil
							}
							payload["principal"].(map[string]any)["active"] = false
						case 3:
							if state == "held" {
								<-newGate // Simulate transport completion after a security cancellation.
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
					time.Sleep(10 * time.Second)
					client.SessionFeedCaughtUp(time.Now())
					old := activityRead(client, context.Background(), "token")
					synctest.Wait()
					if err := cacheMutation(client, "activity", authority); err != nil {
						t.Fatal(err)
					}
					newer := cachePendingDelivery(client, "token", "workspace")
					synctest.Wait()
					if _, err := client.Resolve(WithResolution(context.Background(), "console", ""), "token"); err != nil {
						t.Fatal(err)
					}
					oldRelease.Do(func() { close(oldGate) })
					synctest.Wait()
					result := <-old
					if result.principal.Active || (denial == "inactive") != (result.err == nil) || denial != "inactive" && !IsCode(result.err, denial) {
						t.Fatalf("obsolete work lost authoritative denial: %v", result.err)
					}
					newRelease.Do(func() { close(newGate) })
					synctest.Wait()
					if principal, err := client.cache.wait(context.Background(), newer, nil); err == nil || principal.Active {
						t.Fatal("obsolete denial allowed newer authority to escape")
					}
					client.cache.mu.Lock()
					entries, active, waiters := len(client.cache.entries), client.cache.active, client.cache.waiters
					client.cache.mu.Unlock()
					if entries != 0 || active != 0 || waiters != 0 || calls.Load() != 4 {
						t.Fatalf("denial left authority/work or retried: entries=%d active=%d waiters=%d calls=%d", entries, active, waiters, calls.Load())
					}
				})
			})
		}
	}
}

func TestResolveCacheActivityFailurePreservesReadersAndEntries(t *testing.T) {
	for _, failure := range []string{"transport", "absolute", "interval", "idle"} {
		t.Run(failure, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				gate := make(chan struct{})
				var release sync.Once
				var calls atomic.Int64
				var authority Principal
				client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
					if request.URL.Path != "/rpc/identity/resolve-access-token" {
						payload := activityReply(authority)
						switch failure {
						case "transport":
							return jsonResponse(503, `{"code":"identity_unavailable"}`), nil
						case "absolute":
							payload["expires_at"] = authority.ExpiresAt.Add(time.Second)
						case "interval":
							payload["activity_interval_ms"] = 0
						case "idle":
							payload["idle_expires_at"] = authority.ExpiresAt.Add(time.Second)
						}
						return cacheTestResponse(payload), nil
					}
					payload := cacheTestPayload(request)
					if calls.Add(1) == 2 {
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
				console := WithResolution(context.Background(), "console", "")
				reader := activityRead(client, console, "token")
				synctest.Wait()
				if err := cacheMutation(client, "activity", authority); err == nil {
					t.Fatal("invalid Touch unexpectedly succeeded")
				}
				if hit, err := client.Resolve(context.Background(), "token"); err != nil || !hit.ResolveCacheHit || calls.Load() != 2 {
					t.Fatalf("failed Touch evicted an existing entry: %v", err)
				}
				release.Do(func() { close(gate) })
				if result := <-reader; result.err != nil || !result.principal.Active {
					t.Fatalf("failed Touch cancelled an existing reader: %v", result.err)
				}
				if hit, err := client.Resolve(console, "token"); err != nil || !hit.ResolveCacheHit || calls.Load() != 2 {
					t.Fatalf("failed Touch prevented a valid cache fill: %v", err)
				}
			})
		})
	}
}
