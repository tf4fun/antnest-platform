package browserstream

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func streamPrincipal() identity.Principal {
	now := time.Now()
	return identity.Principal{UserID: "user", OrganizationID: "org", MembershipID: "member", SessionID: "private-sid", Active: true,
		SystemRole: "user", OrganizationRole: "admin", CallerContext: "original-context", ContextExpiresAt: now.Add(time.Hour),
		ExpiresAt: now.Add(time.Hour), IdleExpiresAt: now.Add(time.Minute), ActivityIntervalMS: 10}
}

func streamConfig(principal identity.Principal) Config {
	return Config{MaximumStale: 90 * time.Millisecond, InitialStarted: time.Now(), Original: principal,
		Resolve: func(context.Context) (identity.Principal, error) { return principal, nil }}
}

func TestInitialReplyMustFitReturnedHintAndStaleBudget(t *testing.T) {
	for _, elapsed := range []time.Duration{10*time.Millisecond + time.Nanosecond, 31 * time.Millisecond} {
		t.Run(elapsed.String(), func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				cfg := streamConfig(streamPrincipal())
				cfg.InitialStarted = time.Now().Add(-elapsed)
				guard, err := Start(context.Background(), NewRegistry(), cfg)
				if guard != nil {
					guard.Close()
					t.Fatal("late initial reply admitted a stream")
				}
				if !errors.Is(err, ErrUnavailable) {
					t.Fatalf("initial rejection=%v", err)
				}
			})
		})
	}
}

func TestSilentStreamRevalidatesOriginalAuthority(t *testing.T) {
	for _, field := range []string{"sid", "user", "organization", "membership", "system-role", "organization-role", "inactive", "idle", "absolute", "hint", "revoked", "dependency"} {
		t.Run(field, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				original := streamPrincipal()
				cfg := streamConfig(original)
				calls := 0
				cfg.Resolve = func(ctx context.Context) (identity.Principal, error) {
					calls++
					deadline, ok := ctx.Deadline()
					if !ok || time.Until(deadline) > 10*time.Millisecond {
						t.Error("live check exceeded hint budget")
					}
					current := original
					switch field {
					case "sid":
						current.SessionID = "replacement"
					case "user":
						current.UserID = "other"
					case "organization":
						current.OrganizationID = "other"
					case "membership":
						current.MembershipID = "other"
					case "system-role":
						current.SystemRole = "admin"
					case "organization-role":
						current.OrganizationRole = "member"
					case "inactive":
						current.Active = false
					case "idle":
						current.IdleExpiresAt = time.Now()
					case "absolute":
						current.ExpiresAt = original.ExpiresAt.Add(time.Second)
					case "hint":
						current.ActivityIntervalMS = 0
					case "revoked":
						return identity.Principal{}, &identity.RemoteError{Code: "unauthenticated"}
					case "dependency":
						return identity.Principal{}, errors.New("dependency unavailable")
					}
					return current, nil
				}
				guard, err := Start(context.Background(), NewRegistry(), cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer guard.Close()
				time.Sleep(11 * time.Millisecond)
				synctest.Wait()
				if guard.Context().Err() == nil || calls != 1 {
					t.Fatalf("silent stream kept invalid authority: calls=%d", calls)
				}
			})
		})
	}
}

func TestCheckTimeoutStopsOutputBeforeJoiningSlowResolver(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		cfg := streamConfig(streamPrincipal())
		started := time.Now()
		calls := 0
		release := make(chan struct{})
		cfg.Resolve = func(context.Context) (identity.Principal, error) {
			calls++
			if calls == 1 {
				time.Sleep(5 * time.Millisecond)
			} else {
				// Even a resolver that delays its cancellation cleanup cannot
				// move the independent cancellation deadline for browser output.
				<-release
			}
			return cfg.Original, nil
		}
		guard, err := Start(context.Background(), NewRegistry(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(30 * time.Millisecond) // second check began at 20ms, with a 10ms RPC budget
		synctest.Wait()
		if guard.Context().Err() == nil {
			t.Error("expired RPC kept browser output alive while resolver cleanup waited")
		}
		if time.Since(started) != 30*time.Millisecond {
			t.Fatal("unexpected deadline")
		}
		joined := make(chan struct{})
		go func() { guard.Close(); close(joined) }()
		synctest.Wait()
		select {
		case <-joined:
			t.Error("guard did not join its resolver")
		default:
		}
		close(release)
		<-joined
	})
}

func TestLiveIdleObservationCanExtendButOriginalAbsoluteCapCannot(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		principal := streamPrincipal()
		principal.ExpiresAt = time.Now().Add(100 * time.Millisecond)
		principal.IdleExpiresAt = time.Now().Add(15 * time.Millisecond)
		principal.ContextExpiresAt = time.Now().Add(80 * time.Millisecond)
		principal.ActivityIntervalMS = 5
		cfg := streamConfig(principal)
		cfg.Resolve = func(context.Context) (identity.Principal, error) {
			current := principal
			current.IdleExpiresAt = time.Now().Add(15 * time.Millisecond)
			if current.IdleExpiresAt.After(current.ExpiresAt) {
				current.IdleExpiresAt = current.ExpiresAt
			}
			current.ContextExpiresAt = time.Now().Add(time.Hour)
			return current, nil
		}
		guard, err := Start(context.Background(), NewRegistry(), cfg)
		if err != nil {
			t.Fatal(err)
		}
		defer guard.Close()
		time.Sleep(20 * time.Millisecond)
		synctest.Wait()
		if guard.Context().Err() != nil {
			t.Fatal("old idle observation became a permanent deadline")
		}
		time.Sleep(50 * time.Millisecond)
		synctest.Wait()
		if guard.Context().Err() == nil {
			t.Fatal("live checks extended the original absolute hard cap")
		}
	})
}

func TestCloseCancelsAndJoinsLiveCheckAndRemovesRegistryEntry(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		registry := NewRegistry()
		cfg := streamConfig(streamPrincipal())
		joined := false
		cfg.Resolve = func(ctx context.Context) (identity.Principal, error) {
			<-ctx.Done()
			joined = true
			return identity.Principal{}, ctx.Err()
		}
		guard, err := Start(context.Background(), registry, cfg)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(11 * time.Millisecond)
		guard.Close()
		if !joined || len(registry.sessions) != 0 {
			t.Fatal("guard left worker or SID registry entry behind")
		}
	})
}
