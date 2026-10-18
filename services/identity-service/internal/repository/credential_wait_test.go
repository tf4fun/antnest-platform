package repository

import (
	"context"
	"errors"
	"testing"
	"testing/synctest"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestCredentialWaitBudgetIsSharedAndOriginalCancellationIsPreserved(t *testing.T) {
	budget := &credentialWaitBudget{remaining: 50 * time.Millisecond}
	if err := budget.wait(t.Context(), func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}); !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("database admission timeout was not busy: %v", err)
	}
	called := false
	if err := budget.wait(t.Context(), func(context.Context) error { called = true; return nil }); called || !errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("exhausted admission restarted its budget: called=%t error=%v", called, err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := budget.wait(ctx, func(context.Context) error { called = true; return nil }); called || !errors.Is(err, context.Canceled) {
		t.Fatalf("caller cancellation became busy: called=%t error=%v", called, err)
	}
}

func TestCredentialWaitBudgetOnlyChargesDatabaseOperations(t *testing.T) {
	budget := &credentialWaitBudget{remaining: time.Second}
	for n := 0; n < 2; n++ {
		before := budget.remaining
		if err := budget.wait(t.Context(), func(ctx context.Context) error {
			if _, ok := ctx.Deadline(); !ok {
				t.Error("database operation has no bounded deadline")
			}
			return nil
		}); err != nil || budget.remaining >= before {
			t.Fatalf("database operation was not charged: remaining=%s error=%v", budget.remaining, err)
		}
	}
	remaining := budget.remaining
	// Argon2 receives the original context. Time outside database operations
	// must not turn a valid, slow KDF result into a synthetic database timeout.
	time.Sleep(5 * time.Millisecond)
	if budget.remaining != remaining {
		t.Fatal("KDF time consumed the database wait allowance")
	}
}

type credentialDeadlineSetupDelay struct {
	context.Context
}

func (ctx credentialDeadlineSetupDelay) Deadline() (time.Time, bool) {
	// Model a scheduling pause after WithTimeout calculates its deadline but
	// before wait records the operation start. Synctest advances a virtual clock.
	time.Sleep(100 * time.Millisecond)
	return ctx.Context.Deadline()
}

func TestCredentialWaitBudgetTimeoutDuringSetupCannotRestart(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		budget := &credentialWaitBudget{remaining: 50 * time.Millisecond}
		ctx := credentialDeadlineSetupDelay{Context: t.Context()}
		if err := budget.wait(ctx, func(bounded context.Context) error {
			return bounded.Err()
		}); !errors.Is(err, domain.ErrCredentialBusy) {
			t.Fatalf("expired database admission was not busy: %v", err)
		}
		if budget.remaining > 0 {
			t.Errorf("expired database admission retained %s", budget.remaining)
		}
		called := false
		if err := budget.wait(t.Context(), func(context.Context) error { called = true; return nil }); called || !errors.Is(err, domain.ErrCredentialBusy) {
			t.Fatalf("expired admission restarted: called=%t error=%v", called, err)
		}
	})
}

func TestCredentialWaitBudgetPreservesCancellationDuringOperation(t *testing.T) {
	budget := &credentialWaitBudget{remaining: time.Second}
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	err := budget.wait(ctx, func(context.Context) error {
		cancel()
		return errors.New("database operation interrupted")
	})
	if !errors.Is(err, context.Canceled) || errors.Is(err, domain.ErrCredentialBusy) {
		t.Fatalf("original cancellation was replaced: %v", err)
	}
}
