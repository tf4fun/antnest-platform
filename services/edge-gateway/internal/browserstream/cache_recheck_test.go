package browserstream

import (
	"context"
	"errors"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func periodicExpiryConfig() Config {
	started := time.Now()
	time.Sleep(time.Millisecond)
	principal := streamPrincipal()
	principal.ActivityIntervalMS = 30_000
	principal.ResolveStartedAt, principal.ResolveCompletedAt = time.Now(), time.Now()
	principal.ResolveValidUntil = time.Now().Add(10 * time.Second)
	return Config{MaximumStale: 30 * time.Second, InitialStarted: started, Original: principal}
}

func TestPeriodicExpiredHitCannotRecheckOtherInvalidAuthority(t *testing.T) {
	for _, scenario := range []string{
		"live", "revoked", "dependency", "sid", "role", "inactive", "missing-start", "missing-completion",
		"missing-validity", "completion-after-probe", "already-expired", "idle", "absolute", "cct", "stale", "reply-budget", "probe-deadline",
	} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cfg := periodicExpiryConfig()
				calls := 0
				cfg.Resolve = func(context.Context) (identity.Principal, error) {
					calls++
					probeStarted := time.Now()
					time.Sleep(2 * time.Millisecond)
					current := cfg.Original
					current.ResolveCacheHit = true
					switch scenario {
					case "live":
						current.ResolveCacheHit = false
					case "revoked":
						return identity.Principal{}, &identity.RemoteError{Code: "unauthenticated"}
					case "dependency":
						return identity.Principal{}, errors.New("unavailable")
					case "sid":
						current.SessionID = "changed"
					case "role":
						current.OrganizationRole = "member"
					case "inactive":
						current.Active = false
					case "missing-start":
						current.ResolveStartedAt = time.Time{}
					case "missing-completion":
						current.ResolveCompletedAt = time.Time{}
					case "missing-validity":
						current.ResolveValidUntil = time.Time{}
					case "completion-after-probe":
						current.ResolveCompletedAt = probeStarted.Add(time.Microsecond)
					case "already-expired":
						current.ResolveValidUntil = probeStarted
					case "idle":
						current.IdleExpiresAt = time.Now()
					case "absolute":
						current.ExpiresAt = time.Now()
					case "cct":
						current.ContextExpiresAt = time.Now()
					case "stale":
						current.ResolveStartedAt = time.Now().Add(-29 * time.Second)
						current.ResolveCompletedAt = current.ResolveStartedAt.Add(time.Millisecond)
					case "reply-budget":
						current.ActivityIntervalMS = 1
					case "probe-deadline":
						time.Sleep(10*time.Second - 2*time.Millisecond)
					}
					return current, nil
				}
				guard, err := Start(context.Background(), NewRegistry(), cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer guard.Close()
				time.Sleep(20 * time.Second)
				synctest.Wait()
				if guard.Context().Err() == nil || calls != 1 {
					t.Fatalf("invalid authority entered recheck: calls=%d cause=%v", calls, context.Cause(guard.Context()))
				}
			})
		})
	}
}

func TestPeriodicCacheRecheckCannotRetryItsSecondFailure(t *testing.T) {
	for _, scenario := range []string{"expired-hit", "expired-live", "dependency", "changed-role"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cfg := periodicExpiryConfig()
				calls := 0
				cfg.Resolve = func(context.Context) (identity.Principal, error) {
					calls++
					current := cfg.Original
					current.ResolveCacheHit = true
					if calls == 1 {
						time.Sleep(2 * time.Millisecond)
					} else {
						if calls > 3 {
							return identity.Principal{}, errors.New("unbounded recheck")
						}
						switch scenario {
						case "expired-live":
							current.ResolveCacheHit = false
						case "dependency":
							return identity.Principal{}, errors.New("unavailable")
						case "changed-role":
							current.SystemRole = "admin"
						}
					}
					return current, nil
				}
				guard, err := Start(context.Background(), NewRegistry(), cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer guard.Close()
				time.Sleep(10*time.Second + 3*time.Millisecond)
				synctest.Wait()
				if guard.Context().Err() == nil || calls != 2 {
					t.Fatalf("second failure was admitted or retried: calls=%d cause=%v", calls, context.Cause(guard.Context()))
				}
			})
		})
	}
}

func TestPeriodicCacheRecheckKeepsIndependentDeadlinesAndJoinsWorker(t *testing.T) {
	for _, scenario := range []string{"probe-deadline", "stale", "original-absolute", "parent-cancel"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cfg := periodicExpiryConfig()
				deadline, cause := cfg.InitialStarted.Add(20*time.Second), ErrUnavailable
				if scenario == "stale" {
					cfg.Original.ResolveStartedAt = cfg.InitialStarted.Add(-18 * time.Second)
					cfg.Original.ResolveCompletedAt = cfg.Original.ResolveStartedAt.Add(time.Millisecond)
					deadline = cfg.InitialStarted.Add(11 * time.Second)
				}
				if scenario == "original-absolute" {
					cfg.Original.ExpiresAt = cfg.InitialStarted.Add(12 * time.Second)
					cfg.Original.IdleExpiresAt = cfg.Original.ExpiresAt
					deadline, cause = cfg.InitialStarted.Add(11*time.Second), ErrRejected
				}
				parent, cancel := context.WithCancel(context.Background())
				defer cancel()
				calls := 0
				var firstContext context.Context
				release := make(chan struct{})
				var once sync.Once
				releaseWorker := func() { once.Do(func() { close(release) }) }
				cfg.Resolve = func(ctx context.Context) (identity.Principal, error) {
					calls++
					if calls == 1 {
						firstContext = ctx
						time.Sleep(2 * time.Millisecond)
						current := cfg.Original
						current.ResolveCacheHit = true
						return current, nil
					}
					if ctx != firstContext {
						t.Error("recheck replaced its original probe context")
					}
					<-release // Deliberately hold cancellation cleanup, never output.
					return identity.Principal{}, ctx.Err()
				}
				registry := NewRegistry()
				guard, err := Start(parent, registry, cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { releaseWorker(); guard.Close() }()
				time.Sleep(10*time.Second + 3*time.Millisecond)
				synctest.Wait()
				if calls != 2 || guard.Context().Err() != nil {
					t.Fatalf("recheck did not stay pending: calls=%d", calls)
				}
				if scenario == "parent-cancel" {
					cancel()
					cause = context.Canceled
				} else {
					time.Sleep(time.Until(deadline))
				}
				synctest.Wait()
				if !errors.Is(context.Cause(guard.Context()), cause) {
					t.Fatalf("pending recheck extended output deadline: %v", context.Cause(guard.Context()))
				}
				joined := make(chan struct{})
				go func() { guard.Close(); close(joined) }()
				synctest.Wait()
				select {
				case <-joined:
					t.Error("Close returned before joining recheck")
				default:
				}
				releaseWorker()
				<-joined
				if len(registry.sessions) != 0 || calls != 2 {
					t.Fatal("recheck leaked registry state or retried")
				}
			})
		})
	}
}
