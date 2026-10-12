package localauth

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type resourcePasswords struct {
	hashErr, verifyErr    error
	hashes, verifications int
	match                 bool
	encoded               string
	ctx                   context.Context
}

func (p *resourcePasswords) HashPassword(ctx context.Context, _ string) (string, error) {
	p.hashes++
	p.ctx = ctx
	return "dummy-hash", p.hashErr
}
func (p *resourcePasswords) VerifyPassword(ctx context.Context, encoded, _ string) (bool, error) {
	p.verifications++
	p.encoded = encoded
	p.ctx = ctx
	return p.match, p.verifyErr
}
func (*resourcePasswords) NeedsRehash(string) (bool, error) { return false, nil }

func TestPasswordResourceErrorsHaveKnownUnknownAndInactiveParity(t *testing.T) {
	for _, identity := range []string{"known", "unknown", "inactive", "missing-credential", "invalid-identity"} {
		for _, failure := range []error{domain.ErrCredentialBusy, context.Canceled} {
			t.Run(identity+"/"+failure.Error(), func(t *testing.T) {
				repository := &authRepositoryStub{credential: LocalCredential{PasswordHash: "stored-hash", Principal: activePrincipal()}}
				input := LoginInput{OrganizationSlug: "engineering", Email: "alice@example.com", Password: "password value"}
				wantEncoded := "dummy-hash"
				switch identity {
				case "known":
					wantEncoded = "stored-hash"
				case "unknown":
					repository.lookupErr = domain.ErrNotFound
				case "inactive":
					repository.credential.Principal.Active = false
				case "missing-credential":
					repository.credential.PasswordHash = ""
				case "invalid-identity":
					input.Email = "invalid"
				}
				passwords := &resourcePasswords{verifyErr: failure}
				service, err := NewService(t.Context(), repository, sequentialIDs(), fixedNow, time.Hour, passwords)
				if err != nil {
					t.Fatal(err)
				}
				result, err := service.Login(t.Context(), input)
				if !errors.Is(err, failure) || result.AccessToken != "" || repository.issued.TokenHash != "" || passwords.hashes != 1 || passwords.verifications != 1 || passwords.encoded != wantEncoded || passwords.ctx != t.Context() {
					t.Fatalf("password error lost identity parity: error=%v calls=%+v", err, passwords)
				}
			})
		}
	}
}

func TestPasswordDummyMatchCannotIssueTokenAndStartupKeepsHashFailure(t *testing.T) {
	for _, identity := range []string{"unknown", "inactive", "missing-credential", "invalid-identity"} {
		t.Run(identity, func(t *testing.T) {
			repository := &authRepositoryStub{credential: LocalCredential{PasswordHash: "stored-hash", Principal: activePrincipal()}}
			input := LoginInput{OrganizationSlug: "engineering", Email: "missing@example.com", Password: "antnest-invalid-account-password"}
			switch identity {
			case "unknown":
				repository.lookupErr = domain.ErrNotFound
			case "inactive":
				repository.credential.Principal.Active = false
			case "missing-credential":
				repository.credential.PasswordHash = ""
			case "invalid-identity":
				input.Email = "invalid"
			}
			passwords := &resourcePasswords{match: true}
			service, err := NewService(t.Context(), repository, sequentialIDs(), fixedNow, time.Hour, passwords)
			if err != nil {
				t.Fatal(err)
			}
			result, err := service.Login(t.Context(), input)
			if !errors.Is(err, domain.ErrUnauthenticated) || result.AccessToken != "" || repository.issued.TokenHash != "" || passwords.verifications != 1 || passwords.encoded != "dummy-hash" {
				t.Fatalf("dummy match authenticated: error=%v calls=%+v", err, passwords)
			}
		})
	}
	for _, failure := range []error{domain.ErrCredentialBusy, context.Canceled} {
		passwords := &resourcePasswords{hashErr: failure}
		service, err := NewService(t.Context(), &authRepositoryStub{}, sequentialIDs(), fixedNow, time.Hour, passwords)
		if service != nil || !errors.Is(err, failure) || passwords.hashes != 1 || passwords.ctx != t.Context() {
			t.Fatalf("dummy startup error=%v service=%v", err, service)
		}
	}
}
