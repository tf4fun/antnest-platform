package diagnostics

import (
	"errors"
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

func TestErrorPreservesNilAndSanitizesMessage(t *testing.T) {
	t.Parallel()

	if Error(nil) != nil {
		t.Fatal("nil input must remain nil")
	}
	if got := Error(errors.New("secret=hidden")); got == nil || strings.Contains(got.Error(), "hidden") {
		t.Fatalf("sanitized error = %v", got)
	}
}
