package externalidentities

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"strings"
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

func signedCaller(t *testing.T, role domain.OrganizationRole) context.Context {
	t.Helper()
	now := time.Now().UTC()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	source := sessionSource{callercontext.Session{ID: "sid-1", ExpiresAt: now.Add(time.Hour), IdleExpiresAt: now.Add(time.Minute), Principal: domain.Principal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "member-1", Active: true, SystemRole: domain.SystemRoleUser, OrganizationRole: role,
	}}}
	a, err := callercontext.NewAuthority(callercontext.Config{KID: "test", PrivateKey: private, Keys: callercontext.Keys{"test": public}, Repository: source, Now: func() time.Time { return now }, NewID: func() string { return "cct-1" }})
	if err != nil {
		t.Fatal(err)
	}
	_, token, err := a.Issue(t.Context(), "session", "session", "")
	if err != nil {
		t.Fatal(err)
	}
	caller, err := a.AuthenticateSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return callercontext.WithCaller(t.Context(), caller)
}

type recordingRepository struct {
	Repository
	calls  int
	bound  BindInput
	access Access
}

func (r *recordingRepository) List(_ context.Context, a Access, _ ListInput) (Page, error) {
	r.calls++
	r.access = a
	return Page{}, nil
}
func (r *recordingRepository) Bind(_ context.Context, a Access, input BindInput) (Binding, error) {
	r.calls++
	r.access = a
	r.bound = input
	return Binding{}, nil
}
func (r *recordingRepository) Unbind(_ context.Context, a Access, _ UnbindInput) (UnbindResult, error) {
	r.calls++
	r.access = a
	return UnbindResult{}, nil
}
func (r *recordingRepository) Acknowledge(_ context.Context, a Access, _ AcknowledgeInput) (AcknowledgeResult, error) {
	r.calls++
	r.access = a
	return AcknowledgeResult{}, nil
}
func (r *recordingRepository) ListProviders(_ context.Context, a Access, _ ProvidersInput) (ProvidersPage, error) {
	r.calls++
	r.access = a
	return ProvidersPage{}, nil
}

func TestListValidatesSignedScopeAndIndependentCursors(t *testing.T) {
	for _, name := range []string{"missing-caller", "actor", "scope", "member-admin", "self-membership", "organization-missing-membership", "organization-notices", "low-limit", "high-limit", "binding-cursor", "notice-cursor"} {
		t.Run(name, func(t *testing.T) {
			r := &recordingRepository{}
			s := NewService(r)
			ctx := signedCaller(t, domain.OrganizationRoleAdmin)
			input := ListInput{ActorPrincipalID: "user-1", Scope: "self", Limit: 10}
			want := domain.ErrInvalidArgument
			switch name {
			case "missing-caller":
				ctx = t.Context()
				want = callercontext.ErrInvalid
			case "actor":
				input.ActorPrincipalID = "other"
				want = domain.ErrForbidden
			case "scope":
				input.Scope = "global"
			case "member-admin":
				ctx = signedCaller(t, domain.OrganizationRoleMember)
				input.Scope = "organization"
				input.MembershipID = "member-2"
				want = domain.ErrForbidden
			case "self-membership":
				input.MembershipID = "member-1"
			case "organization-missing-membership":
				input.Scope = "organization"
			case "organization-notices":
				input.Scope = "organization"
				input.MembershipID = "member-2"
				input.NoticeAfterID = "notice-1"
			case "low-limit":
				input.Limit = 0
			case "high-limit":
				input.Limit = 101
			case "binding-cursor":
				input.AfterID = "invalid cursor"
			case "notice-cursor":
				input.NoticeAfterID = "invalid cursor"
			}
			if _, err := s.List(ctx, input); !errors.Is(err, want) || r.calls != 0 {
				t.Fatalf("invalid input reached storage: err=%v calls=%d", err, r.calls)
			}
		})
	}
}

func TestBindingPreservesOpaqueSubjectAndExplicitRestore(t *testing.T) {
	ctx := signedCaller(t, domain.OrganizationRoleAdmin)
	for _, subject := range []string{" subject ", "用户/subject", strings.Repeat("😀", 255), `literal\uD800`} {
		r := &recordingRepository{}
		input := BindInput{RequestID: "request-1", ActorPrincipalID: "user-1", MembershipID: "member-2", ProviderID: "provider-1", Subject: subject, RestoreRevoked: true}
		if _, err := NewService(r).Bind(ctx, input); err != nil || r.calls != 1 || r.bound.Subject != subject || !r.bound.RestoreRevoked || r.access.Scope != "organization" || r.access.Caller == nil {
			t.Fatalf("binding authority or opaque subject changed: %v", err)
		}
	}
	for _, subject := range []string{"", "bad\x00subject", string([]byte{0xff}), strings.Repeat("😀", 256)} {
		r := &recordingRepository{}
		if _, err := NewService(r).Bind(ctx, BindInput{RequestID: "request-1", ActorPrincipalID: "user-1", MembershipID: "member-2", ProviderID: "provider-1", Subject: subject}); !errors.Is(err, domain.ErrInvalidArgument) || r.calls != 0 {
			t.Fatalf("invalid subject accepted: %v", err)
		}
	}
}

func TestMutationsRejectInvalidTargetsBeforeStorage(t *testing.T) {
	ctx := signedCaller(t, domain.OrganizationRoleAdmin)
	for _, input := range []UnbindInput{
		{ActorPrincipalID: "user-1", BindingID: "binding-1", Scope: "self"},
		{RequestID: "request-1", ActorPrincipalID: "user-1", Scope: "self"},
		{RequestID: "request-1", ActorPrincipalID: "user-1", BindingID: "binding-1", Scope: "self", MembershipID: "member-1"},
		{RequestID: "request-1", ActorPrincipalID: "user-1", BindingID: "binding-1", Scope: "organization"},
	} {
		r := &recordingRepository{}
		if _, err := NewService(r).Unbind(ctx, input); !errors.Is(err, domain.ErrInvalidArgument) || r.calls != 0 {
			t.Fatalf("invalid unbind reached storage: %v", err)
		}
	}
	for _, ids := range [][]string{nil, {}, {"notice-1", "notice-1"}, {"bad id"}, make([]string, 101)} {
		r := &recordingRepository{}
		if _, err := NewService(r).Acknowledge(ctx, AcknowledgeInput{RequestID: "request-1", ActorPrincipalID: "user-1", NoticeIDs: ids}); !errors.Is(err, domain.ErrInvalidArgument) || r.calls != 0 {
			t.Fatalf("invalid acknowledgement reached storage: %v", err)
		}
	}
	r := &recordingRepository{}
	if _, err := NewService(r).Bind(signedCaller(t, domain.OrganizationRoleMember), BindInput{RequestID: "request-1", ActorPrincipalID: "user-1", MembershipID: "member-2", ProviderID: "provider-1", Subject: "valid"}); !errors.Is(err, domain.ErrForbidden) || r.calls != 0 {
		t.Fatalf("member authorized prebinding: %v", err)
	}
}

func TestServiceCarriesSignedAuthorityForEveryOperation(t *testing.T) {
	r := &recordingRepository{}
	s := NewService(r)
	ctx := signedCaller(t, domain.OrganizationRoleAdmin)
	operations := []func(context.Context) error{
		func(ctx context.Context) error {
			_, err := s.List(ctx, ListInput{ActorPrincipalID: "user-1", Scope: "self", Limit: 100, AfterID: "binding-1", NoticeAfterID: "notice-1"})
			return err
		},
		func(ctx context.Context) error {
			_, err := s.List(ctx, ListInput{ActorPrincipalID: "user-1", Scope: "organization", MembershipID: "member-2", Limit: 100})
			return err
		},
		func(ctx context.Context) error {
			_, err := s.Bind(ctx, BindInput{RequestID: "request-1", ActorPrincipalID: "user-1", MembershipID: "member-2", ProviderID: "provider-1", Subject: "s"})
			return err
		},
		func(ctx context.Context) error {
			_, err := s.Unbind(ctx, UnbindInput{RequestID: "request-1", ActorPrincipalID: "user-1", BindingID: "binding-1", Scope: "self", AllowLockout: true})
			return err
		},
		func(ctx context.Context) error {
			_, err := s.Acknowledge(ctx, AcknowledgeInput{RequestID: "request-1", ActorPrincipalID: "user-1", NoticeIDs: []string{"notice-1"}})
			return err
		},
		func(ctx context.Context) error {
			_, err := s.ListProviders(ctx, ProvidersInput{ActorPrincipalID: "user-1", Limit: 100})
			return err
		},
	}
	for i, operation := range operations {
		if err := operation(t.Context()); !errors.Is(err, callercontext.ErrInvalid) || r.calls != i {
			t.Fatalf("operation %d accepted missing caller: %v", i, err)
		}
		if err := operation(ctx); err != nil || r.calls != i+1 || r.access.Caller == nil {
			t.Fatalf("operation %d lost signed authority: %v", i, err)
		}
	}
}
