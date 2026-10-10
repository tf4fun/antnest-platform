package browsersessions

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type sessionSource struct{ session callercontext.Session }

func (s sessionSource) ResolveTokenSession(context.Context, string, time.Time) (callercontext.Session, error) {
	return s.session, nil
}
func (s sessionSource) ResolveSession(context.Context, string, time.Time) (callercontext.Session, error) {
	return s.session, nil
}

func browserCaller(t *testing.T, role domain.OrganizationRole, system domain.SystemRole) context.Context {
	t.Helper()
	now := time.Now().UTC()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	source := sessionSource{callercontext.Session{ID: "sid-1", ExpiresAt: now.Add(time.Hour), IdleExpiresAt: now.Add(time.Minute), Principal: domain.Principal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "member-1", Active: true, SystemRole: system, OrganizationRole: role,
	}}}
	authority, err := callercontext.NewAuthority(callercontext.Config{KID: "test", PrivateKey: private, Keys: callercontext.Keys{"test": public}, Repository: source, Now: func() time.Time { return now }, NewID: func() string { return "cct-1" }})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := authority.Issue(t.Context(), "raw-session", "session", "")
	if err != nil {
		t.Fatal(err)
	}
	caller, err := authority.AuthenticateSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return callercontext.WithCaller(t.Context(), caller)
}

// An embedded nil repository fails loudly if invalid requests reach storage.
type recordingRepository struct {
	Repository
	lists   int
	revokes int
	touches int
	feeds   int
}

func (r *recordingRepository) List(_ context.Context, _ Access, _ ListInput) (Page, error) {
	r.lists++
	return Page{Sessions: []Session{}}, nil
}
func (r *recordingRepository) Revoke(_ context.Context, _ Access, _ RevokeInput) (RevokeResult, error) {
	r.revokes++
	return RevokeResult{}, nil
}
func (r *recordingRepository) Touch(_ context.Context, _ *callercontext.Caller) (Deadlines, error) {
	r.touches++
	return Deadlines{}, nil
}
func (r *recordingRepository) ListRevocations(_ context.Context, q RevocationQuery) (domain.SessionRevocationPage, error) {
	r.feeds++
	return domain.SessionRevocationPage{Events: []domain.SessionRevocation{}, NextSequence: q.AfterSequence}, nil
}

func TestBrowserServiceRejectsUntrustedScopeBeforeStorage(t *testing.T) {
	for _, name := range []string{"missing-caller", "actor-echo", "self-other-user", "member-admin-scope", "scope", "empty-user", "bad-cursor", "low-limit", "high-limit"} {
		t.Run(name, func(t *testing.T) {
			r := &recordingRepository{}
			s := NewService(r)
			ctx := browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleUser)
			input := ListInput{ActorPrincipalID: "user-1", UserID: "user-1", Scope: "self", Limit: 10}
			want := domain.ErrInvalidArgument
			switch name {
			case "missing-caller":
				ctx = t.Context()
				want = callercontext.ErrInvalid
			case "actor-echo":
				input.ActorPrincipalID = "other"
				want = domain.ErrForbidden
			case "self-other-user":
				input.UserID = "other"
				want = domain.ErrForbidden
			case "member-admin-scope":
				input.Scope = "organization"
				want = domain.ErrForbidden
			case "scope":
				input.Scope = "global"
			case "empty-user":
				input.UserID = ""
			case "bad-cursor":
				input.AfterID = "malformed cursor"
			case "low-limit":
				input.Limit = 0
			case "high-limit":
				input.Limit = 101
			}
			if _, err := s.List(ctx, input); !errors.Is(err, want) || r.lists != 0 {
				t.Fatalf("invalid inventory input reached storage: %v calls=%d", err, r.lists)
			}
		})
	}
}

func TestBrowserServiceRestrictsModesAndRequiresCorrelation(t *testing.T) {
	ctx := browserCaller(t, domain.OrganizationRoleAdmin, domain.SystemRoleUser)
	for _, input := range []RevokeInput{
		{RequestID: "request-1", ActorPrincipalID: "user-1", UserID: "user-2", Scope: "organization", Mode: "others"},
		{RequestID: "request-1", ActorPrincipalID: "user-1", UserID: "user-1", Scope: "self", Mode: "selected"},
		{ActorPrincipalID: "user-1", UserID: "user-1", Scope: "self", Mode: "all"},
	} {
		r := &recordingRepository{}
		if _, err := NewService(r).Revoke(ctx, input); !errors.Is(err, domain.ErrInvalidArgument) || r.revokes != 0 {
			t.Fatalf("invalid revocation reached storage: %v", err)
		}
	}
}

func TestBrowserServiceAllowsOnlySignedActorAndBoundedFeed(t *testing.T) {
	r := &recordingRepository{}
	s := NewService(r)
	ctx := browserCaller(t, domain.OrganizationRoleMember, domain.SystemRoleAdmin)
	if _, err := s.List(ctx, ListInput{ActorPrincipalID: "user-1", UserID: "user-2", Scope: "organization", Limit: 100}); err != nil || r.lists != 1 {
		t.Fatalf("system admin inventory: %v", err)
	}
	if _, err := s.Touch(ctx, "other"); !errors.Is(err, domain.ErrForbidden) || r.touches != 0 {
		t.Fatalf("wrong activity actor: %v", err)
	}
	if _, err := s.Touch(ctx, "user-1"); err != nil || r.touches != 1 {
		t.Fatalf("current activity: %v", err)
	}
	for _, q := range []RevocationQuery{{AfterSequence: -1, Limit: 10}, {Limit: 0}, {Limit: 501}} {
		if _, err := s.ListRevocations(t.Context(), q); !errors.Is(err, domain.ErrInvalidArgument) || r.feeds != 0 {
			t.Fatalf("invalid feed query reached storage: %v", err)
		}
	}
	if page, err := s.ListRevocations(t.Context(), RevocationQuery{AfterSequence: 20, Limit: 500}); err != nil || page.NextSequence != 20 || r.feeds != 1 {
		t.Fatalf("valid feed query: %v", err)
	}
}
