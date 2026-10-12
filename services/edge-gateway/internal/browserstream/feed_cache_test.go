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

type cacheFeedObserver struct {
	apply func(identity.SessionRevocation)
	proof func(time.Time)
}

func (observer cacheFeedObserver) ApplySessionRevocation(event identity.SessionRevocation) {
	observer.apply(event)
}

func (observer cacheFeedObserver) SessionFeedCaughtUp(started time.Time) {
	observer.proof(started)
}

func TestCacheFeedProofRequiresAppliedTerminalPageAndUsesRPCStart(t *testing.T) {
	for _, scenario := range []struct {
		name          string
		fullPages     int
		terminalCount int
	}{
		{"empty-first", 0, 0}, {"short-first", 0, 2}, {"short-fourth", 3, 2}, {"four-full", 4, 0},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				registry := NewRegistry()
				cfg := streamConfig(streamPrincipal())
				cfg.MaximumStale = 30 * time.Second
				cfg.Original.ActivityIntervalMS = 1000
				guard, err := Start(ctx, registry, cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer guard.Close()
				var mu sync.Mutex
				var starts, proofs []time.Time
				applied := 0
				source := feedFunc(func(ctx context.Context, after int64, limit int) (identity.SessionRevocationPage, error) {
					mu.Lock()
					starts = append(starts, time.Now())
					call := len(starts)
					mu.Unlock()
					count := scenario.terminalCount
					if call <= scenario.fullPages {
						count = 500
					}
					time.Sleep(100 * time.Millisecond)
					return cacheFeedPage(after, count, cfg.Original), nil
				})
				observer := cacheFeedObserver{
					apply: func(event identity.SessionRevocation) {
						if guard.Context().Err() == nil {
							t.Error("cache application preceded the matching stream's revocation")
						}
						mu.Lock()
						applied++
						mu.Unlock()
					},
					proof: func(started time.Time) {
						mu.Lock()
						defer mu.Unlock()
						if applied != 500*scenario.fullPages+scenario.terminalCount {
							t.Error("terminal proof published before every event was applied")
						}
						proofs = append(proofs, started)
					},
				}
				done := make(chan struct{})
				go func() { defer close(done); registry.Poll(ctx, source, observer) }()
				defer func() { cancel(); <-done }()
				synctest.Wait()
				time.Sleep(400 * time.Millisecond)
				synctest.Wait()
				mu.Lock()
				defer mu.Unlock()
				if scenario.fullPages == 4 {
					if len(starts) != 4 || len(proofs) != 0 || applied != 2000 {
						t.Fatalf("four full pages claimed catch-up: calls=%d proofs=%d applied=%d", len(starts), len(proofs), applied)
					}
				} else if len(starts) != scenario.fullPages+1 || len(proofs) != 1 || !proofs[0].Equal(starts[len(starts)-1]) || !proofs[0].Before(time.Now()) {
					t.Fatalf("terminal-page proof missing or anchored to completion: starts=%v proofs=%v", starts, proofs)
				}
			})
		})
	}
}

func TestCacheFeedNeverProvesFailedCancelledOrPartiallyAppliedPage(t *testing.T) {
	for _, scenario := range []string{"failed", "malformed", "late-response", "cancel-during-application"} {
		t.Run(scenario, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				registry := NewRegistry()
				var mu sync.Mutex
				calls, proofs, applied := 0, 0, 0
				source := feedFunc(func(callCtx context.Context, after int64, limit int) (identity.SessionRevocationPage, error) {
					mu.Lock()
					calls++
					mu.Unlock()
					if after != 0 {
						t.Error("failed or cancelled page advanced its cursor")
					}
					switch scenario {
					case "failed", "malformed":
						// The Identity client rejects malformed wire pages before
						// exposing them through the validated FeedSource interface.
						return identity.SessionRevocationPage{}, errors.New(scenario)
					case "late-response":
						<-callCtx.Done()
						return cacheFeedPage(after, 0, streamPrincipal()), nil
					default:
						return cacheFeedPage(after, 2, streamPrincipal()), nil
					}
				})
				observer := cacheFeedObserver{
					apply: func(identity.SessionRevocation) { mu.Lock(); applied++; mu.Unlock(); cancel() },
					proof: func(time.Time) { mu.Lock(); proofs++; mu.Unlock() },
				}
				done := make(chan struct{})
				go func() { defer close(done); registry.Poll(ctx, source, observer) }()
				defer func() { cancel(); <-done }()
				synctest.Wait()
				if scenario == "late-response" {
					time.Sleep(5 * time.Second)
					synctest.Wait()
				}
				mu.Lock()
				defer mu.Unlock()
				if calls != 1 || proofs != 0 || scenario == "cancel-during-application" && applied != 1 {
					t.Fatalf("unusable feed page proved catch-up: calls=%d proofs=%d applied=%d", calls, proofs, applied)
				}
			})
		})
	}
}

func cacheFeedPage(after int64, count int, principal identity.Principal) identity.SessionRevocationPage {
	page := identity.SessionRevocationPage{Events: make([]identity.SessionRevocation, count), NextSequence: after + int64(count)}
	for index := range page.Events {
		page.Events[index] = identity.SessionRevocation{Sequence: after + int64(index) + 1, TokenID: principal.SessionID,
			UserID: principal.UserID, OrganizationID: principal.OrganizationID, Reason: "session_revoked", OccurredAt: time.Now()}
	}
	return page
}
