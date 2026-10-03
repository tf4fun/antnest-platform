package e2e

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestCallerContextSessionUsesLiveDatabaseFacts(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	fixture := newLocalAdmissionFixture(t, databaseURL, time.Now)
	auth, err := localauth.NewService(fixture.store.LocalAuth(), fixture.newID, time.Now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	login, err := auth.Login(t.Context(), localauth.LoginInput{RequestID: "cct-session", OrganizationSlug: fixture.admin.Organization.Slug, Email: "member@example.com", Password: "correct horse battery staple"})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	session, err := fixture.store.LocalAuth().ResolveTokenSession(t.Context(), credentials.HashToken(login.AccessToken), now)
	if err != nil || session.ID != login.TokenID || session.Principal != login.Principal || session.ExpiresAt.UnixMicro() != login.ExpiresAt.UnixMicro() {
		t.Fatalf("resolved session disagrees with login: %+v error=%v", session, err)
	}
	byID, err := fixture.store.LocalAuth().ResolveSession(t.Context(), session.ID, now)
	if err != nil || byID != session {
		t.Fatalf("durable SID lookup mismatch: %+v error=%v", byID, err)
	}
	if _, err := fixture.pool.Exec(t.Context(), `UPDATE organization_memberships SET active = FALSE WHERE id = $1`, session.Principal.MembershipID); err != nil {
		t.Fatal(err)
	}
	inactive, err := fixture.store.LocalAuth().ResolveSession(t.Context(), session.ID, now)
	if err != nil || inactive.Principal.Active {
		t.Fatalf("inactive membership remained active: %+v error=%v", inactive, err)
	}
	if _, err := auth.RevokeByAccessToken(t.Context(), login.AccessToken); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.store.LocalAuth().ResolveSession(t.Context(), session.ID, now); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("revoked SID accepted: %v", err)
	}
}

func TestSCIMRevocationChecksStoredTargetAgainstCallerScope(t *testing.T) {
	f := revocationFixture(t)
	service, err := scim.NewService(scim.Config{Repository: f.store.SCIM(), NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	issued, err := service.IssueToken(t.Context(), scim.IssueTokenInput{RequestID: "scope-test", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, Name: "scope-test", Scopes: []string{domain.SCIMScopeWrite}})
	if err != nil {
		t.Fatal(err)
	}
	wrong := domain.WithCallerOrganization(t.Context(), "different-organization")
	if err := service.RevokeToken(wrong, f.admin.User.ID, issued.Token.ID); err == nil {
		t.Fatal("cross-organization CCT revoked the stored SCIM target")
	}
	if _, err := service.Authorize(t.Context(), issued.Credential, domain.SCIMScopeWrite); err != nil {
		t.Fatal("rejected scope changed the token")
	}
	correct := domain.WithCallerOrganization(t.Context(), f.admin.Organization.ID)
	if err := service.RevokeToken(correct, f.admin.User.ID, issued.Token.ID); err != nil {
		t.Fatal(err)
	}
}
