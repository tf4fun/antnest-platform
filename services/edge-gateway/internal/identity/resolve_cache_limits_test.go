package identity

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveCacheEvictsLeastRecentlyUsedEntry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 2, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		for _, token := range []string{"A", "B", "A", "C", "A"} {
			if _, err := client.Resolve(context.Background(), token); err != nil {
				t.Fatal(err)
			}
		}
		if calls.Load() != 3 {
			t.Fatal("LRU movement evicted the frequently used entry")
		}
		if principal, err := client.Resolve(context.Background(), "B"); err != nil || principal.ResolveCacheHit || calls.Load() != 4 {
			t.Fatalf("entry ceiling retained the least recently used value: %v", err)
		}
	})
}

func TestResolveCacheAccountsPrivateFieldsBeyondBrowserJSON(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			payload := cacheTestPayload(request)
			payload["principal"].(map[string]any)["organization_name"] = strings.Repeat("x", 15000)
			public, _ := json.Marshal(payload["principal"])
			if len(public)+resolveCacheEntryCharge >= resolveCacheEntryBytes {
				t.Error("fixture does not isolate omitted private fields")
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		for range 2 {
			if principal, err := client.Resolve(context.Background(), "token"); err != nil || principal.ResolveCacheHit || len(principal.OrganizationName) != 15000 {
				t.Fatalf("cache admission changed a valid larger live value: %v", err)
			}
		}
		if calls.Load() != 2 {
			t.Fatal("cache sized only public JSON and omitted retained CCT/SID")
		}
	})
}

func TestResolveCacheRetainedByteBudgetEvictsBeforeEntryCeiling(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 50000, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			payload := cacheTestPayload(request)
			payload["principal"].(map[string]any)["organization_name"] = strings.Repeat("x", 13000)
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		for index := range 5000 {
			if _, err := client.Resolve(context.Background(), fmt.Sprintf("token-%d", index)); err != nil {
				t.Fatal(err)
			}
		}
		client.cache.mu.Lock()
		count, bytes := len(client.cache.entries), client.cache.bytes
		sids, tokens := len(client.cache.bySID), len(client.cache.byToken)
		client.cache.mu.Unlock()
		if count < 1 || count >= 5000 || bytes > 64*1024*1024 || sids != count || tokens != count {
			t.Fatalf("byte eviction or index cleanup failed: entries=%d bytes=%d sids=%d tokens=%d", count, bytes, sids, tokens)
		}
		if latest, err := client.Resolve(context.Background(), "token-4999"); err != nil || !latest.ResolveCacheHit || calls.Load() != 5000 {
			t.Fatalf("byte pressure rejected/evicted the latest admissible entry: %v", err)
		}
		if oldest, err := client.Resolve(context.Background(), "token-0"); err != nil || oldest.ResolveCacheHit || calls.Load() != 5001 {
			t.Fatalf("byte pressure did not evict oldest retained data: %v", err)
		}
	})
}

func TestResolveCacheBoundsWaitersPerScopeAndGlobally(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			<-request.Context().Done()
			return nil, request.Context().Err()
		})
		defer client.Close()
		ctx, cancel := context.WithCancel(context.Background())
		var workers sync.WaitGroup
		defer func() { cancel(); workers.Wait() }()
		finished := make(chan error, 1024)
		startScope := func(token string) {
			for range 128 {
				workers.Go(func() { _, err := client.Resolve(ctx, token); finished <- err })
			}
			synctest.Wait()
		}
		startScope("first")
		if _, err := client.Resolve(context.Background(), "first"); !IsCode(err, "identity_unavailable") || calls.Load() != 1 {
			t.Fatalf("scope accepted its 129th waiter: %v", err)
		}
		for index := range 7 {
			startScope(fmt.Sprintf("other-%d", index))
		}
		if _, err := client.Resolve(context.Background(), "new-scope"); !IsCode(err, "identity_unavailable") || calls.Load() != 8 {
			t.Fatalf("global waiter limit started an unbounded fallback: %v", err)
		}
		cancel()
		for range 1024 {
			if err := <-finished; !errors.Is(err, context.Canceled) {
				t.Fatalf("bounded waiter failed to leave independently: %v", err)
			}
		}
	})
}

func TestResolveCacheRefreshFailureDoesNotRetryPerHitOrExtendEntry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			if calls.Add(1) != 1 {
				return nil, errors.New("synthetic Identity outage")
			}
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		first, err := client.Resolve(context.Background(), "token")
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(5 * time.Second)
		for range 20 {
			principal, err := client.Resolve(context.Background(), "token")
			if err != nil || !principal.ResolveCacheHit || !principal.ResolveStartedAt.Equal(first.ResolveStartedAt) || !principal.ResolveValidUntil.Equal(first.ResolveValidUntil) {
				t.Fatalf("failed refresh changed valid old authority: %v", err)
			}
			synctest.Wait()
		}
		if calls.Load() != 2 {
			t.Fatalf("refresh failure became one RPC per hit: calls=%d", calls.Load())
		}
		time.Sleep(5 * time.Second)
		client.SessionFeedCaughtUp(time.Now())
		if principal, err := client.Resolve(context.Background(), "token"); err == nil || principal.Active || calls.Load() != 3 {
			t.Fatal("fresh feed proof or failed refresh renewed an expired entry")
		}
	})
}

func TestResolveCacheScopeWaiterLimitIncludesOlderGenerations(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			<-request.Context().Done()
			return nil, request.Context().Err()
		})
		defer client.Close()
		ctx, cancel := context.WithCancel(context.Background())
		var workers sync.WaitGroup
		defer func() { cancel(); workers.Wait() }()
		for range 128 {
			workers.Go(func() { _, _ = client.Resolve(ctx, "token") })
		}
		synctest.Wait()
		client.ApplySessionRevocation(SessionRevocation{Sequence: 1, TokenID: "unrelated", UserID: "user-1", OrganizationID: "org-1", Reason: "session_revoked", OccurredAt: time.Now()})
		extra := make(chan error, 1)
		workers.Go(func() { _, err := client.Resolve(ctx, "token"); extra <- err })
		synctest.Wait()
		select {
		case err := <-extra:
			if !IsCode(err, "identity_unavailable") {
				t.Fatalf("unexpected scope overflow error: %v", err)
			}
		default:
			t.Error("a new generation admitted the 129th exact-scope waiter")
		}
		if calls.Load() != 1 {
			t.Fatalf("scope overflow started another actual RPC: %d", calls.Load())
		}
	})
}

func TestResolveCacheCompletedUndeliveredResultsKeepWorkCapacity(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			payload := cacheTestPayload(request)
			payload["principal"].(map[string]any)["organization_name"] = strings.Repeat("x", 20000)
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		// Register owners without scheduling delivery yet. An OS scheduler may
		// similarly delay ready waiters while new requests keep arriving.
		var pending []*resolveFlight
		for index := range 32 {
			token := fmt.Sprintf("token-%d", index)
			key := resolveKey{token: sha256.Sum256([]byte(token)), profile: "workspace"}
			client.cache.mu.Lock()
			flight := client.startResolveLocked(context.Background(), key, token, "", false)
			flight.waiters++
			client.cache.waiters++
			pending = append(pending, flight)
			client.cache.mu.Unlock()
		}
		synctest.Wait()
		if _, err := client.Resolve(context.Background(), "overflow"); !IsCode(err, "identity_unavailable") || calls.Load() != 32 {
			t.Errorf("undelivered large results escaped the work bound: calls=%d err=%v", calls.Load(), err)
		}
		for _, flight := range pending {
			if principal, err := client.cache.wait(context.Background(), flight, nil); err != nil || len(principal.OrganizationName) != 20000 {
				t.Fatalf("valid oversized live result was lost: %v", err)
			}
		}
		if _, err := client.Resolve(context.Background(), "after-delivery"); err != nil {
			t.Fatalf("delivered results did not release work capacity: %v", err)
		}
	})
}
