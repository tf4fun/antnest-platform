package localauth

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestLocalLoginIssuesMembershipScopedToken(t *testing.T) {
	t.Parallel()

	passwordHash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash fixture password: %v", err)
	}
	repository := &authRepositoryStub{credential: LocalCredential{
		PasswordHash: passwordHash,
		Principal: domain.Principal{
			UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
			SystemRole: domain.SystemRoleUser, OrganizationRole: domain.OrganizationRoleMember, Active: true,
		},
	}}
	service, err := NewService(repository, sequentialIDs(), fixedNow, 12*time.Hour)
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	result, err := service.Login(context.Background(), LoginInput{
		RequestID: "request-1", OrganizationSlug: "engineering", Email: "Alice@Example.COM",
		Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("login: %v", err)
	}
	if result.Principal.UserID != "user-1" || result.AccessToken == "" ||
		result.ExpiresAt != fixedNow().Add(12*time.Hour) {
		t.Fatalf("login result = %#v", result)
	}
	if repository.issued.TokenHash != credentials.HashToken(result.AccessToken) ||
		repository.issued.TokenHash == result.AccessToken {
		t.Fatal("repository did not receive only the access-token hash")
	}
	if repository.issued.ExpectedPasswordHash != passwordHash || repository.issued.Principal != result.Principal {
		t.Fatal("issuance did not carry the verified credential and principal for revalidation")
	}
}

func TestLocalLoginCollapsesUnknownWrongAndInactiveAccounts(t *testing.T) {
	t.Parallel()

	passwordHash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hash fixture password: %v", err)
	}
	tests := []struct {
		name       string
		credential LocalCredential
		lookupErr  error
		password   string
	}{
		{name: "unknown", lookupErr: domain.ErrNotFound, password: "some password value"},
		{name: "wrong", credential: LocalCredential{PasswordHash: passwordHash, Principal: activePrincipal()}, password: "wrong password value"},
		{name: "inactive", credential: LocalCredential{PasswordHash: passwordHash, Principal: domain.Principal{Active: false}}, password: "correct horse battery staple"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := &authRepositoryStub{credential: test.credential, lookupErr: test.lookupErr}
			service, err := NewService(repository, sequentialIDs(), fixedNow, time.Hour)
			if err != nil {
				t.Fatalf("new auth service: %v", err)
			}
			_, err = service.Login(context.Background(), LoginInput{
				RequestID: "request", OrganizationSlug: "engineering", Email: "alice@example.com", Password: test.password,
			})
			if !errors.Is(err, domain.ErrUnauthenticated) {
				t.Fatalf("login error = %v, want unauthenticated", err)
			}
			if repository.issued.TokenHash != "" {
				t.Fatal("failed login issued a token")
			}
		})
	}
}

func TestResolveHashesRawCredential(t *testing.T) {
	t.Parallel()

	repository := &authRepositoryStub{resolved: activePrincipal()}
	service, err := NewService(repository, sequentialIDs(), fixedNow, time.Hour)
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	principal, err := service.Resolve(context.Background(), "ant_api_secret")
	if err != nil || principal.UserID != "user-1" {
		t.Fatalf("resolve = %#v, %v", principal, err)
	}
	if repository.resolvedHash != credentials.HashToken("ant_api_secret") {
		t.Fatal("repository did not receive hashed credential")
	}
}

func TestRevokeByAccessTokenIsOpaqueAndIdempotent(t *testing.T) {
	t.Parallel()

	repository := &authRepositoryStub{revokeStatus: RevokeStatusRevoked}
	service, err := NewService(repository, sequentialIDs(), fixedNow, time.Hour)
	if err != nil {
		t.Fatalf("new auth service: %v", err)
	}
	status, err := service.RevokeByAccessToken(context.Background(), "ant_api_secret")
	if err != nil || status != RevokeStatusRevoked {
		t.Fatalf("revoke status=%q err=%v", status, err)
	}
	if repository.revokedHash != credentials.HashToken("ant_api_secret") {
		t.Fatal("repository did not receive only the access-token hash")
	}

	status, err = service.RevokeByAccessToken(context.Background(), "")
	if err != nil || status != RevokeStatusAlreadyInvalid {
		t.Fatalf("empty credential status=%q err=%v", status, err)
	}
}

type authRepositoryStub struct {
	credential   LocalCredential
	lookupErr    error
	issued       IssueTokenCommand
	resolved     domain.Principal
	resolvedHash string
	revokedHash  string
	revokeStatus RevokeStatus
}

func (r *authRepositoryStub) FindLocalCredential(context.Context, string, string) (LocalCredential, error) {
	return r.credential, r.lookupErr
}

func (r *authRepositoryStub) IssueToken(_ context.Context, command IssueTokenCommand) (Token, error) {
	r.issued = command
	return Token{ID: command.TokenID, ExpiresAt: command.ExpiresAt}, nil
}

func (r *authRepositoryStub) ResolveToken(_ context.Context, digest string, _ time.Time) (domain.Principal, error) {
	r.resolvedHash = digest
	return r.resolved, nil
}

func (r *authRepositoryStub) RevokeByTokenHash(
	_ context.Context, digest string, _ time.Time,
) (RevokeStatus, error) {
	r.revokedHash = digest
	return r.revokeStatus, nil
}

func activePrincipal() domain.Principal {
	return domain.Principal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
		SystemRole: domain.SystemRoleUser, OrganizationRole: domain.OrganizationRoleMember, Active: true,
	}
}

func sequentialIDs() func() string {
	next := 0
	return func() string {
		next++
		return fmt.Sprintf("id-%d", next)
	}
}

func fixedNow() time.Time { return time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC) }
