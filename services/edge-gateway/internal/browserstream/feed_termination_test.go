package browserstream

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

func TestFeedTerminationRetainsOnlyTheFirstCancellationCause(t *testing.T) {
	for _, first := range []string{"feed", "parent", "live", "unavailable"} {
		t.Run(first, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				parent, cancel := context.WithCancel(context.Background())
				defer cancel()
				registry := NewRegistry()
				cfg := streamConfig(streamPrincipal())
				guard, err := Start(parent, registry, cfg)
				if err != nil {
					t.Fatal(err)
				}
				defer guard.Close()
				switch first {
				case "parent":
					cancel()
				case "live":
					guard.cancel(ErrRejected)
				case "unavailable":
					guard.cancel(ErrUnavailable)
				}
				event := identity.SessionRevocation{Sequence: 7, TokenID: cfg.Original.SessionID, UserID: cfg.Original.UserID,
					OrganizationID: cfg.Original.OrganizationID, Reason: "membership_deactivated",
					TraceParent: "00-11111111111111111111111111111111-2222222222222222-01"}
				at := time.Now()
				registry.Revoke(event)
				event.Reason = "password_changed"
				event.TraceParent = "00-33333333333333333333333333333333-4444444444444444-01"
				registry.Revoke(event)
				guard.Close()
				termination, ok := guard.FeedTermination()
				if ok != (first == "feed") {
					t.Fatalf("losing feed labeled %s", first)
				}
				if ok {
					if !errors.Is(context.Cause(guard.Context()), ErrRejected) || context.Cause(guard.Context()).Error() != ErrRejected.Error() {
						t.Fatal("feed cancellation changed public error semantics")
					}
					if termination.At != at || termination.Reason != "membership_deactivated" || termination.Sequence != 7 ||
						termination.Source.TraceID().String() != "11111111111111111111111111111111" || termination.Source.SpanID().String() != "2222222222222222" {
						t.Fatal("first feed receipt changed")
					}
					termination.Reason = "changed copy"
					again, _ := guard.FeedTermination()
					if again.Reason != "membership_deactivated" {
						t.Fatal("mutable cancellation receipt")
					}
				}
				if len(registry.sessions) != 0 {
					t.Fatal("finished stream remained registered")
				}
			})
		})
	}
}
