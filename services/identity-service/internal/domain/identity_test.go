package domain

import (
	"errors"
	"testing"
)

func TestNormalizeEmailAndSlug(t *testing.T) {
	t.Parallel()

	email, err := NormalizeEmail("  Alice@Example.COM ")
	if err != nil || email != "alice@example.com" {
		t.Fatalf("NormalizeEmail = %q, %v", email, err)
	}
	slug, err := NormalizeSlug(" Engineering-Team ")
	if err != nil || slug != "engineering-team" {
		t.Fatalf("NormalizeSlug = %q, %v", slug, err)
	}
	for _, value := range []string{"alice", "@example.com", "alice@", "Alice Example <alice@example.com>"} {
		if _, err := NormalizeEmail(value); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("invalid email %q error = %v, want invalid argument", value, err)
		}
	}
	for _, value := range []string{"", "-team", "team-", "team space", "团队"} {
		if _, err := NormalizeSlug(value); err == nil {
			t.Fatalf("invalid slug %q was accepted", value)
		}
	}
}

func TestPrincipalAdministrationBoundaries(t *testing.T) {
	t.Parallel()

	system := Principal{UserID: "root", SystemRole: SystemRoleAdmin, Active: true}
	if !system.CanAdminister("any-organization") {
		t.Fatal("system administrator cannot administer an organization")
	}
	organization := Principal{
		UserID: "admin", OrganizationID: "org-1", OrganizationRole: OrganizationRoleAdmin, Active: true,
	}
	if !organization.CanAdminister("org-1") || organization.CanAdminister("org-2") {
		t.Fatal("organization administrator escaped its organization boundary")
	}
	inactive := organization
	inactive.Active = false
	if inactive.CanAdminister("org-1") {
		t.Fatal("inactive principal retained administration")
	}
}

func TestNormalizeScopesRejectsUnknownAndDeduplicates(t *testing.T) {
	t.Parallel()

	scopes, err := NormalizeSCIMScopes([]string{"scim:write", "scim:read", "scim:write"})
	if err != nil {
		t.Fatalf("normalize scopes: %v", err)
	}
	if len(scopes) != 2 || scopes[0] != "scim:read" || scopes[1] != "scim:write" {
		t.Fatalf("scopes = %#v", scopes)
	}
	if _, err := NormalizeSCIMScopes([]string{"scim:admin"}); err == nil {
		t.Fatal("unknown scope was accepted")
	}
}
