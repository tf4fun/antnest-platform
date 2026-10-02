package diagnostics

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestMessageRedactsCommonCredentialForms(t *testing.T) {
	t.Parallel()

	err := errors.New(
		"connect postgres://operator:hunter2@database/runtime?password=query-secret " +
			"token=token-secret api_key:api-secret Authorization=Bearer bearer-secret",
	)
	diagnostic := Message(err)
	for _, secret := range []string{"hunter2", "query-secret", "token-secret", "api-secret", "bearer-secret"} {
		if strings.Contains(diagnostic, secret) {
			t.Fatalf("diagnostic leaked %q: %s", secret, diagnostic)
		}
	}
	if !strings.Contains(diagnostic, "REDACTED") {
		t.Fatalf("diagnostic did not preserve a redaction marker: %s", diagnostic)
	}
}

func TestMessagesExposeSafeTypedCausesWithoutArbitraryExceptionText(t *testing.T) {
	err := fmt.Errorf("OIDC code=CODE_CANARY state=STATE_CANARY cookie=COOKIE_CANARY: %w", context.DeadlineExceeded)
	message := Message(err)
	if !strings.Contains(message, "deadline exceeded") || strings.Contains(message, "CANARY") {
		t.Fatalf("unsafe or unhelpful cause: %s", message)
	}
	for i := 0; i < 10; i++ {
		err = fmt.Errorf("secret wrapper %w", err)
	}
	if got := Causes(err); len(got) > 4 {
		t.Fatalf("cause budget = %d", len(got))
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("diagnostics changed original error")
	}
}

func TestErrorPreservesNilAndSanitizesMessage(t *testing.T) {
	t.Parallel()

	if Error(nil) != nil {
		t.Fatal("nil input must remain nil")
	}
	if got := Error(errors.New("secret=hidden")); got == nil || strings.Contains(got.Error(), "hidden") {
		t.Fatalf("sanitized error = %v", got)
	}
}

func TestPermanentClassificationIsExplicitAndRedactsCauses(t *testing.T) {
	secret := errors.New("password=PERMANENT_SECRET_CANARY")
	permanent := &permanentDiagnosticError{cause: secret}
	joined := errors.Join(context.DeadlineExceeded, fmt.Errorf("wrapped: %w", permanent))
	if !IsPermanent(joined) || IsPermanent(secret) || IsPermanent(nil) || IsPermanent(context.DeadlineExceeded) {
		t.Fatal("permanence was inferred from transient error text or lost through wrapping")
	}
	if strings.Contains(Message(joined), "PERMANENT_SECRET_CANARY") {
		t.Fatal("permanent error classification leaked an arbitrary cause")
	}
}

type permanentDiagnosticError struct{ cause error }

func (*permanentDiagnosticError) Permanent() bool { return true }
func (e *permanentDiagnosticError) Error() string { return e.cause.Error() }
func (e *permanentDiagnosticError) Unwrap() error { return e.cause }
