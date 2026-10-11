package e2e

import (
	"os"
	"slices"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func TestOIDCPolicyReviewPersistsThroughRealProviderLifecycle(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	omitPolicy := func(input *oidcflow.UpsertProviderInput) {
		input.LinkPolicy, input.LinkDomains, input.Authoritative, input.AcknowledgeLinkPolicyReview = nil, nil, nil, nil
	}
	f := newOIDCAdmissionFixtureWithTokenTTL(t, databaseURL, time.Hour, omitPolicy)
	assertStored := func(policy string, domains []string, authoritative, review, enabled bool) oidcflow.Provider {
		t.Helper()
		// A fresh adapter must read the same metadata from PostgreSQL. No result
		// returned by the writer is reused as evidence of persistence.
		reopened, err := repository.New(f.pool, f.newID, f.time)
		if err != nil {
			t.Fatal(err)
		}
		providers, err := reopened.OIDC().ListProviders(t.Context(), f.admin.Organization.ID)
		if err != nil || len(providers) != 1 {
			t.Fatalf("read Provider metadata: count=%d error=%v", len(providers), err)
		}
		p := providers[0]
		if p.LinkPolicy != policy || p.LinkDomains == nil || !slices.Equal(p.LinkDomains, domains) || p.Authoritative != authoritative || p.LinkPolicyReviewRequired != review || p.Enabled != enabled {
			t.Fatalf("stored policy=%s domains=%v authoritative=%t review=%t enabled=%t", p.LinkPolicy, p.LinkDomains, p.Authoritative, p.LinkPolicyReviewRequired, p.Enabled)
		}
		if len(p.ClientSecret.Ciphertext) != 0 || len(p.ClientSecret.Nonce) != 0 {
			t.Fatal("metadata returned secret material")
		}
		secretProvider, err := reopened.OIDC().FindProvider(t.Context(), f.admin.Organization.ID, f.providerInput.Name)
		if err != nil || secretProvider.LinkPolicy != p.LinkPolicy || !slices.Equal(secretProvider.LinkDomains, p.LinkDomains) || secretProvider.Authoritative != p.Authoritative || secretProvider.LinkPolicyReviewRequired != p.LinkPolicyReviewRequired {
			t.Fatalf("private and public Provider reads disagree: %v", err)
		}
		return p
	}
	created := assertStored("none", []string{}, false, false, true)
	// Seed only migration-owned legacy state. Every following mutation goes
	// through the real service and repository.
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET link_policy='verified_email', link_policy_review_required=true WHERE id=$1`, created.ID); err != nil {
		t.Fatal(err)
	}
	write := func() {
		t.Helper()
		if _, err := f.flow.UpsertProvider(t.Context(), f.providerInput); err != nil {
			t.Fatal(err)
		}
	}
	write()
	assertStored("verified_email", []string{}, false, true, true)
	policy, domains, authoritative := "verified_email_in_domains", []string{" Example.COM "}, true
	f.providerInput.LinkPolicy, f.providerInput.LinkDomains, f.providerInput.Authoritative = &policy, &domains, &authoritative
	write()
	assertStored(policy, []string{"example.com"}, true, true, true)
	omitPolicy(&f.providerInput)
	f.providerInput.ClientSecret = "rotated-policy-secret"
	write()
	assertStored(policy, []string{"example.com"}, true, true, true)
	for _, enabled := range []bool{false, true} {
		if _, err := f.flow.SetProviderEnabled(t.Context(), oidcflow.SetProviderEnabledInput{
			RequestID: "policy-toggle", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID, Name: f.providerInput.Name, Enabled: enabled,
		}); err != nil {
			t.Fatal(err)
		}
		assertStored(policy, []string{"example.com"}, true, true, enabled)
	}
	policy, domains, authoritative = "verified_email", []string{}, false
	acknowledge := false
	f.providerInput.LinkPolicy, f.providerInput.LinkDomains, f.providerInput.Authoritative = &policy, &domains, &authoritative
	f.providerInput.AcknowledgeLinkPolicyReview = &acknowledge
	write()
	assertStored(policy, domains, false, true, true)
	acknowledge, policy = true, "none"
	write()
	reviewed := assertStored(policy, domains, false, false, true)
	omitPolicy(&f.providerInput)
	f.providerInput.AcknowledgeLinkPolicyReview = &acknowledge
	if _, err := f.flow.UpsertProvider(t.Context(), f.providerInput); err == nil {
		t.Fatal("acknowledgement without complete policy was accepted")
	} else if code, _, _ := domain.ErrorDetails(err); code != "invalid_argument" {
		t.Fatalf("incomplete review: %v", err)
	}
	if got := assertStored(policy, domains, false, false, true); got.Revision != reviewed.Revision {
		t.Fatal("rejected review mutated registration")
	}
	omitPolicy(&f.providerInput)
	write()
	if err := repository.ApplyMigrations(t.Context(), f.pool); err != nil {
		t.Fatal(err)
	}
	assertStored(policy, domains, false, false, true)
}
