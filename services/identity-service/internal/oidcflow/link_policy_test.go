package oidcflow

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func linkingService(t *testing.T) (*Service, *oidcRepositoryStub, UpsertProviderInput) {
	t.Helper()
	repo := newOIDCRepositoryStub(t)
	repo.principal = systemAdministrator()
	federation := &federationStub{discovery: Discovery{
		Issuer: "https://id.example.com", AuthorizationEndpoint: "https://id.example.com/authorize",
		TokenEndpoint: "https://id.example.com/token", JWKSURI: "https://id.example.com/jwks",
		TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"},
	}}
	return newTestService(t, repo, federation), repo, UpsertProviderInput{
		RequestID: "policy", ActorPrincipalID: "admin", OrganizationID: "org-1",
		Name: "workforce", Issuer: federation.discovery.Issuer, ClientID: "client-1",
		ClientSecret: "secret", Enabled: true,
	}
}

// Decode input fixtures so this regression can run against the previous
// producer, where the new policy fields are silently absent.
func withLinkPolicy(t *testing.T, input UpsertProviderInput, fields string) UpsertProviderInput {
	t.Helper()
	if err := json.Unmarshal([]byte(fields), &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func assertProviderPolicy(t *testing.T, provider Provider, policy string, domains []string, authoritative, review bool) {
	t.Helper()
	raw, err := json.Marshal(provider)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	for key, expected := range map[string]any{
		"link_policy": policy, "link_domains": domains, "authoritative": authoritative,
		"link_policy_review_required": review,
	} {
		want, err := json.Marshal(expected)
		if err != nil {
			t.Fatal(err)
		}
		if string(fields[key]) != string(want) {
			t.Errorf("%s = %s, want %s", key, fields[key], want)
		}
	}
}

func TestNewProviderDefaultsToNoAutomaticLinking(t *testing.T) {
	service, _, input := linkingService(t)
	provider, err := service.UpsertProvider(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	assertProviderPolicy(t, provider, "none", []string{}, false, false)
}

func TestProviderPolicyCanonicalizesExplicitDomainsAndFalse(t *testing.T) {
	service, _, input := linkingService(t)
	input = withLinkPolicy(t, input, `{"LinkPolicy":"verified_email_in_domains","LinkDomains":[" Example.COM ","xn--bcher-kva.example"],"Authoritative":false}`)
	provider, err := service.UpsertProvider(t.Context(), input)
	if err != nil {
		t.Fatal(err)
	}
	assertProviderPolicy(t, provider, "verified_email_in_domains", []string{"example.com", "xn--bcher-kva.example"}, false, false)
}

func TestProviderDomainTrimMatchesSharedECMAScriptSet(t *testing.T) {
	whitespace := []rune{'\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff'}
	for r := '\u2000'; r <= '\u200a'; r++ {
		whitespace = append(whitespace, r)
	}
	for _, space := range whitespace {
		t.Run(fmt.Sprintf("U+%04X", space), func(t *testing.T) {
			service, _, input := linkingService(t)
			policy, domains, authoritative := "verified_email_in_domains", []string{string(space) + "Example.COM" + string(space)}, false
			input.LinkPolicy, input.LinkDomains, input.Authoritative = &policy, &domains, &authoritative
			provider, err := service.UpsertProvider(t.Context(), input)
			if err != nil {
				t.Fatalf("shared trim character rejected: %v", err)
			}
			assertProviderPolicy(t, provider, policy, []string{"example.com"}, false, false)
			domains = []string{string(space)}
			if _, err := service.UpsertProvider(t.Context(), input); err == nil {
				t.Fatal("whitespace-only domain accepted")
			}
		})
	}
	for _, domains := range [][]string{{"\u0085Example.com\u0085"}, {"\u0085"}, {"\ufeffExample.com", "EXAMPLE.COM"}} {
		service, _, input := linkingService(t)
		policy, authoritative := "verified_email_in_domains", false
		input.LinkPolicy, input.LinkDomains, input.Authoritative = &policy, &domains, &authoritative
		if _, err := service.UpsertProvider(t.Context(), input); err == nil {
			t.Fatalf("invalid or duplicate domains accepted: %q", domains)
		}
	}
}

func TestProviderPolicyOmissionAndReviewAcknowledgment(t *testing.T) {
	for _, test := range []struct {
		name, fields, policy string
		review               bool
	}{
		{"omitted", `{}`, "verified_email", true},
		{"complete_without_ack", `{"LinkPolicy":"none","LinkDomains":[],"Authoritative":false}`, "none", true},
		{"false_ack", `{"LinkPolicy":"none","LinkDomains":[],"Authoritative":false,"AcknowledgeLinkPolicyReview":false}`, "none", true},
		{"true_ack", `{"LinkPolicy":"none","LinkDomains":[],"Authoritative":false,"AcknowledgeLinkPolicyReview":true}`, "none", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			service, repo, input := linkingService(t)
			repo.provider = testProvider(t)
			if err := json.Unmarshal([]byte(`{"link_policy":"verified_email","link_domains":[],"authoritative":false,"link_policy_review_required":true}`), &repo.provider.Provider); err != nil {
				t.Fatal(err)
			}
			input = withLinkPolicy(t, input, test.fields)
			provider, err := service.UpsertProvider(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			assertProviderPolicy(t, provider, test.policy, []string{}, false, test.review)
		})
	}
}

func TestProviderRejectsIncompleteOrInvalidPolicyBeforeWrite(t *testing.T) {
	fields := []string{
		`{"LinkPolicy":"none"}`, `{"LinkDomains":[]}`, `{"Authoritative":false}`,
		`{"LinkPolicy":"none","LinkDomains":[]}`, `{"LinkPolicy":"none","Authoritative":false}`, `{"LinkDomains":[],"Authoritative":false}`,
		`{"AcknowledgeLinkPolicyReview":true}`, `{"AcknowledgeLinkPolicyReview":false}`,
		`{"LinkPolicy":"unknown","LinkDomains":[],"Authoritative":false}`,
		`{"LinkPolicy":"none","LinkDomains":["example.com"],"Authoritative":false}`,
		`{"LinkPolicy":"verified_email","LinkDomains":["example.com"],"Authoritative":false}`,
		`{"LinkPolicy":"verified_email_in_domains","LinkDomains":[],"Authoritative":false}`,
	}
	for _, domains := range [][]string{
		{"example.com", "EXAMPLE.COM"}, {"*.example.com"}, {"https://example.com"},
		{"example.com:443"}, {"example.com."}, {"a..com"}, {"_example.com"},
		{"-example.com"}, {"example-.com"}, {"bücher.example"}, {"K.example"}, {"İ.example"}, {""},
		{strings.Repeat("a", 64) + ".com"}, {strings.Repeat("a.", 127) + "a"},
		{strings.Repeat(" ", 256) + "example.com"},
	} {
		raw, err := json.Marshal(map[string]any{"LinkPolicy": "verified_email_in_domains", "LinkDomains": domains, "Authoritative": false})
		if err != nil {
			t.Fatal(err)
		}
		fields = append(fields, string(raw))
	}
	for _, fields := range fields {
		t.Run(fields, func(t *testing.T) {
			service, repo, input := linkingService(t)
			_, err := service.UpsertProvider(t.Context(), withLinkPolicy(t, input, fields))
			if !errors.Is(err, domain.ErrInvalidArgument) || repo.upsert.Provider.ID != "" {
				t.Fatalf("invalid policy reached persistence: err=%v wrote=%t", err, repo.upsert.Provider.ID != "")
			}
		})
	}
}

func TestProviderPolicyRetainsAndCanRemoveAuthority(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		service, repo, input := linkingService(t)
		repo.provider = testProvider(t)
		if err := json.Unmarshal([]byte(`{"link_policy":"verified_email_in_domains","link_domains":["example.com"],"authoritative":true,"link_policy_review_required":true}`), &repo.provider.Provider); err != nil {
			t.Fatal(err)
		}
		if explicit {
			input = withLinkPolicy(t, input, `{"LinkPolicy":"verified_email_in_domains","LinkDomains":["example.com"],"Authoritative":false}`)
		}
		provider, err := service.UpsertProvider(t.Context(), input)
		if err != nil {
			t.Fatal(err)
		}
		assertProviderPolicy(t, provider, "verified_email_in_domains", []string{"example.com"}, !explicit, true)
	}
}

func TestProviderDomainCountAndDNSLengthBoundaries(t *testing.T) {
	for _, size := range []int{100, 101} {
		domains := make([]string, size)
		for i := range domains {
			domains[i] = fmt.Sprintf("d%d.example", i)
		}
		service, _, input := linkingService(t)
		raw, _ := json.Marshal(map[string]any{"LinkPolicy": "verified_email_in_domains", "LinkDomains": domains, "Authoritative": false})
		_, err := service.UpsertProvider(t.Context(), withLinkPolicy(t, input, string(raw)))
		if (err == nil) != (size == 100) {
			t.Fatalf("domain count %d: %v", size, err)
		}
	}
	for _, length := range []int{253, 254} {
		name := strings.Repeat(strings.Repeat("a", 63)+".", 3) + strings.Repeat("b", length-192)
		service, _, input := linkingService(t)
		raw, _ := json.Marshal(map[string]any{"LinkPolicy": "verified_email_in_domains", "LinkDomains": []string{name}, "Authoritative": false})
		_, err := service.UpsertProvider(t.Context(), withLinkPolicy(t, input, string(raw)))
		if (err == nil) != (length == 253) {
			t.Fatalf("domain length %d: %v", length, err)
		}
	}
}

func TestProviderDomainInputLimitCountsUnicodeCodePoints(t *testing.T) {
	service, _, input := linkingService(t)
	raw, err := json.Marshal(map[string]any{"LinkPolicy": "verified_email_in_domains", "LinkDomains": []string{strings.Repeat("\u2003", 244) + "example.com"}, "Authoritative": false})
	if err != nil {
		t.Fatal(err)
	}
	provider, err := service.UpsertProvider(t.Context(), withLinkPolicy(t, input, string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	assertProviderPolicy(t, provider, "verified_email_in_domains", []string{"example.com"}, false, false)
}

func TestVerifiedSubjectValidationIsIndependentOfEmailAndDisplayClaims(t *testing.T) {
	provider := testProvider(t).Provider
	for _, subject := range []string{" subject:opaque|1 ", strings.Repeat("界", 255), strings.Repeat("🙂", 255)} {
		for _, email := range []string{"", "not-an-email", "ALICE@EXAMPLE.COM"} {
			identity := VerifiedIdentity{Issuer: provider.Issuer, Subject: subject, Email: email, DisplayName: strings.Repeat("x", 1024)}
			got, err := validateIdentity(provider, identity)
			if err != nil || got.Subject != subject {
				t.Errorf("valid subject rejected because of optional claims: %v", err)
			}
		}
	}
	for _, subject := range []string{"", strings.Repeat("a", 256), strings.Repeat("🙂", 256), "\x00", "a\x00b", "\xed\xa0\x80", "\xff"} {
		_, err := validateIdentity(provider, VerifiedIdentity{Issuer: provider.Issuer, Subject: subject, Email: "alice@example.com", EmailVerified: true})
		if err == nil {
			t.Errorf("invalid subject %q accepted", subject)
		}
	}
}

func TestAutomaticLinkPolicyMatrix(t *testing.T) {
	for _, policy := range []string{"none", "verified_email", "verified_email_in_domains", "unknown"} {
		for _, role := range []domain.OrganizationRole{domain.OrganizationRoleMember, domain.OrganizationRoleAdmin} {
			for _, email := range []string{"member@example.com", "member@other.com", "member@sub.example.com"} {
				for _, authoritative := range []bool{false, true} {
					for _, verified := range []bool{false, true} {
						raw, _ := json.Marshal(map[string]any{"link_policy": policy, "link_domains": []string{"example.com"}, "authoritative": authoritative})
						var provider Provider
						if err := json.Unmarshal(raw, &provider); err != nil {
							t.Fatal(err)
						}
						want := verified && (role != domain.OrganizationRoleAdmin || authoritative) &&
							(policy == "verified_email" || policy == "verified_email_in_domains" && email == "member@example.com")
						if got := provider.AllowsAutomaticLink(VerifiedIdentity{Email: email, EmailVerified: verified}, role); got != want {
							t.Errorf("policy=%s role=%s email=%s authoritative=%t verified=%t: got %t want %t", policy, role, email, authoritative, verified, got, want)
						}
					}
				}
			}
		}
	}
}
