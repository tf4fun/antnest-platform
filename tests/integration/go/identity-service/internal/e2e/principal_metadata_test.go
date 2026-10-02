package e2e

import (
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

func TestPrincipalOrganizationMetadataBuilders(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	fixture := newLocalAdmissionFixture(t, databaseURL, time.Now)
	ctx := t.Context()
	auth, err := localauth.NewService(fixture.store.LocalAuth(), fixture.newID, time.Now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	login, err := auth.Login(ctx, localauth.LoginInput{
		RequestID: "metadata-login", OrganizationSlug: fixture.admin.Organization.Slug,
		Email: "member@example.com", Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		load func() (domain.Principal, error)
	}{
		{"local_credential", func() (domain.Principal, error) {
			credential, err := fixture.store.LocalAuth().FindLocalCredential(ctx, fixture.admin.Organization.Slug, "member@example.com")
			return credential.Principal, err
		}},
		{"local_login", func() (domain.Principal, error) { return login.Principal, nil }},
		{"access_token", func() (domain.Principal, error) { return auth.Resolve(ctx, login.AccessToken) }},
		{"organization_actor", func() (domain.Principal, error) {
			return fixture.store.Directory().GetPrincipal(ctx, fixture.user.User.ID, fixture.admin.Organization.ID)
		}},
		{"organization_binding", func() (domain.Principal, error) {
			return fixture.store.Directory().ResolveOrganizationPrincipal(ctx, fixture.user.User.ID, fixture.admin.Organization.ID)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			principal, err := test.load()
			if err != nil {
				t.Fatal(err)
			}
			assertPrincipalOrganization(t, principal, fixture.admin.Organization)
		})
	}
	if _, err := fixture.pool.Exec(ctx, `UPDATE organizations SET slug = 'renamed', name = 'Renamed Organization' WHERE id = $1`, fixture.admin.Organization.ID); err != nil {
		t.Fatal(err)
	}
	currentOrganization := fixture.admin.Organization
	currentOrganization.Slug, currentOrganization.Name = "renamed", "Renamed Organization"
	t.Run("token_reads_current_organization", func(t *testing.T) {
		principal, err := auth.Resolve(ctx, login.AccessToken)
		if err != nil {
			t.Fatal(err)
		}
		assertPrincipalOrganization(t, principal, currentOrganization)
	})
	t.Run("unscoped_actor_stays_internal", func(t *testing.T) {
		principal, err := fixture.store.Directory().GetPrincipal(ctx, fixture.admin.User.ID, "")
		if err != nil || principal.OrganizationID != "" || principal.SystemRole != domain.SystemRoleAdmin {
			t.Fatalf("internal unscoped administrator changed: %+v %v", principal, err)
		}
	})
}

func TestLocalLoginRevalidationIgnoresOrganizationDisplayChanges(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	fixture := newLocalAdmissionFixture(t, databaseURL, time.Now)
	adapter := &beforeIssuanceRepository{Repository: fixture.store.LocalAuth(), before: func() {
		if _, err := fixture.pool.Exec(t.Context(), `UPDATE organizations SET slug = 'renamed', name = 'Renamed Organization' WHERE id = $1`, fixture.admin.Organization.ID); err != nil {
			t.Fatal(err)
		}
	}}
	auth, err := localauth.NewService(adapter, fixture.newID, time.Now, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	login, err := auth.Login(t.Context(), localauth.LoginInput{
		RequestID: "metadata-change-during-login", OrganizationSlug: fixture.admin.Organization.Slug,
		Email: "member@example.com", Password: "correct horse battery staple",
	})
	if err != nil || login.AccessToken == "" || adapter.calls != 1 {
		t.Fatalf("organization display change rejected a verified credential: calls=%d err=%v", adapter.calls, err)
	}
	assertPrincipalOrganization(t, login.Principal, fixture.admin.Organization)
	principal, err := auth.Resolve(t.Context(), login.AccessToken)
	if err != nil {
		t.Fatal(err)
	}
	currentOrganization := fixture.admin.Organization
	currentOrganization.Slug, currentOrganization.Name = "renamed", "Renamed Organization"
	assertPrincipalOrganization(t, principal, currentOrganization)
	fixture.assertIssuanceCount(t, 1)
}

func assertPrincipalOrganization(t *testing.T, principal domain.Principal, organization domain.Organization) {
	t.Helper()
	encoded, err := json.Marshal(principal)
	if err != nil {
		t.Fatal(err)
	}
	var actual struct {
		Slug string `json:"organization_slug"`
		Name string `json:"organization_name"`
	}
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	if principal.OrganizationID != organization.ID || actual.Slug != organization.Slug || actual.Name != organization.Name {
		t.Fatalf("principal metadata = %s; want organization %s/%s/%s", encoded, organization.ID, organization.Slug, organization.Name)
	}
}
