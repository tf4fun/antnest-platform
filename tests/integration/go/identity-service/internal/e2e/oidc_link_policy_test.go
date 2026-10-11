package e2e

import (
	"net/http"
	"os"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestOIDCLinkPolicyPostgresAdmission(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	for _, test := range []struct {
		name, policy, role   string
		domains              []string
		authoritative, allow bool
	}{
		{name: "default_none_member", policy: "none", role: "member"},
		{name: "default_none_admin", policy: "none", role: "admin"},
		{name: "verified_member", policy: "verified_email", role: "member", allow: true},
		{name: "verified_admin_untrusted", policy: "verified_email", role: "admin"},
		{name: "verified_admin_authoritative", policy: "verified_email", role: "admin", authoritative: true, allow: true},
		{name: "domain_member_match", policy: "verified_email_in_domains", domains: []string{"example.com"}, role: "member", allow: true},
		{name: "domain_member_other", policy: "verified_email_in_domains", domains: []string{"other.com"}, role: "member"},
		{name: "domain_admin_untrusted", policy: "verified_email_in_domains", domains: []string{"example.com"}, role: "admin"},
		{name: "domain_admin_authoritative", policy: "verified_email_in_domains", domains: []string{"example.com"}, role: "admin", authoritative: true, allow: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newOIDCAdmissionFixture(t, databaseURL)
			f.providerInput.LinkPolicy, f.providerInput.LinkDomains, f.providerInput.Authoritative = &test.policy, &test.domains, &test.authoritative
			if _, err := f.flow.UpsertProvider(t.Context(), f.providerInput); err != nil {
				t.Fatal(err)
			}
			if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET role=$2 WHERE user_id=$1`, f.user.User.ID, test.role); err != nil {
				t.Fatal(err)
			}
			result, err := f.flow.CompleteLogin(t.Context(), f.start(t))
			want := 0
			if test.allow {
				want = 1
				if err != nil || result.AccessToken == "" {
					t.Fatalf("allowed policy refused: %v", err)
				}
			} else if code, _, _ := domain.ErrorDetails(err); code != "oidc_membership_required" || result.AccessToken != "" {
				t.Fatalf("unsafe email assertion admitted: code=%s credential=%t", code, result.AccessToken != "")
			}
			var bindings, sessions, completed int
			if err := f.pool.QueryRow(t.Context(), `SELECT
				(SELECT count(*) FROM external_identities), (SELECT count(*) FROM api_tokens),
				(SELECT count(*) FROM identity_events WHERE event_type='oidc_login.completed')`).Scan(&bindings, &sessions, &completed); err != nil {
				t.Fatal(err)
			}
			if bindings != want || sessions != want || completed != want {
				t.Fatalf("policy effects=%d/%d/%d want %d", bindings, sessions, completed, want)
			}
		})
	}
}

func TestOIDCExistingBindingDoesNotDependOnEmailOrUserInfo(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	for _, policy := range []string{"none", "verified_email", "verified_email_in_domains"} {
		for _, wrongNonce := range []bool{false, true} {
			name := policy
			if wrongNonce {
				name += "_wrong_nonce"
			}
			t.Run(name, func(t *testing.T) {
				f := newOIDCAdmissionFixture(t, databaseURL)
				domains, authoritative := []string{}, false
				if policy == "verified_email_in_domains" {
					domains = []string{"unrelated.example"}
				}
				f.providerInput.LinkPolicy, f.providerInput.LinkDomains, f.providerInput.Authoritative = &policy, &domains, &authoritative
				provider, err := f.flow.UpsertProvider(t.Context(), f.providerInput)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := f.pool.Exec(t.Context(), `INSERT INTO external_identities (id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,'subject-1',$6,$6)`, f.newID("externalidentity"), f.admin.Organization.ID, provider.ID, f.user.User.ID, f.user.Membership.ID, f.time()); err != nil {
					t.Fatal(err)
				}
				input := f.start(t)
				f.idp.mu.Lock()
				f.idp.email, f.idp.userInfoStatus = "", http.StatusServiceUnavailable
				if wrongNonce {
					f.idp.nonce = "wrong-nonce"
				}
				f.idp.mu.Unlock()
				result, err := f.flow.CompleteLogin(t.Context(), input)
				if wrongNonce {
					if err == nil || result.AccessToken != "" {
						t.Fatal("pre-binding bypassed nonce verification")
					}
				} else if err != nil || result.Principal.UserID != f.user.User.ID || result.AccessToken == "" {
					t.Fatalf("existing subject required email/UserInfo: %v", err)
				}
				f.idp.mu.Lock()
				calls := f.idp.userInfoCalls
				f.idp.mu.Unlock()
				if calls != 0 {
					t.Fatalf("already bound subject made %d UserInfo requests", calls)
				}
				var bindings, sessions int
				if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM external_identities), (SELECT count(*) FROM api_tokens)`).Scan(&bindings, &sessions); err != nil {
					t.Fatal(err)
				}
				wantSessions := 1
				if wrongNonce {
					wantSessions = 0
				}
				if bindings != 1 || sessions != wantSessions {
					t.Fatalf("binding/session effects=%d/%d", bindings, sessions)
				}
			})
		}
	}
}

func TestOIDCUnboundUserInfoSubjectMismatchHasNoLoginEffects(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	f := newOIDCAdmissionFixture(t, databaseURL)
	policy, domains, authoritative := "verified_email", []string{}, false
	f.providerInput.LinkPolicy, f.providerInput.LinkDomains, f.providerInput.Authoritative = &policy, &domains, &authoritative
	if _, err := f.flow.UpsertProvider(t.Context(), f.providerInput); err != nil {
		t.Fatal(err)
	}
	input := f.start(t)
	f.idp.mu.Lock()
	f.idp.email, f.idp.userInfoSubject = "", "another-subject"
	f.idp.mu.Unlock()
	result, err := f.flow.CompleteLogin(t.Context(), input)
	if code, _, _ := domain.ErrorDetails(err); code != "oidc_exchange_failed" || result.AccessToken != "" {
		t.Fatalf("UserInfo mismatch result: %v", err)
	}
	var bindings, sessions int
	if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM external_identities), (SELECT count(*) FROM api_tokens)`).Scan(&bindings, &sessions); err != nil {
		t.Fatal(err)
	}
	if bindings != 0 || sessions != 0 {
		t.Fatalf("UserInfo mismatch committed login: %d/%d", bindings, sessions)
	}
}

func TestOIDCOptionalClaimTypesCannotBlockBindingsOrGrantEmailAuthority(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	for _, field := range []string{"email", "email_verified", "name", "preferred_username"} {
		for _, bound := range []bool{false, true} {
			name := field + "_unbound"
			if bound {
				name = field + "_bound"
			}
			t.Run(name, func(t *testing.T) {
				f := newOIDCAdmissionFixture(t, databaseURL)
				wantSessions, wantLinks := 0, 0
				if bound {
					if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err != nil {
						t.Fatal(err)
					}
					wantSessions, wantLinks = 1, 1
				}
				f.idp.mu.Lock()
				f.idp.claimsOverride = map[string]any{field: []string{"invalid-profile-type"}}
				f.idp.userInfoStatus = http.StatusServiceUnavailable
				f.idp.mu.Unlock()
				result, err := f.flow.CompleteLogin(t.Context(), f.start(t))
				wantCalls := 0
				if bound || field == "name" || field == "preferred_username" {
					if err != nil || result.AccessToken == "" || result.Principal.UserID != f.user.User.ID {
						t.Fatalf("optional claims blocked issuer/subject authentication: %v", err)
					}
					wantSessions++
					wantLinks = 1
				} else {
					wantCalls = 1
					if code, _, _ := domain.ErrorDetails(err); code != "oidc_exchange_failed" || result.AccessToken != "" {
						t.Fatalf("invalid email authority granted first binding: %v", err)
					}
				}
				f.idp.mu.Lock()
				calls := f.idp.userInfoCalls
				f.idp.mu.Unlock()
				var sessions, links, completed int
				if err := f.pool.QueryRow(t.Context(), `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities), (SELECT count(*) FROM identity_events WHERE event_type='oidc_login.completed')`).Scan(&sessions, &links, &completed); err != nil {
					t.Fatal(err)
				}
				if sessions != wantSessions || links != wantLinks || completed != wantSessions || calls != wantCalls {
					t.Fatalf("sessions/links/completed/userinfo=%d/%d/%d/%d want %d/%d/%d/%d", sessions, links, completed, calls, wantSessions, wantLinks, wantSessions, wantCalls)
				}
			})
		}
	}
}
