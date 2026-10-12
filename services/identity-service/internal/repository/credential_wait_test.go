package repository

import (
	"context"
	"errors"
	"testing"
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
