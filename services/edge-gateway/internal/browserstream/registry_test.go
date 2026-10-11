package browserstream

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

type feedFunc func(context.Context, int64, int) (identity.SessionRevocationPage, error)

func (fn feedFunc) ListSessionRevocations(ctx context.Context, after int64, limit int) (identity.SessionRevocationPage, error) {
	return fn(ctx, after, limit)
}

func TestPrivateFeedCancelsOnlyRegisteredMatchingAuthority(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		registry := NewRegistry()
		cfg := streamConfig(streamPrincipal())
		guard, err := Start(context.Background(), registry, cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer guard.Close()
		event := identity.SessionRevocation{TokenID: cfg.Original.SessionID, UserID: "different-user", OrganizationID: cfg.Original.OrganizationID}
		registry.Revoke(event)
		if guard.Context().Err() != nil {
			t.Fatal("feed crossed original User binding")
		}
		event.UserID = cfg.Original.UserID
		registry.Revoke(event)
		if !errors.Is(context.Cause(guard.Context()), ErrRejected) {
			t.Fatal("private SID revocation did not cancel silent stream")
		}
		guard.Close()
		if len(registry.sessions) != 0 {
			t.Fatal("closed SID remained registered")
		}
		// A racing subscription may miss this event; its independent live
		// checks remain responsible. Registry must not grow an event cache.
		registry.Revoke(event)
		fresh, err := Start(context.Background(), registry, cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer fresh.Close()
		if fresh.Context().Err() != nil {
			t.Fatal("registry retained historical feed events")
		}
	})
}

func TestFeedPollerBoundsCatchupAndRestartsFromZero(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		registry := NewRegistry()
		for range 2 {
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			var cursors []int64
			var mu sync.Mutex
			observed := func() []int64 { mu.Lock(); defer mu.Unlock(); return append([]int64(nil), cursors...) }
			source := feedFunc(func(ctx context.Context, after int64, limit int) (identity.SessionRevocationPage, error) {
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 5*time.Second || limit != 500 {
					t.Error("feed RPC budget/page is unbounded")
				}
				mu.Lock()
				cursors = append(cursors, after)
				mu.Unlock()
				events := make([]identity.SessionRevocation, limit)
				for i := range events {
					events[i] = identity.SessionRevocation{Sequence: after + int64(i) + 1, TokenID: "private", UserID: "u", OrganizationID: "o"}
				}
				return identity.SessionRevocationPage{Events: events, NextSequence: after + int64(limit)}, nil
			})
			go func() { defer close(done); registry.Poll(ctx, source) }()
			synctest.Wait()
			if seen := observed(); len(seen) != 4 || seen[0] != 0 || seen[3] != 1500 {
				t.Fatalf("unbounded or stale catchup cursors: %v", seen)
			}
			time.Sleep(time.Second)
			synctest.Wait()
			if seen := observed(); len(seen) != 8 || seen[4] != 2000 {
				t.Fatalf("cursor did not resume bounded catchup: %v", seen)
			}
			cancel()
			<-done
			if len(registry.sessions) != 0 {
				t.Fatal("feed cached historical SIDs")
			}
		}
	})
}

func TestFeedFailureRetriesWithoutAdvancingAndCancellationJoinsRPC(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		registry := NewRegistry()
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		var calls atomic.Int32
		joined := false
		source := feedFunc(func(ctx context.Context, after int64, limit int) (identity.SessionRevocationPage, error) {
			count := calls.Add(1)
			if after != 0 {
				t.Error("failed feed advanced its cursor")
			}
			if count == 1 {
				return identity.SessionRevocationPage{}, errors.New("feed unavailable")
			}
			<-ctx.Done()
			joined = true
			return identity.SessionRevocationPage{}, ctx.Err()
		})
		go func() { defer close(done); registry.Poll(ctx, source) }()
		synctest.Wait()
		if calls.Load() != 1 {
			t.Fatal("feed failure caused a busy retry loop")
		}
		time.Sleep(time.Second)
		synctest.Wait()
		cancel()
		<-done
		if calls.Load() != 2 || !joined {
			t.Fatal("poller failed to cancel and join its active RPC")
		}
	})
}
