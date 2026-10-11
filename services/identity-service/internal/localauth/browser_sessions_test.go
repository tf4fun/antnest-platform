package localauth

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type browserAuthRepository struct {
	authRepositoryStub
	token Token
}

func (r *browserAuthRepository) IssueToken(_ context.Context, command IssueTokenCommand) (Token, error) {
	r.issued = command
	return r.token, nil
}

func TestBrowserLoginReturnsPersistedDeadlinesAndForwardsDisplayHint(t *testing.T) {
	hash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	repository := &browserAuthRepository{
		authRepositoryStub: authRepositoryStub{credential: LocalCredential{PasswordHash: hash, Principal: activePrincipal()}},
		token:              Token{ID: "stored-id", ExpiresAt: fixedNow().Add(57 * time.Minute), IdleExpiresAt: fixedNow().Add(5 * time.Second), ActivityIntervalMS: 1666},
	}
	service, err := NewService(repository, sequentialIDs(), fixedNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Login(t.Context(), LoginInput{
		OrganizationSlug: "engineering", Email: "alice@example.com", Password: "correct horse battery staple", UserAgentHint: strings.Repeat("界", 256),
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.TokenID != repository.token.ID || result.ExpiresAt != repository.token.ExpiresAt || result.IdleExpiresAt != repository.token.IdleExpiresAt || result.ActivityIntervalMS != repository.token.ActivityIntervalMS {
		t.Fatal("login did not forward the authoritative persisted session metadata")
	}
	if repository.issued.UserAgentHint != strings.Repeat("界", 256) {
		t.Fatal("login lost the bounded Unicode display hint")
	}
	if repository.issued.TokenHash != credentials.HashToken(result.AccessToken) {
		t.Fatal("persisted credential hash does not match the issued secret")
	}
}

func TestBrowserLoginRejectsOversizedDisplayHintWithoutIssuance(t *testing.T) {
	hash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	repository := &authRepositoryStub{credential: LocalCredential{PasswordHash: hash, Principal: activePrincipal()}}
	service, err := NewService(repository, sequentialIDs(), fixedNow, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	_, err = service.Login(t.Context(), LoginInput{OrganizationSlug: "engineering", Email: "alice@example.com", Password: "correct horse battery staple", UserAgentHint: strings.Repeat("界", 257)})
	if code, _, _ := domain.ErrorDetails(err); code != "invalid_argument" {
		t.Fatalf("oversized hint error = %v, want invalid_argument", err)
	}
	if repository.issued.TokenID != "" {
		t.Fatal("oversized hint issued a credential")
	}
}
