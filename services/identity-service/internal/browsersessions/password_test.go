package browsersessions

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type passwordRepository struct {
	Repository
	credential       domain.LocalCredential
	loadErr          error
	loads, rotations int
	command          PasswordCommand
}

func (r *passwordRepository) GetLocalCredential(_ context.Context, user string) (domain.LocalCredential, error) {
	r.loads++
	if user != "user-1" {
		return domain.LocalCredential{}, domain.ErrForbidden
	}
	return r.credential, r.loadErr
}
func (r *passwordRepository) ChangePassword(_ context.Context, command PasswordCommand) (PasswordResult, error) {
	r.rotations++
	r.command = command
	return PasswordResult{}, nil
}

func TestBrowserPasswordPreparesAnAtomicSelfRotation(t *testing.T) {
	hash, err := credentials.HashPassword("current password value")
	if err != nil {
		t.Fatal(err)
	}
	r := &passwordRepository{credential: domain.LocalCredential{UserID: "user-1", PasswordHash: hash}}
	ctx := browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleUser)
	_, err = NewService(r).ChangePassword(ctx, PasswordInput{RequestID: "rotate-1", ActorPrincipalID: "user-1", UserID: "user-1", CurrentPassword: "current password value", NewPassword: "replacement password value"})
	if err != nil || r.loads != 1 || r.rotations != 1 || r.command.Caller == nil || r.command.Caller.Claims().Subject != "user-1" || r.command.ExpectedPasswordHash != hash || r.command.RequestID != "rotate-1" {
		t.Fatalf("rotation did not preserve signed authority and expected credential: %v", err)
	}
	if valid, err := credentials.VerifyPassword(r.command.PasswordHash, "replacement password value"); err != nil || !valid || r.command.PasswordHash == hash {
		t.Fatal("rotation command did not contain a newly hashed password")
	}
}

func TestBrowserWrongCurrentPasswordIsABusinessErrorAndNeverRotates(t *testing.T) {
	hash, err := credentials.HashPassword("current password value")
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"wrong-current", "no-local-credential", "short-new", "different-user", "empty-current", "missing-request"} {
		t.Run(name, func(t *testing.T) {
			r := &passwordRepository{credential: domain.LocalCredential{UserID: "user-1", PasswordHash: hash}}
			input := PasswordInput{RequestID: "r", ActorPrincipalID: "user-1", UserID: "user-1", CurrentPassword: "current password value", NewPassword: "replacement password value"}
			want := domain.ErrInvalidArgument
			switch name {
			case "wrong-current":
				input.CurrentPassword = "wrong"
			case "no-local-credential":
				r.loadErr = domain.ErrNotFound
			case "short-new":
				input.NewPassword = "short"
			case "different-user":
				input.UserID = "target"
				want = domain.ErrForbidden
			case "empty-current":
				input.CurrentPassword = ""
			case "missing-request":
				input.RequestID = ""
			}
			result, err := NewService(r).ChangePassword(browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleUser), input)
			if !errors.Is(err, want) || r.rotations != 0 || result.AccessToken != "" {
				t.Fatalf("invalid password mutation reached storage or signed out caller: %v", err)
			}
			if name == "different-user" && r.loads != 0 {
				t.Fatal("administrator read target user's password credential")
			}
		})
	}
}
