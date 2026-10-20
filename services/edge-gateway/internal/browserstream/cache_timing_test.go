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

func TestInitialResolveProvenanceSeparatesSnapshotAgeAndRPCLatency(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		valid bool
	}{
		{"valid-old-hit", true}, {"valid-live", true}, {"valid-shared", true}, {"legacy-direct", true},
		{"hit-without-provenance", false}, {"missing-start", false}, {"missing-completion", false}, {"missing-validity", false},
		{"future-start", false}, {"future-completion", false}, {"completion-before-start", false}, {"expired-reuse", false},
		{"past-stale-bound", false}, {"slow-live-rpc", false}, {"slow-hit-invocation", false}, {"reuse-beyond-idle", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				now := time.Now()
				principal := streamPrincipal()
				principal.ResolveStartedAt, principal.ResolveCompletedAt = now.Add(-20*time.Millisecond), now.Add(-19*time.Millisecond)
				principal.ResolveValidUntil, principal.ResolveCacheHit = now.Add(30*time.Millisecond), true
				cfg := streamConfig(principal)
				switch scenario.name {
				case "valid-live":
					principal.ResolveCacheHit = false
					principal.ResolveStartedAt, principal.ResolveCompletedAt = now, now
				case "valid-shared":
					principal.ResolveCacheHit = false
					principal.ResolveStartedAt, principal.ResolveCompletedAt = now.Add(-15*time.Millisecond), now.Add(-5*time.Millisecond)
					cfg.InitialStarted = now.Add(-8 * time.Millisecond)
				case "legacy-direct", "hit-without-provenance":
					principal.ResolveStartedAt, principal.ResolveCompletedAt, principal.ResolveValidUntil = time.Time{}, time.Time{}, time.Time{}
					principal.ResolveCacheHit = scenario.name == "hit-without-provenance"
				case "missing-start":
					principal.ResolveStartedAt = time.Time{}
				case "missing-completion":
					principal.ResolveCompletedAt = time.Time{}
				case "missing-validity":
					principal.ResolveValidUntil = time.Time{}
				case "future-start":
					principal.ResolveStartedAt = now.Add(time.Nanosecond)
				case "future-completion":
					principal.ResolveCompletedAt = now.Add(time.Nanosecond)
				case "completion-before-start":
					principal.ResolveCompletedAt = principal.ResolveStartedAt.Add(-time.Nanosecond)
				case "expired-reuse":
					principal.ResolveValidUntil = now
				case "past-stale-bound":
					principal.ResolveStartedAt, principal.ResolveCompletedAt = now.Add(-60*time.Millisecond), now.Add(-59*time.Millisecond)
				case "slow-live-rpc":
					principal.ResolveCacheHit = false
					principal.ResolveCompletedAt = now.Add(-5 * time.Millisecond)
					cfg.InitialStarted = now.Add(-8 * time.Millisecond)
				case "slow-hit-invocation":
					cfg.InitialStarted = now.Add(-11 * time.Millisecond)
				case "reuse-beyond-idle":
					principal.ResolveValidUntil = principal.IdleExpiresAt.Add(time.Nanosecond)
				}
				cfg.Original = principal
				guard, err := Start(context.Background(), NewRegistry(), cfg)
				if guard != nil {
					guard.Close()
				}
				if scenario.valid != (err == nil) {
					t.Fatalf("snapshot/probe timing admission valid=%v err=%v", scenario.valid, err)
				}
			})
		})
	}
}

func TestPeriodicCacheHitExpiringDuringDeliveryRechecksWithinOriginalProbe(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		probeOrigin := time.Now()
		// Real RPC work begins after the invocation. At the first ten-second
		// poll the cache lookup still has one millisecond of valid reuse.
		time.Sleep(time.Millisecond)
		principal := streamPrincipal()
		principal.ActivityIntervalMS = 30_000
		principal.ResolveStartedAt, principal.ResolveCompletedAt = time.Now(), time.Now()
		principal.ResolveValidUntil = time.Now().Add(10 * time.Second)
		cfg := Config{MaximumStale: 30 * time.Second, InitialStarted: probeOrigin, Original: principal}
		calls := 0
		var deadlines []time.Time
		cfg.Resolve = func(ctx context.Context) (identity.Principal, error) {
			calls++
			deadline, ok := ctx.Deadline()
			if !ok {
				t.Error("periodic check lost its deadline")
			}
			deadlines = append(deadlines, deadline)
			current := principal
			if calls == 1 {
				if !current.ResolveValidUntil.After(time.Now()) {
					t.Error("fixture did not begin with a legal cache hit")
				}
				current.ResolveCacheHit = true
				time.Sleep(2 * time.Millisecond)
			} else {
				current.ResolveStartedAt, current.ResolveCompletedAt = time.Now(), time.Now()
				current.ResolveValidUntil = time.Now().Add(10 * time.Second)
			}
			return current, nil
		}
		guard, err := Start(context.Background(), NewRegistry(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer guard.Close()
		time.Sleep(10*time.Second + 2*time.Millisecond)
		synctest.Wait()
		if guard.Context().Err() != nil || calls != 2 {
			t.Fatalf("healthy periodic stream lost at cache delivery expiry: calls=%d cause=%v", calls, context.Cause(guard.Context()))
		}
		if !deadlines[0].Equal(deadlines[1]) || !deadlines[0].Equal(probeOrigin.Add(20*time.Second)) {
			t.Fatalf("recheck reset its original probe deadline: %v", deadlines)
		}
	})
}

func TestCachedIdleObservationTriggersFreshLookupInsteadOfPermanentClose(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		started := time.Now()
		principal := streamPrincipal()
		principal.IdleExpiresAt = started.Add(15 * time.Millisecond)
		principal.ResolveStartedAt, principal.ResolveCompletedAt = started, started
		principal.ResolveValidUntil, principal.ResolveCacheHit = principal.IdleExpiresAt, true
		cfg := streamConfig(principal)
		var probes []time.Time
		var mu sync.Mutex
		cfg.Resolve = func(context.Context) (identity.Principal, error) {
			mu.Lock()
			defer mu.Unlock()
			probes = append(probes, time.Now())
			if len(probes) == 1 {
				return principal, nil
			}
			current := principal
			current.ResolveCacheHit = false
			current.ResolveStartedAt, current.ResolveCompletedAt = time.Now(), time.Now()
			current.IdleExpiresAt = time.Now().Add(20 * time.Millisecond)
			current.ResolveValidUntil = current.IdleExpiresAt
			return current, nil
		}
		guard, err := Start(context.Background(), NewRegistry(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer guard.Close()
		time.Sleep(16 * time.Millisecond)
		synctest.Wait()
		mu.Lock()
		observed := append([]time.Time(nil), probes...)
		mu.Unlock()
		if guard.Context().Err() != nil || len(observed) != 2 || !observed[0].Equal(started.Add(10*time.Millisecond)) || !observed[1].Equal(principal.IdleExpiresAt) {
			t.Fatalf("idle observation did not schedule a fresh read at expiry: probes=%v cause=%v", observed, context.Cause(guard.Context()))
		}
		time.Sleep(15 * time.Millisecond)
		synctest.Wait()
		if guard.Context().Err() != nil {
			t.Fatal("extended idle observation inherited the old deadline as a hard cap")
		}
	})
}

func TestRepeatedCacheHitsCannotExtendAuthorityOrSpinProbes(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		principal := streamPrincipal()
		principal.ResolveStartedAt = time.Now().Add(-20 * time.Millisecond)
		principal.ResolveCompletedAt = principal.ResolveStartedAt.Add(time.Millisecond)
		principal.ResolveValidUntil, principal.ResolveCacheHit = time.Now().Add(time.Minute), true
		cfg := streamConfig(principal)
		var calls atomic.Int64
		cfg.Resolve = func(context.Context) (identity.Principal, error) {
			if calls.Add(1) > 8 {
				return identity.Principal{}, errors.New("probe spin guard")
			}
			return principal, nil
		}
		guard, err := Start(context.Background(), NewRegistry(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer guard.Close()
		time.Sleep(39 * time.Millisecond)
		synctest.Wait()
		if guard.Context().Err() != nil || calls.Load() != 3 {
			t.Fatalf("old snapshot age became a latency error or busy probe schedule: calls=%d cause=%v", calls.Load(), context.Cause(guard.Context()))
		}
		time.Sleep(time.Millisecond)
		synctest.Wait()
		if !errors.Is(context.Cause(guard.Context()), ErrUnavailable) {
			t.Fatal("hits extended the original RPC's independent stale deadline")
		}
	})
}

func TestFreshRPCAdvancesAuthorityButCannotExtendOriginalAbsoluteDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		principal := streamPrincipal()
		principal.ExpiresAt = time.Now().Add(80 * time.Millisecond)
		principal.IdleExpiresAt = principal.ExpiresAt
		principal.ResolveStartedAt, principal.ResolveCompletedAt = time.Now().Add(-20*time.Millisecond), time.Now().Add(-19*time.Millisecond)
		principal.ResolveValidUntil, principal.ResolveCacheHit = time.Now().Add(40*time.Millisecond), true
		cfg := streamConfig(principal)
		var calls atomic.Int64
		cfg.Resolve = func(context.Context) (identity.Principal, error) {
			if calls.Add(1) < 3 {
				return principal, nil
			}
			current := principal
			current.ResolveCacheHit = false
			current.ResolveStartedAt, current.ResolveCompletedAt = time.Now(), time.Now()
			current.ContextExpiresAt = time.Now().Add(time.Minute)
			current.ResolveValidUntil = principal.IdleExpiresAt
			return current, nil
		}
		guard, err := Start(context.Background(), NewRegistry(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer guard.Close()
		time.Sleep(41 * time.Millisecond)
		synctest.Wait()
		if guard.Context().Err() != nil || calls.Load() != 4 {
			t.Fatalf("actual fresh RPC did not advance authority: cause=%v calls=%d", context.Cause(guard.Context()), calls.Load())
		}
		time.Sleep(9 * time.Millisecond)
		synctest.Wait()
		if !errors.Is(context.Cause(guard.Context()), ErrRejected) {
			t.Fatal("new RPC/CCT extended the original absolute session deadline")
		}
	})
}
