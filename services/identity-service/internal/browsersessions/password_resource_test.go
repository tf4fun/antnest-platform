package browsersessions

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type resourcePasswords struct {
	hashErr, verifyErr    error
	hashes, verifications int
	ctx                   context.Context
}

func (p *resourcePasswords) HashPassword(ctx context.Context, _ string) (string, error) {
	p.hashes++
	p.ctx = ctx
	return "", p.hashErr
}
func (p *resourcePasswords) VerifyPassword(ctx context.Context, _, _ string) (bool, error) {
	p.verifications++
	p.ctx = ctx
	return true, p.verifyErr
}
func (*resourcePasswords) NeedsRehash(string) (bool, error) { return false, nil }

func TestPasswordChangePreservesVerificationAndHashFailuresWithoutRotation(t *testing.T) {
	for _, phase := range []string{"verify", "hash"} {
		for _, failure := range []error{domain.ErrCredentialBusy, context.Canceled, errors.New("salt source failed")} {
			t.Run(phase+"/"+failure.Error(), func(t *testing.T) {
				repository := &passwordRepository{credential: domain.LocalCredential{UserID: "user-1", PasswordHash: "stored-hash"}}
				passwords := &resourcePasswords{}
				if phase == "hash" {
					passwords.hashErr = failure
				} else {
					passwords.verifyErr = failure
				}
				ctx := browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleUser)
				result, err := NewService(repository, passwords).ChangePassword(ctx, PasswordInput{RequestID: "change-1", ActorPrincipalID: "user-1", UserID: "user-1", CurrentPassword: "old password value", NewPassword: "new password value"})
				wantHashes := 0
				if phase == "hash" {
					wantHashes = 1
				}
				if !errors.Is(err, failure) || repository.rotations != 0 || result.AccessToken != "" || passwords.verifications != 1 || passwords.hashes != wantHashes || passwords.ctx != ctx {
					t.Fatalf("password change lost resource failure or rotated: %v", err)
				}
			})
		}
	}
}
