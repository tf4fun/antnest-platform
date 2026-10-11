package identity

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

type cacheResolveResult struct {
	principal Principal
	err       error
}

func TestResolveCacheFirstWaiterCancellationDoesNotPoisonSharedWork(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		gate := make(chan struct{})
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
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
		first, cancelFirst := context.WithCancel(context.Background())
		defer cancelFirst()
		firstDone, secondDone := make(chan cacheResolveResult, 1), make(chan cacheResolveResult, 1)
		go func() { p, err := client.Resolve(first, "same-token"); firstDone <- cacheResolveResult{p, err} }()
		synctest.Wait()
		go func() {
			p, err := client.Resolve(context.Background(), "same-token")
			secondDone <- cacheResolveResult{p, err}
		}()
		synctest.Wait()
		cancelFirst()
		synctest.Wait()
		if result := <-firstDone; !errors.Is(result.err, context.Canceled) {
			t.Fatalf("cancelled waiter stayed attached: %v", result.err)
		}
		close(gate)
		result := <-secondDone
		if result.err != nil || !result.principal.Active || calls.Load() != 1 {
			t.Fatalf("first waiter owned another waiter's RPC: calls=%d err=%v", calls.Load(), result.err)
		}
	})
}

func TestResolveCacheCancelledRPCsKeepCapacityUntilTheyJoin(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		release := make(chan struct{})
		var releaseOnce sync.Once
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			number := calls.Add(1)
			payload := cacheTestPayload(request)
			if number <= 32 {
				<-request.Context().Done()
				<-release // Deliberately model cancellation before transport cleanup.
				return nil, request.Context().Err()
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer releaseOnce.Do(func() { close(release) })
		client.SessionFeedCaughtUp(time.Now())
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		finished := make(chan error, 32)
		for index := range 32 {
			go func() {
				_, err := client.Resolve(ctx, fmt.Sprintf("token-%d", index))
				finished <- err
			}()
		}
		synctest.Wait()
		if calls.Load() != 32 {
			t.Fatalf("did not fill distinct active scopes: %d", calls.Load())
		}
		cancel()
		synctest.Wait()
		for range 32 {
			if err := <-finished; !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled waiter did not detach: %v", err)
			}
		}
		if _, err := client.Resolve(context.Background(), "fresh-token"); !IsCode(err, "identity_unavailable") || calls.Load() != 32 {
			t.Fatalf("cancelled unjoined RPC released its work capacity: calls=%d err=%v", calls.Load(), err)
		}
		releaseOnce.Do(func() { close(release) })
		synctest.Wait()
		if _, err := client.Resolve(context.Background(), "fresh-token"); err != nil || calls.Load() != 33 {
			t.Fatalf("joined RPC did not release capacity: %v", err)
		}
	})
}

func TestResolveCacheCloseRejectsWorkCancelsAndJoins(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		release := make(chan struct{})
		cancelled := make(chan struct{}, 1)
		var releaseOnce sync.Once
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			<-request.Context().Done()
			cancelled <- struct{}{}
			<-release
			return nil, request.Context().Err()
		})
		defer client.Close()
		defer releaseOnce.Do(func() { close(release) })
		finished, closed := make(chan error, 1), make(chan struct{})
		go func() { _, err := client.Resolve(context.Background(), "token"); finished <- err }()
		synctest.Wait()
		go func() { client.Close(); close(closed) }()
		synctest.Wait()
		select {
		case <-cancelled:
		default:
			t.Fatal("Close waited for the normal RPC timeout before cancellation")
		}
		select {
		case <-closed:
			t.Fatal("Close returned before its transport worker joined")
		default:
		}
		if _, err := client.Resolve(context.Background(), "other-token"); err == nil || calls.Load() != 1 {
			t.Fatal("Close admitted new work")
		}
		releaseOnce.Do(func() { close(release) })
		<-closed
		if err := <-finished; err == nil {
			t.Fatal("shutdown returned successful authority")
		}
	})
}

func TestResolveCacheSharedDeadlineReleasesWaiterBeforeTransportCleanup(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var releaseOnce sync.Once
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			<-request.Context().Done()
			<-release
			return nil, request.Context().Err()
		})
		defer client.Close()
		defer releaseOnce.Do(func() { close(release) })
		finished := make(chan error, 1)
		go func() { _, err := client.Resolve(context.Background(), "token"); finished <- err }()
		synctest.Wait()
		time.Sleep(5 * time.Second)
		synctest.Wait()
		select {
		case err := <-finished:
			if !errors.Is(err, context.DeadlineExceeded) {
				t.Fatalf("shared deadline did not reach its waiter: %v", err)
			}
		default:
			t.Fatal("waiter exceeded the shared deadline while transport cleanup was pending")
		}
		client.cache.mu.Lock()
		active, waiters := client.cache.active, client.cache.waiters
		client.cache.mu.Unlock()
		if active != 1 || waiters != 0 {
			t.Fatalf("deadline must release only the waiter, not unjoined work: active=%d waiters=%d", active, waiters)
		}
		releaseOnce.Do(func() { close(release) })
		synctest.Wait()
	})
}
