package browsersessions

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type passwordRepository struct {
	Repository
	credential       domain.LocalCredential
	loadErr          error
	loads, rotations int
	attempt          PasswordAttempt
	prepared         PasswordPreparation
}

func (r *passwordRepository) ChangePassword(ctx context.Context, attempt PasswordAttempt, prepare PreparePassword) (PasswordOutcome, error) {
	r.loads++
	if attempt.Caller.Claims().Subject != "user-1" {
		return PasswordOutcome{}, domain.ErrForbidden
	}
	if errors.Is(r.loadErr, domain.ErrNotFound) {
		return PasswordOutcome{}, domain.InvalidArgument("Local password is not available for this account")
	}
	if r.loadErr != nil {
		return PasswordOutcome{}, r.loadErr
	}
	prepared, err := prepare(ctx, r.credential, func() error { return nil })
	if err != nil || !prepared.Matched {
		return PasswordOutcome{}, err
	}
	r.rotations++
	r.attempt, r.prepared = attempt, prepared
	return PasswordOutcome{Changed: true}, nil
}

func TestBrowserPasswordPreparesAnAtomicSelfRotation(t *testing.T) {
	hash, err := testPasswordEngine(t).HashPassword(t.Context(), "current password value")
	if err != nil {
		t.Fatal(err)
	}
	r := &passwordRepository{credential: domain.LocalCredential{UserID: "user-1", PasswordHash: hash}}
	ctx := browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleUser)
	_, err = NewService(r, testPasswordEngine(t)).ChangePassword(ctx, PasswordInput{RequestID: "rotate-1", ActorPrincipalID: "user-1", UserID: "user-1", CurrentPassword: "current password value", NewPassword: "replacement password value"})
	if err != nil || r.loads != 1 || r.rotations != 1 || r.attempt.Caller == nil || r.attempt.Caller.Claims().Subject != "user-1" || r.prepared.ExpectedPasswordHash != hash || r.attempt.RequestID != "rotate-1" {
		t.Fatalf("rotation did not preserve signed authority and expected credential: %v", err)
	}
	if valid, err := testPasswordEngine(t).VerifyPassword(t.Context(), r.prepared.PasswordHash, "replacement password value"); err != nil || !valid || r.prepared.PasswordHash == hash {
		t.Fatal("rotation command did not contain a newly hashed password")
	}
}

func TestBrowserWrongCurrentPasswordIsABusinessErrorAndNeverRotates(t *testing.T) {
	hash, err := testPasswordEngine(t).HashPassword(t.Context(), "current password value")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"wrong-current", "no-local-credential", "short-new", "long-new", "different-user", "empty-current", "missing-request"} {
		t.Run(name, func(t *testing.T) {
			r := &passwordRepository{credential: domain.LocalCredential{UserID: "user-1", PasswordHash: hash}}
			input := PasswordInput{RequestID: "r", ActorPrincipalID: "user-1", UserID: "user-1", CurrentPassword: "current password value", NewPassword: "replacement password value"}
			want := domain.ErrInvalidArgument
			switch name {
			case "wrong-current":
				input.CurrentPassword = "wrong"
				want = domain.NewError("invalid_current_password", "", false)
			case "no-local-credential":
				r.loadErr = domain.ErrNotFound
			case "short-new":
				input.NewPassword = "short"
			case "long-new":
				input.NewPassword = string(make([]byte, 1025))
			case "different-user":
				input.UserID = "target"
				want = domain.ErrForbidden
			case "empty-current":
				input.CurrentPassword = ""
			case "missing-request":
				input.RequestID = ""
			}
			result, err := NewService(r, testPasswordEngine(t)).ChangePassword(browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleUser), input)
			if !errors.Is(err, want) || r.rotations != 0 || result.AccessToken != "" {
				t.Fatalf("invalid password mutation reached storage or signed out caller: %v", err)
			}
			if _, _, retryable := domain.ErrorDetails(err); retryable {
				t.Fatal("password business error must not trigger automatic retries")
			}
			if name == "different-user" && r.loads != 0 {
				t.Fatal("administrator read target user's password credential")
			}
		})
	}
}
