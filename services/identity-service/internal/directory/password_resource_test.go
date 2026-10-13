package directory

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type resourcePasswords struct {
	failure error
	hashes  int
	ctx     context.Context
}

func (p *resourcePasswords) HashPassword(ctx context.Context, _ string) (string, error) {
	p.hashes++
	p.ctx = ctx
	return "", p.failure
}
func (*resourcePasswords) VerifyPassword(context.Context, string, string) (bool, error) {
	panic("unexpected verification")
}
func (*resourcePasswords) NeedsRehash(string) (bool, error) { return false, nil }

func TestPasswordCreateUserPreservesResourceAndInternalFailures(t *testing.T) {
	for _, failure := range []error{domain.ErrCredentialBusy, context.Canceled, errors.New("salt source failed"), domain.ErrInvalidArgument} {
		t.Run(failure.Error(), func(t *testing.T) {
			repository := &directoryRepositoryStub{principal: domain.Principal{UserID: "admin", OrganizationID: "org-1", OrganizationRole: domain.OrganizationRoleAdmin, Active: true}}
			passwords := &resourcePasswords{failure: failure}
			service := NewService(repository, sequentialIDs(), fixedNow, passwords)
			result, err := service.CreateLocalUser(t.Context(), CreateLocalUserInput{RequestID: "create-1", ActorPrincipalID: "admin", OrganizationID: "org-1", Email: "alice@example.com", DisplayName: "Alice", Password: "password value", Role: domain.OrganizationRoleMember})
			if !errors.Is(err, failure) || repository.created.Credential.PasswordHash != "" || result.User.ID != "" || passwords.hashes != 1 || passwords.ctx != t.Context() {
				t.Fatalf("create-user changed password error or wrote credential: %v", err)
			}
		})
	}
}
