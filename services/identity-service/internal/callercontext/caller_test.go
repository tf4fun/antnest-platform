package callercontext

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func authenticatedTestCaller(t *testing.T) (*Caller, *Authority, *sessionsStub, time.Time) {
	t.Helper()
	authority, store, now := newTestAuthority(t)
	_, token, err := authority.Issue(t.Context(), "ant_api_test", "session", "")
	if err != nil {
		t.Fatal(err)
	}
	caller, err := authority.AuthenticateSession(t.Context(), token)
	if err != nil {
		t.Fatal(err)
	}
	return caller, authority, store, now
}

func TestCallerRevalidationUsesOnlyTheTransactionResolver(t *testing.T) {
	caller, authority, store, now := authenticatedTestCaller(t)
	want := store.session
	want.IdleExpiresAt, want.ActivityIntervalMS = now.Add(10*time.Second), 3
	current := now.Add(2 * time.Second)
	authority.now = func() time.Time { return current }
	store.err = errors.New("default repository must not be used by a transaction")
	calls := 0
	session, err := caller.Revalidate(t.Context(), func(ctx context.Context, sid string, observed time.Time) (Session, error) {
		calls++
		if ctx != t.Context() || sid != want.ID || !observed.Equal(current) {
			t.Fatal("transaction resolver lost context, original SID or current clock")
		}
		return want, nil
	})
	if err != nil || calls != 1 || session != want {
		t.Fatalf("transaction admission did not return its one fresh snapshot: %v", err)
	}
}

func TestCallerRevalidationRejectsStaleOrChangedAuthority(t *testing.T) {
	for _, invalid := range []string{"revoked", "inactive", "sid", "user", "organization", "membership", "system-role", "organization-role", "idle", "absolute", "cct-before-read", "cct-during-read", "dependency"} {
		t.Run(invalid, func(t *testing.T) {
			caller, authority, store, now := authenticatedTestCaller(t)
			current := now
			authority.now = func() time.Time { return current }
			if invalid == "cct-before-read" {
				current = now.Add(91 * time.Second)
			}
			calls := 0
			session, err := caller.Revalidate(t.Context(), func(context.Context, string, time.Time) (Session, error) {
				calls++
				live := store.session
				switch invalid {
				case "revoked":
					return Session{}, domain.ErrNotFound
				case "dependency":
					return Session{}, errors.New("database unavailable")
				case "inactive":
					live.Principal.Active = false
				case "sid":
					live.ID = "another-session"
				case "user":
					live.Principal.UserID = "another-user"
				case "organization":
					live.Principal.OrganizationID = "another-org"
				case "membership":
					live.Principal.MembershipID = "another-membership"
				case "system-role":
					live.Principal.SystemRole = domain.SystemRoleUser
				case "organization-role":
					live.Principal.OrganizationRole = domain.OrganizationRoleMember
				case "idle":
					live.IdleExpiresAt = now.Add(time.Second)
					current = live.IdleExpiresAt
				case "absolute":
					live.ExpiresAt = now.Add(time.Second)
					current = live.ExpiresAt
				case "cct-during-read":
					current = now.Add(91 * time.Second)
				}
				return live, nil
			})
			wantErr, wantCalls := ErrInvalid, 1
			if invalid == "dependency" {
				wantErr = ErrDependency
			}
			if invalid == "cct-before-read" {
				wantCalls = 0
			}
			if !errors.Is(err, wantErr) || session != (Session{}) || calls != wantCalls {
				t.Fatalf("invalid transaction authority accepted: error=%v calls=%d", err, calls)
			}
		})
	}
}

func TestCallerCannotBeCreatedFromUnverifiedOrMissingAuthority(t *testing.T) {
	authority, _, _ := newTestAuthority(t)
	if caller, err := authority.AuthenticateSession(t.Context(), "untrusted"); !errors.Is(err, ErrInvalid) || caller != nil {
		t.Fatal("unverified token produced a Caller")
	}
	if caller, err := CallerFromContext(t.Context()); !errors.Is(err, ErrInvalid) || caller != nil {
		t.Fatal("missing authenticated context was accepted")
	}
	for _, caller := range []*Caller{nil, {}} {
		if session, err := caller.Revalidate(t.Context(), func(context.Context, string, time.Time) (Session, error) {
			t.Fatal("invalid Caller queried storage")
			return Session{}, nil
		}); !errors.Is(err, ErrInvalid) || session != (Session{}) {
			t.Fatal("zero or nil Caller authorized effects")
		}
		if _, err := CallerFromContext(WithCaller(t.Context(), caller)); !errors.Is(err, ErrInvalid) {
			t.Fatal("uninitialized Caller survived context admission")
		}
	}
}

func TestCallerClaimsAreDetachedAndCredentialsAreNotJSONFields(t *testing.T) {
	caller, _, store, _ := authenticatedTestCaller(t)
	claims := caller.Claims()
	claims.Subject, claims.Session, claims.Audience[0] = "other", "other", "other"
	if got := caller.Claims(); got.Subject != store.session.Principal.UserID || got.Session != store.session.ID || got.Audience[0] != "identity-service" {
		t.Fatal("mutating a returned claims copy changed authenticated authority")
	}
	ctx := WithCaller(t.Context(), caller)
	if got, err := CallerFromContext(ctx); err != nil || got != caller {
		t.Fatal("typed context lost authenticated Caller")
	}
	raw, err := json.Marshal(caller) //nolint:staticcheck // SA9005 is intentional: adding exported authority fields must fail this regression.
	if err != nil || string(raw) != "{}" || strings.Contains(string(raw), store.session.ID) {
		t.Fatalf("Caller JSON exposed authority: %v", err)
	}
	if session, err := caller.Revalidate(t.Context(), nil); !errors.Is(err, ErrInvalid) || session != (Session{}) {
		t.Fatal("nil transaction resolver was accepted")
	}
}

func TestCallerClaimsDetachOptionalAgentScope(t *testing.T) {
	authority, _, _ := newTestAuthority(t)
	_, token, err := authority.Issue(t.Context(), "ant_api_test", "console", "agent-1")
	if err != nil {
		t.Fatal(err)
	}
	if caller, err := authority.AuthenticateSession(t.Context(), token); !errors.Is(err, ErrInvalid) || caller != nil {
		t.Fatal("Identity accepted Agent-bound authority without an expected Agent scope")
	}
	// Identity does not admit Agent-bound CCTs. Exercise this optional getter
	// field with a package-private value only; it cannot authorize a request.
	agent := "agent-1"
	caller := &Caller{claims: Claims{Agent: &agent}}
	claims := caller.Claims()
	*claims.Agent = "another-agent"
	if got := caller.Claims(); got.Agent == nil || *got.Agent != "agent-1" {
		t.Fatal("mutating returned Agent scope changed original authority")
	}
}

func TestOptionalCallerDistinguishesInternalAbsenceFromInvalidContext(t *testing.T) {
	if caller, err := OptionalCallerFromContext(t.Context()); err != nil || caller != nil {
		t.Fatal("internal context without browser authority was rejected")
	}
	for _, caller := range []*Caller{nil, {}} {
		if got, err := OptionalCallerFromContext(WithCaller(t.Context(), caller)); !errors.Is(err, ErrInvalid) || got != nil {
			t.Fatal("invalid browser context was treated as internal absence")
		}
	}
	caller, _, _, _ := authenticatedTestCaller(t)
	if got, err := OptionalCallerFromContext(WithCaller(t.Context(), caller)); err != nil || got != caller {
		t.Fatal("optional lookup lost verified browser authority")
	}
}
