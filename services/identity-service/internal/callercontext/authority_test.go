package callercontext

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	protocol "github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type sessionsStub struct {
	session Session
	err     error
}

func (s *sessionsStub) ResolveTokenSession(context.Context, string, time.Time) (Session, error) {
	return s.session, s.err
}

func (s *sessionsStub) ResolveSession(context.Context, string, time.Time) (Session, error) {
	return s.session, s.err
}

func newTestAuthority(t *testing.T) (*Authority, *sessionsStub, time.Time) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1800000000, 0)
	store := &sessionsStub{session: Session{ID: "session-1", ExpiresAt: now.Add(time.Hour), Principal: domain.Principal{
		UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-1", Active: true,
		SystemRole: domain.SystemRoleAdmin, OrganizationRole: domain.OrganizationRoleAdmin,
	}}}
	sequence := 0
	authority, err := NewAuthority(Config{KID: "current", PrivateKey: private,
		Keys: Keys{"current": public}, Repository: store, Now: func() time.Time { return now },
		NewID: func() string { sequence++; return time.Unix(int64(sequence), 0).Format("150405") }})
	if err != nil {
		t.Fatal(err)
	}
	return authority, store, now
}

func TestIssueUsesServerOwnedProfileAndDurableSession(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	principal, token, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if err != nil || principal != store.session.Principal {
		t.Fatalf("issuance failed: %v", err)
	}
	claims, err := protocol.Verify(token, authority.keys, protocol.Expected{Consumer: "identity-service", Organization: "org-1", Now: now, Tolerance: 30})
	if err != nil || claims.Session != "session-1" || claims.Subject != "admin" || claims.ExpiresAt-claims.IssuedAt != 60 {
		t.Fatalf("invalid issued claims: %#v error=%v", claims, err)
	}
	for _, profile := range []string{"", "identity-service", "all", " console"} {
		if _, _, err := authority.Issue(context.Background(), "ant_api_test", profile, ""); err == nil {
			t.Fatalf("caller-selected profile %q accepted", profile)
		}
	}
	_, second, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if err != nil || second == token {
		t.Fatal("issuance reused jti/token")
	}
}

func TestIdentityChecksRevocationAndLiveAuthorizationFacts(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	_, token, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := authority.VerifySession(context.Background(), token); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []func(*sessionsStub){
		func(s *sessionsStub) { s.err = domain.ErrNotFound },
		func(s *sessionsStub) { s.session.Principal.Active = false },
		func(s *sessionsStub) { s.session.Principal.UserID = "other-user" },
		func(s *sessionsStub) { s.session.Principal.OrganizationID = "other-org" },
		func(s *sessionsStub) { s.session.Principal.MembershipID = "other-membership" },
		func(s *sessionsStub) { s.session.Principal.SystemRole = domain.SystemRoleUser },
		func(s *sessionsStub) { s.session.ExpiresAt = now },
	} {
		saved := *store
		mutation(store)
		if _, err := authority.VerifySession(context.Background(), token); !errors.Is(err, ErrInvalid) {
			t.Fatalf("revoked/mismatched live session accepted: %v", err)
		}
		*store = saved
	}
	store.err = errors.New("database unavailable")
	if _, err := authority.VerifySession(context.Background(), token); !errors.Is(err, ErrDependency) {
		t.Fatalf("database outage did not fail closed as dependency failure: %v", err)
	}
}

func TestCCTLifetimeCannotOutliveAccessCredential(t *testing.T) {
	authority, store, now := newTestAuthority(t)
	store.session.ExpiresAt = now.Add(20 * time.Second)
	_, token, err := authority.Issue(context.Background(), "ant_api_test", "console", "")
	if err != nil {
		t.Fatal(err)
	}
	claims, err := protocol.Verify(token, authority.keys, protocol.Expected{Consumer: "identity-service", Organization: "org-1", Now: now, Tolerance: 30})
	if err != nil || claims.ExpiresAt != store.session.ExpiresAt.Unix() {
		t.Fatalf("CCT exceeds access expiry: %#v error=%v", claims, err)
	}
}
