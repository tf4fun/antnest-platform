package repository

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"soft/antnest-platform/services/identity-service/internal/credentials"
	"soft/antnest-platform/services/identity-service/internal/directory"
	"soft/antnest-platform/services/identity-service/internal/domain"
	"soft/antnest-platform/services/identity-service/internal/localauth"
	"soft/antnest-platform/services/identity-service/internal/oidcflow"
	"soft/antnest-platform/services/identity-service/internal/scim"
)

func TestPostgresIdentityHappyPathAndOwnershipBoundaries(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	ctx := t.Context()
	adminPool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		t.Fatalf("connect PostgreSQL: %v", err)
	}
	defer adminPool.Close()
	schemaName := fmt.Sprintf("identity_test_%d", time.Now().UnixNano())
	quotedSchema := pgx.Identifier{schemaName}.Sanitize()
	if _, err := adminPool.Exec(ctx, `CREATE SCHEMA `+quotedSchema); err != nil {
		t.Fatalf("create isolated test schema: %v", err)
	}
	defer func() { _, _ = adminPool.Exec(context.WithoutCancel(ctx), `DROP SCHEMA `+quotedSchema+` CASCADE`) }()
	poolConfig, err := ParsePoolConfig(databaseURL)
	if err != nil {
		t.Fatalf("parse PostgreSQL config: %v", err)
	}
	poolConfig.ConnConfig.RuntimeParams["search_path"] = schemaName
	applicationName := "identity_repository_test_" + schemaName
	poolConfig.ConnConfig.RuntimeParams["application_name"] = applicationName
	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatalf("connect isolated test schema: %v", err)
	}
	defer pool.Close()
	migrationStart := make(chan struct{})
	migrationResults := make(chan error, 2)
	for range 2 {
		go func() {
			<-migrationStart
			migrationResults <- ApplyMigrations(ctx, pool)
		}()
	}
	close(migrationStart)
	for range 2 {
		if err := <-migrationResults; err != nil {
			t.Fatalf("apply concurrent migrations: %v", err)
		}
	}
	if err := ApplyMigrations(ctx, pool); err != nil {
		t.Fatalf("reapply migrations: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO schema_migrations (name, checksum)
		VALUES ('9999_future_identity.sql', $1)`, strings.Repeat("f", 64)); err != nil {
		t.Fatalf("insert future migration marker: %v", err)
	}
	if err := ApplyMigrations(ctx, pool); err == nil || !strings.Contains(err.Error(), "newer than") {
		t.Fatalf("future migration compatibility error = %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations WHERE name = '9999_future_identity.sql'`); err != nil {
		t.Fatalf("remove future migration marker: %v", err)
	}

	var sequence atomic.Uint64
	now := time.Date(2026, 8, 31, 5, 0, 0, 0, time.UTC)
	store, err := New(pool, func() string { return fmt.Sprintf("id-%d", sequence.Add(1)) }, func() time.Time { return now })
	if err != nil {
		t.Fatal(err)
	}
	passwordHash, err := credentials.HashPassword("correct horse battery staple")
	if err != nil {
		t.Fatal(err)
	}
	bootstrapInput := BootstrapInput{
		OrganizationSlug: "engineering", OrganizationName: "Engineering",
		AdminEmail: "admin@example.com", AdminDisplayName: "Antnest Administrator",
		PasswordHash: passwordHash, Now: now,
	}
	type bootstrapOutcome struct {
		result BootstrapResult
		err    error
	}
	bootstrapStart := make(chan struct{})
	bootstrapResults := make(chan bootstrapOutcome, 2)
	for range 2 {
		go func() {
			<-bootstrapStart
			result, err := store.Bootstrap(ctx, bootstrapInput)
			bootstrapResults <- bootstrapOutcome{result: result, err: err}
		}()
	}
	close(bootstrapStart)
	firstBootstrap, secondBootstrap := <-bootstrapResults, <-bootstrapResults
	if firstBootstrap.err != nil || secondBootstrap.err != nil {
		t.Fatalf("concurrent bootstrap errors = %v, %v", firstBootstrap.err, secondBootstrap.err)
	}
	bootstrap := firstBootstrap.result
	if secondBootstrap.result.Organization.ID != bootstrap.Organization.ID ||
		secondBootstrap.result.User.ID != bootstrap.User.ID ||
		secondBootstrap.result.Membership.ID != bootstrap.Membership.ID {
		t.Fatalf("concurrent bootstrap returned different facts: %#v and %#v", bootstrap, secondBootstrap.result)
	}
	var bootstrapEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM identity_events WHERE event_type = 'identity.bootstrap.completed'`,
	).Scan(&bootstrapEvents); err != nil {
		t.Fatalf("count bootstrap events: %v", err)
	}
	if bootstrapEvents != 1 {
		t.Fatalf("bootstrap event count = %d, want 1", bootstrapEvents)
	}
	var bootstrapCredentialRows int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM local_credentials c
		JOIN users u ON u.id = c.user_id
		JOIN organization_memberships m ON m.user_id = u.id
		WHERE u.id = $1 AND m.organization_id = $2 AND m.email = $3`,
		bootstrap.User.ID, bootstrap.Organization.ID, bootstrapInput.AdminEmail,
	).Scan(&bootstrapCredentialRows); err != nil || bootstrapCredentialRows != 1 {
		t.Fatalf("bootstrap credential/profile boundary rows=%d err=%v", bootstrapCredentialRows, err)
	}
	strictPrincipal, err := store.Directory().ResolveOrganizationPrincipal(
		ctx, bootstrap.User.ID, bootstrap.Organization.ID,
	)
	if err != nil || !strictPrincipal.Active || strictPrincipal.MembershipID != bootstrap.Membership.ID {
		t.Fatalf("resolve active organization principal = %#v, %v", strictPrincipal, err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE organization_memberships SET active = FALSE WHERE id = $1`,
		bootstrap.Membership.ID,
	); err != nil {
		t.Fatalf("deactivate bootstrap membership: %v", err)
	}
	strictPrincipal, err = store.Directory().ResolveOrganizationPrincipal(
		ctx, bootstrap.User.ID, bootstrap.Organization.ID,
	)
	if err != nil || strictPrincipal.Active {
		t.Fatalf("resolve inactive organization principal = %#v, %v", strictPrincipal, err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE organization_memberships SET active = TRUE WHERE id = $1`,
		bootstrap.Membership.ID,
	); err != nil {
		t.Fatalf("reactivate bootstrap membership: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, system_role, active, created_at, updated_at)
		VALUES ('system-admin-without-membership', 'admin', TRUE, $1, $1)`, now,
	); err != nil {
		t.Fatalf("insert membership-less system administrator: %v", err)
	}
	if _, err := store.Directory().ResolveOrganizationPrincipal(
		ctx, "system-admin-without-membership", bootstrap.Organization.ID,
	); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("membership-less system administrator error = %v, want not found", err)
	}
	if _, err := pool.Exec(ctx, `
		DELETE FROM users WHERE id = 'system-admin-without-membership'`); err != nil {
		t.Fatalf("remove membership-less system administrator fixture: %v", err)
	}
	repeated, err := store.Bootstrap(ctx, BootstrapInput{
		OrganizationSlug: "engineering", OrganizationName: "Engineering",
		AdminEmail: "admin@example.com", AdminDisplayName: "Antnest Administrator",
		PasswordHash: "must-not-replace-existing-password", Now: now.Add(time.Minute),
	})
	if err != nil || repeated.User.ID != bootstrap.User.ID {
		t.Fatalf("repeat bootstrap = %#v, %v", repeated, err)
	}
	directoryService := directory.NewService(store.Directory(), func() string {
		return fmt.Sprintf("id-%d", sequence.Add(1))
	}, func() time.Time { return now })
	for _, change := range []struct {
		name   string
		role   domain.OrganizationRole
		active bool
	}{
		{name: "demote", role: domain.OrganizationRoleMember, active: true},
		{name: "deactivate", role: domain.OrganizationRoleAdmin, active: false},
	} {
		if _, err := directoryService.UpdateMembership(ctx, directory.UpdateMembershipInput{
			RequestID: "last-admin-" + change.name, ActorPrincipalID: bootstrap.User.ID,
			OrganizationID: bootstrap.Organization.ID, MembershipID: bootstrap.Membership.ID,
			Email: bootstrap.Membership.Email, DisplayName: bootstrap.Membership.DisplayName,
			Role: change.role, Active: change.active,
		}); !errors.Is(err, domain.ErrLastOrganizationAdmin) {
			t.Fatalf("%s last organization administrator error = %v, want last administrator", change.name, err)
		}
	}
	secondaryOrganization, err := directoryService.CreateOrganization(ctx, directory.CreateOrganizationInput{
		RequestID: "organization-2", ActorPrincipalID: bootstrap.User.ID,
		Slug: "research", Name: "Research",
		OwnerEmail: "admin@example.com", OwnerDisplayName: "Antnest Administrator",
	})
	if err != nil {
		t.Fatalf("system administrator create second organization: %v", err)
	}
	secondaryUser, err := directoryService.CreateLocalUser(ctx, directory.CreateLocalUserInput{
		RequestID: "secondary-admin", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: secondaryOrganization.ID, Email: "research-admin@example.com",
		DisplayName: "Research Administrator", Password: "secondary correct password",
		Role: domain.OrganizationRoleAdmin,
	})
	if err != nil || secondaryUser.Membership.OrganizationID != secondaryOrganization.ID {
		t.Fatalf("initialize second organization directory = %#v, %v", secondaryUser, err)
	}
	secondaryDirectory, err := directoryService.List(ctx, bootstrap.User.ID, secondaryOrganization.ID)
	if err != nil {
		t.Fatalf("list secondary organization directory: %v", err)
	}
	var creatorMembership domain.OrganizationMembership
	for _, member := range secondaryDirectory.Users {
		if member.User.ID == bootstrap.User.ID {
			creatorMembership = member.Membership
			break
		}
	}
	if creatorMembership.ID == "" {
		t.Fatal("secondary organization creator membership is missing")
	}
	creatorMembership, err = directoryService.UpdateMembership(ctx, directory.UpdateMembershipInput{
		RequestID: "deactivate-secondary-creator", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: secondaryOrganization.ID, MembershipID: creatorMembership.ID,
		Email: creatorMembership.Email, DisplayName: creatorMembership.DisplayName,
		Role: creatorMembership.Role, Active: false,
	})
	if err != nil {
		t.Fatalf("deactivate secondary organization creator: %v", err)
	}
	if err := directoryService.SetUserActive(ctx, directory.SetUserActiveInput{
		RequestID: "disable-last-secondary-admin", ActorPrincipalID: bootstrap.User.ID,
		UserID: secondaryUser.User.ID, Active: false,
	}); !errors.Is(err, domain.ErrLastOrganizationAdmin) {
		t.Fatalf("disable last effective organization administrator error = %v, want last administrator", err)
	}
	creatorMembership, err = directoryService.UpdateMembership(ctx, directory.UpdateMembershipInput{
		RequestID: "reactivate-secondary-creator", ActorPrincipalID: secondaryUser.User.ID,
		OrganizationID: secondaryOrganization.ID, MembershipID: creatorMembership.ID,
		Email: creatorMembership.Email, DisplayName: creatorMembership.DisplayName,
		Role: creatorMembership.Role, Active: true,
	})
	if err != nil {
		t.Fatalf("reactivate secondary organization creator: %v", err)
	}
	sharedMembership, err := directoryService.AddOrganizationMembership(ctx, directory.AddOrganizationMembershipInput{
		RequestID: "share-secondary-user", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, UserID: secondaryUser.User.ID,
		Email: "research-admin@example.com", DisplayName: "Research Administrator",
		Role: domain.OrganizationRoleMember,
	})
	if err != nil || sharedMembership.UserID != secondaryUser.User.ID ||
		sharedMembership.OrganizationID != bootstrap.Organization.ID {
		t.Fatalf("add existing User to another organization = %#v, %v", sharedMembership, err)
	}
	repeatedMembership, err := directoryService.AddOrganizationMembership(ctx, directory.AddOrganizationMembershipInput{
		RequestID: "share-secondary-user-again", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, UserID: secondaryUser.User.ID,
		Email: "research-admin@example.com", DisplayName: "Research Administrator",
		Role: domain.OrganizationRoleMember,
	})
	if err != nil || repeatedMembership.ID != sharedMembership.ID {
		t.Fatalf("repeat organization membership = %#v, %v", repeatedMembership, err)
	}

	authService, err := localauth.NewService(store.LocalAuth(), func() string {
		return fmt.Sprintf("id-%d", sequence.Add(1))
	}, func() time.Time { return now }, 12*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	login, err := authService.Login(ctx, localauth.LoginInput{
		RequestID: "login-1", OrganizationSlug: "engineering",
		Email: "admin@example.com", Password: "correct horse battery staple",
	})
	if err != nil {
		t.Fatalf("local login: %v", err)
	}
	resolved, err := authService.Resolve(ctx, login.AccessToken)
	if err != nil || resolved != login.Principal {
		t.Fatalf("resolve = %#v, %v; login=%#v", resolved, err, login.Principal)
	}
	var tokenVersionBefore, tokenVersionAfter string
	var lastUsedAt time.Time
	if err := pool.QueryRow(ctx, `
		SELECT xmin::text, last_used_at FROM api_tokens WHERE id = $1`, login.TokenID,
	).Scan(&tokenVersionBefore, &lastUsedAt); err != nil {
		t.Fatalf("read access-token telemetry: %v", err)
	}
	if !lastUsedAt.Equal(now) {
		t.Fatalf("last_used_at=%s want=%s", lastUsedAt, now)
	}
	if _, err := authService.Resolve(ctx, login.AccessToken); err != nil {
		t.Fatalf("repeat token resolution: %v", err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT xmin::text FROM api_tokens WHERE id = $1`, login.TokenID,
	).Scan(&tokenVersionAfter); err != nil {
		t.Fatalf("read repeated access-token version: %v", err)
	}
	if tokenVersionAfter != tokenVersionBefore {
		t.Fatalf("fresh token resolution rewrote row: before=%s after=%s",
			tokenVersionBefore, tokenVersionAfter)
	}
	status, err := authService.RevokeByAccessToken(ctx, login.AccessToken)
	if err != nil || status != localauth.RevokeStatusRevoked {
		t.Fatalf("revoke access token: status=%q err=%v", status, err)
	}
	status, err = authService.RevokeByAccessToken(ctx, login.AccessToken)
	if err != nil || status != localauth.RevokeStatusAlreadyInvalid {
		t.Fatalf("repeat revoke access token: status=%q err=%v", status, err)
	}
	if _, err := authService.Resolve(ctx, login.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("revoked token resolution error=%v", err)
	}
	sharedUserLogin, err := authService.Login(ctx, localauth.LoginInput{
		RequestID: "login-shared-primary", OrganizationSlug: "engineering",
		Email: "research-admin@example.com", Password: "secondary correct password",
	})
	if err != nil || sharedUserLogin.Principal.UserID != secondaryUser.User.ID ||
		sharedUserLogin.Principal.MembershipID != sharedMembership.ID {
		t.Fatalf("login shared User through primary organization = %#v, %v", sharedUserLogin, err)
	}
	secondaryOrganizationLogin, err := authService.Login(ctx, localauth.LoginInput{
		RequestID: "login-shared-secondary", OrganizationSlug: "research",
		Email: "research-admin@example.com", Password: "secondary correct password",
	})
	if err != nil || secondaryOrganizationLogin.Principal.UserID != secondaryUser.User.ID ||
		secondaryOrganizationLogin.Principal.MembershipID != secondaryUser.Membership.ID {
		t.Fatalf("login shared User through secondary organization = %#v, %v", secondaryOrganizationLogin, err)
	}
	if err := directoryService.ChangeLocalPassword(ctx, directory.ChangeLocalPasswordInput{
		RequestID: "rotate-secondary-password", ActorPrincipalID: secondaryUser.User.ID,
		UserID: secondaryUser.User.ID, CurrentPassword: "secondary correct password",
		NewPassword: "rotated secondary password",
	}); err != nil {
		t.Fatalf("change local password: %v", err)
	}
	if _, err := authService.Login(ctx, localauth.LoginInput{
		RequestID: "old-password-login", OrganizationSlug: "research",
		Email: "research-admin@example.com", Password: "secondary correct password",
	}); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("old password login error = %v, want unauthenticated", err)
	}
	rotatedLogin, err := authService.Login(ctx, localauth.LoginInput{
		RequestID: "rotated-password-login", OrganizationSlug: "research",
		Email: "research-admin@example.com", Password: "rotated secondary password",
	})
	if err != nil {
		t.Fatalf("rotated password login: %v", err)
	}
	updatedMembership, err := directoryService.UpdateMembership(ctx, directory.UpdateMembershipInput{
		RequestID: "update-shared-membership", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, MembershipID: sharedMembership.ID,
		Email: sharedMembership.Email, DisplayName: "Research Operator",
		Role: sharedMembership.Role, Active: true,
	})
	if err != nil || !updatedMembership.UpdatedAt.After(sharedMembership.UpdatedAt) {
		t.Fatalf("update local membership = %#v, %v", updatedMembership, err)
	}
	staleMembership := updatedMembership
	staleMembership.DisplayName = "Stale Update"
	staleMembership.UpdatedAt = domain.NextUpdatedAt(now, updatedMembership.UpdatedAt)
	if _, err := store.Directory().UpdateMembership(ctx, directory.UpdateMembershipCommand{
		RequestID: "stale-membership-update", ActorPrincipalID: bootstrap.User.ID,
		Membership: staleMembership, ExpectedUpdatedAt: sharedMembership.UpdatedAt,
	}); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale membership update error = %v, want version conflict", err)
	}
	sharedMembership, err = directoryService.UpdateMembership(ctx, directory.UpdateMembershipInput{
		RequestID: "restore-shared-membership", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, MembershipID: sharedMembership.ID,
		Email: sharedMembership.Email, DisplayName: "Research Administrator",
		Role: sharedMembership.Role, Active: true,
	})
	if err != nil {
		t.Fatalf("restore local membership: %v", err)
	}
	if err := directoryService.SetUserActive(ctx, directory.SetUserActiveInput{
		RequestID: "disable-secondary-user", ActorPrincipalID: bootstrap.User.ID,
		UserID: secondaryUser.User.ID, Active: false,
	}); err != nil {
		t.Fatalf("disable global User: %v", err)
	}
	if _, err := authService.Resolve(ctx, rotatedLogin.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("disabled User token resolution error = %v, want unauthenticated", err)
	}
	if err := directoryService.SetUserActive(ctx, directory.SetUserActiveInput{
		RequestID: "enable-secondary-user", ActorPrincipalID: bootstrap.User.ID,
		UserID: secondaryUser.User.ID, Active: true,
	}); err != nil {
		t.Fatalf("enable global User: %v", err)
	}
	if _, err := authService.Login(ctx, localauth.LoginInput{
		RequestID: "reenabled-user-login", OrganizationSlug: "research",
		Email: "research-admin@example.com", Password: "rotated secondary password",
	}); err != nil {
		t.Fatalf("reenabled User login: %v", err)
	}

	scimService, err := scim.NewService(scim.Config{
		Repository: store.SCIM(),
		NewID:      func() string { return fmt.Sprintf("id-%d", sequence.Add(1)) },
		NewOpaque:  credentials.NewOpaqueToken, Now: func() time.Time { return now },
	})
	if err != nil {
		t.Fatal(err)
	}
	scimToken, err := scimService.IssueToken(ctx, scim.IssueTokenInput{
		RequestID: "scim-token-1", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: "Workday",
		Scopes: []string{domain.SCIMScopeWrite},
	})
	if err != nil {
		t.Fatalf("issue SCIM token: %v", err)
	}
	retiredToken, err := scimService.IssueToken(ctx, scim.IssueTokenInput{
		RequestID: "scim-token-retired", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: "Retired directory",
		Scopes: []string{domain.SCIMScopeRead},
	})
	if err != nil {
		t.Fatalf("issue retired SCIM token: %v", err)
	}
	if err := scimService.RevokeToken(ctx, bootstrap.User.ID, retiredToken.Token.ID); err != nil {
		t.Fatalf("revoke retired SCIM token: %v", err)
	}
	tokens, err := scimService.ListTokens(ctx, bootstrap.User.ID, bootstrap.Organization.ID)
	if err != nil {
		t.Fatalf("list SCIM token metadata: %v", err)
	}
	tokensByID := make(map[string]scim.Token, len(tokens))
	for _, token := range tokens {
		tokensByID[token.ID] = token
	}
	if len(tokens) != 2 || tokensByID[retiredToken.Token.ID].RevokedAt == nil ||
		tokensByID[scimToken.Token.ID].RevokedAt != nil {
		t.Fatalf("SCIM token metadata = %#v", tokens)
	}
	authorization, err := scimService.Authorize(ctx, scimToken.Credential, domain.SCIMScopeRead)
	if err != nil {
		t.Fatalf("authorize SCIM token: %v", err)
	}
	user, err := scimService.CreateUser(ctx, authorization, scim.UserInput{
		ExternalID: "workday-user-1", UserName: "alice.employee", Email: "alice@example.com",
		DisplayName: "Alice", Active: true,
	})
	if err != nil {
		t.Fatalf("create SCIM user: %v", err)
	}
	if _, err := directoryService.UpdateMembership(ctx, directory.UpdateMembershipInput{
		RequestID: "local-update-scim-membership", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, MembershipID: user.Membership.ID,
		Email: user.Membership.Email, DisplayName: "Local Override",
		Role: domain.OrganizationRoleMember, Active: true,
	}); !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("local update of SCIM-owned membership error = %v, want conflict", err)
	}
	_, err = scimService.CreateUser(ctx, authorization, scim.UserInput{
		ExternalID: "workday-user-1", UserName: "alice.employee", Email: "alice@example.com",
		DisplayName: "Alice Updated", Active: true,
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate SCIM user create error = %v, want conflict", err)
	}
	deactivatedUser, err := scimService.DeactivateUser(ctx, authorization, user.Membership.ID)
	if err != nil {
		t.Fatalf("deactivate SCIM user: %v", err)
	}
	if !deactivatedUser.User.Active || deactivatedUser.Membership.Active {
		t.Fatalf("SCIM deactivation crossed account boundary: %#v", deactivatedUser)
	}
	var accountActive, membershipActive bool
	if err := pool.QueryRow(ctx, `
		SELECT u.active, m.active
		FROM users u
		JOIN organization_memberships m ON m.user_id = u.id
		WHERE u.id = $1 AND m.id = $2`, user.User.ID, user.Membership.ID,
	).Scan(&accountActive, &membershipActive); err != nil {
		t.Fatalf("inspect SCIM activation state: %v", err)
	}
	if !accountActive || membershipActive {
		t.Fatalf("stored activation state = account:%t membership:%t", accountActive, membershipActive)
	}
	group, err := scimService.CreateGroup(ctx, authorization, scim.GroupInput{
		ExternalID: "workday-group-1", DisplayName: "Engineering",
		MemberIDs: []string{user.Membership.ID},
	})
	if err != nil || len(group.MemberIDs) != 1 {
		t.Fatalf("create SCIM group = %#v, %v", group, err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO group_memberships (
			id, organization_id, group_id, organization_membership_id,
			source, active, created_at, updated_at
		) VALUES ('cross-owner-edge', $1, $2, $3, 'scim', TRUE, $4, $4)`,
		bootstrap.Organization.ID, group.Group.ID, sharedMembership.ID, now,
	); err == nil {
		t.Fatal("database accepted a SCIM Group edge to a local-owned Membership")
	}
	_, err = scimService.CreateGroup(ctx, authorization, scim.GroupInput{
		ExternalID: "workday-group-1", DisplayName: "Engineering Updated",
		MemberIDs: []string{user.Membership.ID},
	})
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("duplicate SCIM group create error = %v, want conflict", err)
	}
	var reconciliationEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM identity_events
		WHERE event_type IN ('scim_user.reconciled', 'scim_group.reconciled')`,
	).Scan(&reconciliationEvents); err != nil {
		t.Fatalf("count SCIM reconciliation events: %v", err)
	}
	if reconciliationEvents != 0 {
		t.Fatalf("SCIM reconciliation event count = %d, want 0", reconciliationEvents)
	}
	if err := scimService.DeleteGroup(ctx, authorization, group.Group.ID); err != nil {
		t.Fatalf("delete SCIM group: %v", err)
	}
	if _, err := scimService.GetGroup(ctx, authorization, group.Group.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted SCIM group remained visible: %v", err)
	}
	recreatedGroup, err := scimService.CreateGroup(ctx, authorization, scim.GroupInput{
		ExternalID: "workday-group-1", DisplayName: "Engineering Recreated",
	})
	if err != nil || recreatedGroup.Group.ID == group.Group.ID {
		t.Fatalf("recreate deleted SCIM group = %#v, %v", recreatedGroup, err)
	}
	deleteTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin concurrent SCIM group delete: %v", err)
	}
	deletionFinished := false
	defer func() {
		if !deletionFinished {
			_ = deleteTx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	if _, err := deleteTx.Exec(ctx, `
		DELETE FROM groups
		WHERE organization_id = $1 AND id = $2 AND source = 'scim'`,
		authorization.OrganizationID, recreatedGroup.Group.ID,
	); err != nil {
		t.Fatalf("stage concurrent SCIM group delete: %v", err)
	}
	replaceResult := make(chan error, 1)
	go func() {
		_, replaceErr := scimService.ReplaceGroup(ctx, authorization, recreatedGroup.Group.ID, scim.ReplaceGroupInput{
			GroupInput: scim.GroupInput{
				ExternalID: "workday-group-1", DisplayName: "Must Not Survive Concurrent Delete",
			},
		})
		replaceResult <- replaceErr
	}()
	waitDeadline := time.Now().Add(2 * time.Second)
	for {
		var waitingForDelete bool
		if err := adminPool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity
				WHERE application_name = $1 AND wait_event_type = 'Lock'
			)`, applicationName,
		).Scan(&waitingForDelete); err != nil {
			t.Fatalf("inspect concurrent SCIM group replacement: %v", err)
		}
		if waitingForDelete {
			break
		}
		if time.Now().After(waitDeadline) {
			t.Fatal("SCIM group replacement did not wait for the concurrent delete")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := deleteTx.Commit(ctx); err != nil {
		t.Fatalf("commit concurrent SCIM group delete: %v", err)
	}
	deletionFinished = true
	if err := <-replaceResult; !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("replace concurrently deleted SCIM group error = %v, want not found", err)
	}
	var replacementEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM identity_events
		WHERE event_type = 'scim_group.replaced' AND subject_id = $1`, recreatedGroup.Group.ID,
	).Scan(&replacementEvents); err != nil {
		t.Fatalf("count concurrent SCIM replacement events: %v", err)
	}
	if replacementEvents != 0 {
		t.Fatalf("concurrently deleted SCIM group recorded %d replacement events", replacementEvents)
	}
	var scimActorTokenID string
	if err := pool.QueryRow(ctx, `
		SELECT actor_scim_token_id
		FROM identity_events
		WHERE event_type = 'scim_user.created' AND subject_id = $1`, user.Membership.ID,
	).Scan(&scimActorTokenID); err != nil {
		t.Fatalf("load SCIM audit actor: %v", err)
	}
	if scimActorTokenID != authorization.TokenID {
		t.Fatalf("SCIM audit actor = %q, want %q", scimActorTokenID, authorization.TokenID)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO api_tokens (
			id, token_hash, user_id, organization_id, membership_id, issued_at, expires_at
		) VALUES ('mismatched-token', 'mismatched-hash', $1, $2, $3, $4, $5)`,
		bootstrap.User.ID, bootstrap.Organization.ID, user.Membership.ID, now, now.Add(time.Hour),
	); err == nil {
		t.Fatal("database accepted an API token whose User and Membership belong to different people")
	}

	box, err := credentials.NewSecretBox(bytes.Repeat([]byte{9}, 32))
	if err != nil {
		t.Fatal(err)
	}
	providerSecret, err := box.Seal([]byte("client-secret"), "provider-1")
	if err != nil {
		t.Fatal(err)
	}
	provider := oidcflow.ProviderWithSecret{Provider: oidcflow.Provider{
		ID: "provider-1", OrganizationID: bootstrap.Organization.ID, Name: "workforce", DisplayName: "Workforce",
		Issuer: "https://id.example.com", ClientID: "client", ClientSecret: providerSecret,
		Scopes: []string{"openid"}, Enabled: true, Revision: 1,
		AuthorizationEndpoint: "https://id.example.com/auth", TokenEndpoint: "https://id.example.com/token",
		TokenEndpointAuthMethod: "client_secret_basic", IDTokenSigningAlgs: []string{"RS256"},
		JWKSURI: "https://id.example.com/jwks", CreatedAt: now, UpdatedAt: now,
	}}
	storedProvider, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-1", Provider: provider,
	})
	if err != nil {
		t.Fatalf("upsert OIDC provider: %v", err)
	}
	providers, err := store.OIDC().ListProviders(ctx, bootstrap.Organization.ID)
	if err != nil {
		t.Fatalf("list OIDC Provider metadata: %v", err)
	}
	if len(providers) != 1 || providers[0].ID != storedProvider.ID ||
		len(providers[0].ClientSecret.Ciphertext) != 0 || len(providers[0].ClientSecret.Nonce) != 0 {
		t.Fatalf("OIDC Provider metadata = %#v", providers)
	}
	provider.Provider = storedProvider
	competingProvider := provider
	competingProvider.ID = "provider-proposed-by-concurrent-request"
	competingProvider.Revision++
	canonicalProvider, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-1-repeat", Provider: competingProvider,
	})
	if err != nil || canonicalProvider.ID != provider.ID {
		t.Fatalf("repeat Provider canonical ID = %#v, %v; want %q", canonicalProvider, err, provider.ID)
	}
	staleProvider := competingProvider
	staleProvider.DisplayName = "Stale Workforce"
	if _, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-stale-write", Provider: staleProvider,
	}); !errors.Is(err, domain.ErrVersionConflict) {
		t.Fatalf("stale Provider write error = %v, want version conflict", err)
	}
	changedIssuer := competingProvider
	changedIssuer.Issuer = "https://replacement-id.example.com"
	if _, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-issuer-change", Provider: changedIssuer,
	}); domainErrorCode(err) != "oidc_provider_issuer_immutable" {
		t.Fatalf("replace Provider issuer error = %v, want oidc_provider_issuer_immutable", err)
	}
	disabledProvider, err := store.OIDC().SetProviderEnabled(ctx, oidcflow.SetProviderEnabledCommand{
		RequestID: "provider-disable", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: provider.Name,
		Enabled: false, UpdatedAt: now.Add(time.Second),
	})
	if err != nil || disabledProvider.Enabled {
		t.Fatalf("disable OIDC Provider = %#v, %v", disabledProvider, err)
	}
	if _, err := store.OIDC().SetProviderEnabled(ctx, oidcflow.SetProviderEnabledCommand{
		RequestID: "provider-disable-repeat", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: provider.Name,
		Enabled: false, UpdatedAt: now.Add(2 * time.Second),
	}); err != nil {
		t.Fatalf("repeat disabled OIDC Provider state: %v", err)
	}
	enabledProvider, err := store.OIDC().SetProviderEnabled(ctx, oidcflow.SetProviderEnabledCommand{
		RequestID: "provider-enable", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: provider.Name,
		Enabled: true, UpdatedAt: now.Add(3 * time.Second),
	})
	if err != nil || !enabledProvider.Enabled {
		t.Fatalf("enable OIDC Provider = %#v, %v", enabledProvider, err)
	}
	provider.Provider = enabledProvider
	var disabledEvents, enabledEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FILTER (WHERE event_type = 'oidc_provider.disabled'),
		       count(*) FILTER (WHERE event_type = 'oidc_provider.enabled')
		FROM identity_events
		WHERE subject_id = $1`, provider.ID,
	).Scan(&disabledEvents, &enabledEvents); err != nil {
		t.Fatalf("inspect OIDC Provider lifecycle events: %v", err)
	}
	if disabledEvents != 1 || enabledEvents != 1 {
		t.Fatalf("OIDC Provider lifecycle events disabled=%d enabled=%d, want 1/1", disabledEvents, enabledEvents)
	}
	raceSessionSecrets, err := box.Seal([]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`), "session-provider-race")
	if err != nil {
		t.Fatal(err)
	}
	raceState := "provider-race-state"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-provider-race", StateHash: credentials.HashToken(raceState),
		Session: oidcflow.AuthSession{
			ID: "session-provider-race", ProviderID: provider.ID, OrganizationID: bootstrap.Organization.ID,
			ProviderRevision: provider.Revision, Status: oidcflow.SessionStatusPending,
			Secrets: raceSessionSecrets, ExpiresAt: now.Add(time.Hour), CreatedAt: now,
		},
	}); err != nil {
		t.Fatalf("create Provider-race OIDC session: %v", err)
	}
	if _, err := store.OIDC().ClaimSession(ctx, credentials.HashToken(raceState), "provider-race-claim", now); err != nil {
		t.Fatalf("claim Provider-race OIDC session: %v", err)
	}
	provider.Provider, err = store.OIDC().SetProviderEnabled(ctx, oidcflow.SetProviderEnabledCommand{
		RequestID: "provider-race-disable", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: provider.Name,
		Enabled: false, UpdatedAt: now.Add(4 * time.Second),
	})
	if err != nil {
		t.Fatalf("change Provider during OIDC session: %v", err)
	}
	if _, err := store.OIDC().CompleteLogin(ctx, oidcflow.CompleteLoginCommand{
		SessionID: "session-provider-race", ProviderID: provider.ID,
		OrganizationID: bootstrap.Organization.ID, ClaimID: "provider-race-claim",
		Identity: oidcflow.VerifiedIdentity{
			Issuer: provider.Issuer, Subject: "provider-race-subject",
			Email: "research-admin@example.com", EmailVerified: true,
		},
		AccessTokenID: "provider-race-token", AccessTokenHash: credentials.HashToken("provider-race-token"),
		IssuedAt: now, ExpiresAt: now.Add(time.Hour),
	}); domainErrorCode(err) != "oidc_provider_changed" {
		t.Fatalf("commit-time Provider revision error = %v, want oidc_provider_changed", err)
	}
	provider.Provider, err = store.OIDC().SetProviderEnabled(ctx, oidcflow.SetProviderEnabledCommand{
		RequestID: "provider-race-enable", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, Name: provider.Name,
		Enabled: true, UpdatedAt: now.Add(5 * time.Second),
	})
	if err != nil {
		t.Fatalf("restore Provider after revision test: %v", err)
	}
	sessionSecrets, err := box.Seal([]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`), "session-1")
	if err != nil {
		t.Fatal(err)
	}
	state := "state-secret"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-1", StateHash: credentials.HashToken(state),
		Session: oidcflow.AuthSession{
			ID: "session-1", ProviderID: provider.ID, OrganizationID: bootstrap.Organization.ID,
			ProviderRevision: provider.Revision,
			Status:           oidcflow.SessionStatusPending, Secrets: sessionSecrets,
			ExpiresAt: now.Add(10 * time.Minute), CreatedAt: now,
		},
	}); err != nil {
		t.Fatalf("create OIDC session: %v", err)
	}
	claim, err := store.OIDC().ClaimSession(ctx, credentials.HashToken(state), "claim-1", now)
	if err != nil || claim.Disposition != oidcflow.ClaimAcquired {
		t.Fatalf("claim OIDC session = %#v, %v", claim, err)
	}
	_, accessHash, err := credentials.NewOpaqueToken("ant_api_")
	if err != nil {
		t.Fatal(err)
	}
	completed, err := store.OIDC().CompleteLogin(ctx, oidcflow.CompleteLoginCommand{
		SessionID: "session-1", ProviderID: provider.ID, OrganizationID: bootstrap.Organization.ID,
		ClaimID: "claim-1", Identity: oidcflow.VerifiedIdentity{
			Issuer: provider.Issuer, Subject: "subject-1", Email: "research-admin@example.com",
			EmailVerified: true, DisplayName: "Provider Display Name",
		},
		AccessTokenID: "oidc-token-1", AccessTokenHash: accessHash,
		IssuedAt: now, ExpiresAt: now.Add(12 * time.Hour),
	})
	if err != nil || completed.Principal.UserID == "" || completed.TokenID != "oidc-token-1" {
		t.Fatalf("complete OIDC login = %#v, %v", completed, err)
	}
	if completed.Principal.UserID != secondaryUser.User.ID ||
		completed.Principal.MembershipID != sharedMembership.ID {
		t.Fatalf("OIDC did not bind the existing organization Membership: %#v", completed.Principal)
	}
	var primaryDisplayName, secondaryDisplayName string
	if err := pool.QueryRow(ctx, `
		SELECT display_name FROM organization_memberships WHERE id = $1`, sharedMembership.ID,
	).Scan(&primaryDisplayName); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `
		SELECT display_name FROM organization_memberships WHERE id = $1`, secondaryUser.Membership.ID,
	).Scan(&secondaryDisplayName); err != nil {
		t.Fatal(err)
	}
	if primaryDisplayName != "Research Administrator" || secondaryDisplayName != "Research Administrator" {
		t.Fatalf("OIDC rewrote locally owned profiles: primary=%q secondary=%q", primaryDisplayName, secondaryDisplayName)
	}
	var sessionEventCount, sessionRequestIDs int
	var completedEventTokenID, completedEventExternalIdentityID string
	if err := pool.QueryRow(ctx, `
		SELECT count(*), count(DISTINCT request_id)
		FROM identity_events
		WHERE subject_type = 'oidc_auth_session' AND subject_id = 'session-1'
		  AND event_type IN ('oidc_login.started', 'oidc_login.claimed', 'oidc_login.completed')`,
	).Scan(&sessionEventCount, &sessionRequestIDs); err != nil {
		t.Fatalf("inspect OIDC session audit correlation: %v", err)
	}
	if sessionEventCount != 3 || sessionRequestIDs != 1 {
		t.Fatalf("OIDC session events=%d request IDs=%d, want 3/1", sessionEventCount, sessionRequestIDs)
	}
	if err := pool.QueryRow(ctx, `
		SELECT metadata->>'token_id', metadata->>'external_identity_id'
		FROM identity_events
		WHERE event_type = 'oidc_login.completed' AND subject_id = 'session-1'`,
	).Scan(&completedEventTokenID, &completedEventExternalIdentityID); err != nil {
		t.Fatalf("inspect OIDC completion audit metadata: %v", err)
	}
	if completedEventTokenID != completed.TokenID || completedEventExternalIdentityID == "" {
		t.Fatalf("OIDC completion metadata token=%q external_identity=%q", completedEventTokenID, completedEventExternalIdentityID)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO external_identities (
			id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at
		) VALUES ('duplicate-subject-owner', $1, $2, $3, $4, 'subject-2', $5, $5)`,
		bootstrap.Organization.ID, provider.ID, completed.Principal.UserID,
		completed.Principal.MembershipID, now,
	); err == nil {
		t.Fatal("database accepted two Provider subjects for the same User")
	}
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "provider-organization-mismatch", StateHash: credentials.HashToken("provider-organization-mismatch"),
		Session: oidcflow.AuthSession{
			ID: "provider-organization-mismatch", ProviderID: provider.ID,
			OrganizationID: secondaryOrganization.ID, ProviderRevision: provider.Revision,
			Status:  oidcflow.SessionStatusPending,
			Secrets: sessionSecrets, ExpiresAt: now.Add(time.Hour), CreatedAt: now,
		},
	}); err == nil {
		t.Fatal("database accepted an OIDC session whose Provider belongs to another Organization")
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO external_identities (
			id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at
		) VALUES ('provider-organization-mismatch', $1, $2, $3, $4, 'subject-provider-mismatch', $5, $5)`,
		secondaryOrganization.ID, provider.ID, secondaryUser.User.ID, secondaryUser.Membership.ID, now,
	); err == nil {
		t.Fatal("database accepted an External Identity whose Provider belongs to another Organization")
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO external_identities (
			id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at
		) VALUES ('membership-user-mismatch', $1, $2, $3, $4, 'subject-membership-mismatch', $5, $5)`,
		bootstrap.Organization.ID, provider.ID, completed.Principal.UserID, sharedMembership.ID, now,
	); err == nil {
		t.Fatal("database accepted an External Identity whose Membership belongs to another User")
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO oidc_auth_sessions (
			id, provider_id, organization_id, provider_revision, state_hash, request_id, status,
			secret_ciphertext, secret_nonce, expires_at,
			claim_id, claimed_at,
			completed_user_id, completed_membership_id, completed_access_token_id, completed_at,
			created_at, updated_at
		) VALUES (
			'completed-token-mismatch', $1, $2, $3, $4, 'completed-token-mismatch', 'completed',
			$5, $6, $7, 'completed-token-mismatch-claim', $11,
			$8, $9, $10, $11, $11, $11
		)`,
		provider.ID, bootstrap.Organization.ID, provider.Revision,
		credentials.HashToken("completed-token-mismatch"),
		sessionSecrets.Ciphertext, sessionSecrets.Nonce, now.Add(time.Hour),
		secondaryOrganizationLogin.Principal.UserID, secondaryOrganizationLogin.Principal.MembershipID,
		secondaryOrganizationLogin.TokenID, now,
	); err == nil {
		t.Fatal("database accepted a completed OIDC session with a Token from another Organization")
	}
	replay, err := store.OIDC().ClaimSession(ctx, credentials.HashToken(state), "claim-2", now)
	if err != nil || replay.Disposition != oidcflow.ClaimCompleted || replay.Completed.Principal != completed.Principal {
		t.Fatalf("replay OIDC login = %#v, %v", replay, err)
	}
	_, err = store.OIDC().ClaimSession(ctx, credentials.HashToken(state), "claim-3", now.Add(13*time.Hour))
	code, _, _ := domain.ErrorDetails(err)
	if code != "oidc_completed_token_unavailable" {
		t.Fatalf("expired OIDC replay error = %v (%s), want oidc_completed_token_unavailable", err, code)
	}

	provider2Secret, err := box.Seal([]byte("client-secret-2"), "provider-2")
	if err != nil {
		t.Fatal(err)
	}
	provider2 := oidcflow.ProviderWithSecret{Provider: oidcflow.Provider{
		ID: "provider-2", OrganizationID: secondaryOrganization.ID,
		Name: "workforce", DisplayName: "Workforce", Issuer: "https://id.example.com",
		ClientID: "client-2", ClientSecret: provider2Secret,
		Scopes: []string{"openid", "email"}, Enabled: true, Revision: 1,
		AuthorizationEndpoint: "https://id.example.com/auth", TokenEndpoint: "https://id.example.com/token",
		TokenEndpointAuthMethod: "client_secret_basic", IDTokenSigningAlgs: []string{"RS256"},
		JWKSURI: "https://id.example.com/jwks", CreatedAt: now, UpdatedAt: now,
	}}
	if _, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-2", Provider: provider2,
	}); err != nil {
		t.Fatalf("upsert second-organization Provider: %v", err)
	}
	secondSessionSecrets, err := box.Seal([]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`), "session-2")
	if err != nil {
		t.Fatal(err)
	}
	secondState := "state-secret-2"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-2", StateHash: credentials.HashToken(secondState),
		Session: oidcflow.AuthSession{
			ID: "session-2", ProviderID: provider2.ID, OrganizationID: secondaryOrganization.ID,
			ProviderRevision: provider2.Revision,
			Status:           oidcflow.SessionStatusPending, Secrets: secondSessionSecrets,
			ExpiresAt: now.Add(10 * time.Minute), CreatedAt: now,
		},
	}); err != nil {
		t.Fatalf("create second OIDC session: %v", err)
	}
	if _, err := store.OIDC().ClaimSession(ctx, credentials.HashToken(secondState), "claim-2", now); err != nil {
		t.Fatalf("claim second OIDC session: %v", err)
	}
	_, err = store.OIDC().CompleteLogin(ctx, oidcflow.CompleteLoginCommand{
		SessionID: "session-2", ProviderID: provider2.ID, OrganizationID: secondaryOrganization.ID,
		ClaimID: "claim-2", Identity: oidcflow.VerifiedIdentity{
			Issuer: provider2.Issuer, Subject: "subject-cross-org", Email: "alice@example.com",
			EmailVerified: true, DisplayName: "Cross Organization",
		},
		AccessTokenID: "cross-org-token", AccessTokenHash: credentials.HashToken("cross-org-token"),
		IssuedAt: now, ExpiresAt: now.Add(time.Hour),
	})
	if domainErrorCode(err) != "oidc_membership_required" {
		t.Fatalf("OIDC without an existing Organization Membership error = %v", err)
	}

	expiredSecrets, err := box.Seal([]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`), "session-expired")
	if err != nil {
		t.Fatal(err)
	}
	expiredState := "expired-state"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-expired", StateHash: credentials.HashToken(expiredState),
		Session: oidcflow.AuthSession{
			ID: "session-expired", ProviderID: provider.ID, OrganizationID: bootstrap.Organization.ID,
			ProviderRevision: provider.Revision,
			Status:           oidcflow.SessionStatusPending, Secrets: expiredSecrets,
			ExpiresAt: now.Add(-time.Minute), CreatedAt: now.Add(-time.Hour),
		},
	}); err != nil {
		t.Fatalf("create expired OIDC session: %v", err)
	}
	expiredClaim, err := store.OIDC().ClaimSession(ctx, credentials.HashToken(expiredState), "expired-claim", now)
	if err != nil || expiredClaim.Disposition != oidcflow.ClaimExpired {
		t.Fatalf("claim expired OIDC session = %#v, %v", expiredClaim, err)
	}
	var expiredStatus string
	if err := pool.QueryRow(ctx, `SELECT status FROM oidc_auth_sessions WHERE id = 'session-expired'`).Scan(&expiredStatus); err != nil {
		t.Fatal(err)
	}
	if expiredStatus != string(oidcflow.SessionStatusFailed) {
		t.Fatalf("expired OIDC status = %q", expiredStatus)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO external_identities (
			id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at
		) VALUES ('scim-user-oidc', $1, $2, $3, $4, 'scim-subject', $5, $5)`,
		authorization.OrganizationID, provider.ID, user.User.ID, user.Membership.ID, now,
	); err != nil {
		t.Fatalf("bind SCIM user to OIDC subject: %v", err)
	}
	raceUser, err := scimService.CreateUser(ctx, authorization, scim.UserInput{
		ExternalID: "oidc-delete-race", UserName: "oidc.delete.race",
		Email: "oidc-delete-race@example.com", DisplayName: "OIDC Delete Race", Active: true,
	})
	if err != nil {
		t.Fatalf("create OIDC-delete race user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO external_identities (
			id, organization_id, provider_id, user_id, membership_id, subject, created_at, updated_at
		) VALUES ('oidc-delete-race', $1, $2, $3, $4, 'oidc-delete-race', $5, $5)`,
		authorization.OrganizationID, provider.ID, raceUser.User.ID, raceUser.Membership.ID, now,
	); err != nil {
		t.Fatalf("bind OIDC-delete race identity: %v", err)
	}
	raceSecrets, err := box.Seal(
		[]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`),
		"session-oidc-delete-race",
	)
	if err != nil {
		t.Fatal(err)
	}
	deleteRaceState := "oidc-delete-race-state"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-oidc-delete-race", StateHash: credentials.HashToken(deleteRaceState),
		Session: oidcflow.AuthSession{
			ID: "session-oidc-delete-race", ProviderID: provider.ID,
			OrganizationID: authorization.OrganizationID, ProviderRevision: provider.Revision,
			Status: oidcflow.SessionStatusPending, Secrets: raceSecrets,
			ExpiresAt: now.Add(time.Hour), CreatedAt: now,
		},
	}); err != nil {
		t.Fatalf("create OIDC-delete race session: %v", err)
	}
	if _, err := store.OIDC().ClaimSession(
		ctx,
		credentials.HashToken(deleteRaceState),
		"oidc-delete-race-claim",
		now,
	); err != nil {
		t.Fatalf("claim OIDC-delete race session: %v", err)
	}
	raceDeleteTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin OIDC-delete race transaction: %v", err)
	}
	raceDeleteFinished := false
	defer func() {
		if !raceDeleteFinished {
			_ = raceDeleteTx.Rollback(context.WithoutCancel(ctx))
		}
	}()
	if _, err := raceDeleteTx.Exec(ctx, `
		SELECT 1
		FROM organization_memberships
		WHERE organization_id = $1 AND id = $2
		FOR UPDATE`, authorization.OrganizationID, raceUser.Membership.ID,
	); err != nil {
		t.Fatalf("lock OIDC-delete race Membership: %v", err)
	}
	raceLoginResult := make(chan error, 1)
	go func() {
		_, completionErr := store.OIDC().CompleteLogin(ctx, oidcflow.CompleteLoginCommand{
			SessionID: "session-oidc-delete-race", ProviderID: provider.ID,
			OrganizationID: authorization.OrganizationID, ClaimID: "oidc-delete-race-claim",
			Identity: oidcflow.VerifiedIdentity{
				Issuer: provider.Issuer, Subject: "oidc-delete-race",
				Email: raceUser.Membership.Email, EmailVerified: true,
			},
			AccessTokenID:   "oidc-delete-race-token",
			AccessTokenHash: credentials.HashToken("oidc-delete-race-token"),
			IssuedAt:        now.Add(time.Minute), ExpiresAt: now.Add(time.Hour),
		})
		raceLoginResult <- completionErr
	}()
	raceWaitDeadline := time.Now().Add(2 * time.Second)
	for {
		var waitingForMembership bool
		if err := adminPool.QueryRow(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM pg_stat_activity
				WHERE application_name = $1 AND wait_event_type = 'Lock'
				  AND query LIKE '%FOR UPDATE OF u, m, o%'
			)`, applicationName,
		).Scan(&waitingForMembership); err != nil {
			t.Fatalf("inspect OIDC-delete race: %v", err)
		}
		if waitingForMembership {
			break
		}
		if time.Now().After(raceWaitDeadline) {
			t.Fatal("OIDC completion did not lock the target Membership")
		}
		time.Sleep(10 * time.Millisecond)
	}
	raceDeletedAt := now.Add(2 * time.Minute)
	if _, err := raceDeleteTx.Exec(ctx, `
		UPDATE organization_memberships
		SET active = FALSE, scim_deleted_at = $3, updated_at = $3
		WHERE organization_id = $1 AND id = $2`,
		authorization.OrganizationID, raceUser.Membership.ID, raceDeletedAt,
	); err != nil {
		t.Fatalf("tombstone OIDC-delete race Membership: %v", err)
	}
	if err := raceDeleteTx.Commit(ctx); err != nil {
		t.Fatalf("commit OIDC-delete race transaction: %v", err)
	}
	raceDeleteFinished = true
	if err := <-raceLoginResult; domainErrorCode(err) != "oidc_membership_required" {
		t.Fatalf("OIDC completion concurrent with SCIM delete error = %v, want oidc_membership_required", err)
	}
	var racedTokenCount int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM api_tokens WHERE id = 'oidc-delete-race-token'`).
		Scan(&racedTokenCount); err != nil {
		t.Fatalf("inspect OIDC-delete race token: %v", err)
	}
	if racedTokenCount != 0 {
		t.Fatalf("OIDC completion committed %d token rows for a deleted Membership", racedTokenCount)
	}
	affectedGroup, err := scimService.CreateGroup(ctx, authorization, scim.GroupInput{
		ExternalID: "delete-user-group", DisplayName: "Delete User Group",
		MemberIDs: []string{user.Membership.ID},
	})
	if err != nil {
		t.Fatalf("create group affected by SCIM user deletion: %v", err)
	}
	userBeforeDelete, err := scimService.GetUser(ctx, authorization, user.Membership.ID)
	if err != nil {
		t.Fatalf("load SCIM user before deletion: %v", err)
	}
	if err := scimService.DeleteUser(ctx, authorization, user.Membership.ID); err != nil {
		t.Fatalf("delete SCIM user: %v", err)
	}
	var tombstoneUpdatedAt, tombstoneDeletedAt time.Time
	if err := pool.QueryRow(ctx, `
		SELECT updated_at, scim_deleted_at
		FROM organization_memberships
		WHERE organization_id = $1 AND id = $2`, authorization.OrganizationID, user.Membership.ID,
	).Scan(&tombstoneUpdatedAt, &tombstoneDeletedAt); err != nil {
		t.Fatalf("inspect SCIM user tombstone version: %v", err)
	}
	if !tombstoneUpdatedAt.After(userBeforeDelete.Membership.UpdatedAt) ||
		!tombstoneDeletedAt.Equal(tombstoneUpdatedAt) {
		t.Fatalf(
			"SCIM tombstone version updated=%s deleted=%s previous=%s",
			tombstoneUpdatedAt,
			tombstoneDeletedAt,
			userBeforeDelete.Membership.UpdatedAt,
		)
	}
	updatedAffectedGroup, err := scimService.GetGroup(ctx, authorization, affectedGroup.Group.ID)
	if err != nil {
		t.Fatalf("load group after SCIM user deletion: %v", err)
	}
	if len(updatedAffectedGroup.MemberIDs) != 0 ||
		!updatedAffectedGroup.Group.UpdatedAt.After(affectedGroup.Group.UpdatedAt) {
		t.Fatalf("group version did not reflect deleted member: %#v", updatedAffectedGroup)
	}
	if _, err := scimService.GetUser(ctx, authorization, user.Membership.ID); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("deleted SCIM user remained visible: %v", err)
	}
	deletedPage, err := scimService.ListUsers(ctx, authorization, scim.ListQuery{StartIndex: 1, Count: 100})
	if err != nil {
		t.Fatalf("list users after SCIM delete: %v", err)
	}
	for _, item := range deletedPage.Items {
		if item.Membership.ID == user.Membership.ID {
			t.Fatalf("deleted SCIM user remained in list: %#v", item)
		}
	}
	recreatedUser, err := scimService.CreateUser(ctx, authorization, scim.UserInput{
		ExternalID: "workday-user-1", UserName: "alice.employee", Email: "alice@example.com",
		DisplayName: "Alice Recreated", Active: true,
	})
	if err != nil || recreatedUser.Membership.ID == user.Membership.ID || recreatedUser.User.ID != user.User.ID {
		t.Fatalf("recreate deleted SCIM user = %#v, %v", recreatedUser, err)
	}
	var reboundMembershipID string
	if err := pool.QueryRow(ctx, `
		SELECT membership_id
		FROM external_identities
		WHERE id = 'scim-user-oidc'`,
	).Scan(&reboundMembershipID); err != nil {
		t.Fatalf("inspect reprovisioned OIDC binding: %v", err)
	}
	if reboundMembershipID != recreatedUser.Membership.ID {
		t.Fatalf("OIDC binding membership = %q, want %q", reboundMembershipID, recreatedUser.Membership.ID)
	}
	reprovisionSecrets, err := box.Seal(
		[]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`),
		"session-reprovisioned-user",
	)
	if err != nil {
		t.Fatal(err)
	}
	reprovisionState := "reprovisioned-user-state"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-reprovisioned-user", StateHash: credentials.HashToken(reprovisionState),
		Session: oidcflow.AuthSession{
			ID: "session-reprovisioned-user", ProviderID: provider.ID,
			OrganizationID: authorization.OrganizationID, ProviderRevision: provider.Revision,
			Status: oidcflow.SessionStatusPending, Secrets: reprovisionSecrets,
			ExpiresAt: now.Add(time.Hour), CreatedAt: now,
		},
	}); err != nil {
		t.Fatalf("create reprovisioned-user OIDC session: %v", err)
	}
	if _, err := store.OIDC().ClaimSession(
		ctx,
		credentials.HashToken(reprovisionState),
		"reprovisioned-user-claim",
		now,
	); err != nil {
		t.Fatalf("claim reprovisioned-user OIDC session: %v", err)
	}
	reprovisionedLogin, err := store.OIDC().CompleteLogin(ctx, oidcflow.CompleteLoginCommand{
		SessionID: "session-reprovisioned-user", ProviderID: provider.ID,
		OrganizationID: authorization.OrganizationID, ClaimID: "reprovisioned-user-claim",
		Identity: oidcflow.VerifiedIdentity{
			Issuer: provider.Issuer, Subject: "scim-subject", Email: recreatedUser.Membership.Email,
			EmailVerified: true,
		},
		AccessTokenID:   "reprovisioned-user-token",
		AccessTokenHash: credentials.HashToken("reprovisioned-user-token"),
		IssuedAt:        now.Add(time.Minute), ExpiresAt: now.Add(time.Hour),
	})
	if err != nil || reprovisionedLogin.Principal.MembershipID != recreatedUser.Membership.ID {
		t.Fatalf("login after SCIM reprovisioning = %#v, %v", reprovisionedLogin, err)
	}

	secondAdminID := "system-admin-2"
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, system_role, active, created_at, updated_at)
		VALUES ($1, 'admin', TRUE, $2, $2)`, secondAdminID, now,
	); err != nil {
		t.Fatalf("create second system administrator: %v", err)
	}
	if _, err := directoryService.AddOrganizationMembership(ctx, directory.AddOrganizationMembershipInput{
		RequestID: "add-second-system-administrator", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, UserID: secondAdminID,
		Email: "system-admin-2@example.com", DisplayName: "Second System Administrator",
		Role: domain.OrganizationRoleAdmin,
	}); err != nil {
		t.Fatalf("add second system administrator Membership: %v", err)
	}
	startAdminRace := make(chan struct{})
	adminRaceResults := make(chan error, 2)
	go func() {
		<-startAdminRace
		adminRaceResults <- store.Directory().SetUserActive(ctx, directory.SetUserActiveCommand{
			ActorPrincipalID: bootstrap.User.ID, UserID: secondAdminID, Active: false,
			UpdatedAt: now.Add(2 * time.Minute),
		})
	}()
	go func() {
		<-startAdminRace
		adminRaceResults <- store.Directory().SetUserActive(ctx, directory.SetUserActiveCommand{
			ActorPrincipalID: secondAdminID, UserID: bootstrap.User.ID, Active: false,
			UpdatedAt: now.Add(2 * time.Minute),
		})
	}()
	close(startAdminRace)
	adminRaceErrors := []error{<-adminRaceResults, <-adminRaceResults}
	successes := 0
	for _, raceErr := range adminRaceErrors {
		if raceErr == nil {
			successes++
			continue
		}
		if !errors.Is(raceErr, domain.ErrForbidden) {
			t.Fatalf("concurrent administrator deactivation error = %v", raceErr)
		}
	}
	if successes != 1 {
		t.Fatalf("concurrent administrator deactivation successes = %d, want 1", successes)
	}
	var activeAdministratorCount int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM users WHERE system_role = 'admin' AND active`,
	).Scan(&activeAdministratorCount); err != nil {
		t.Fatalf("count active system administrators: %v", err)
	}
	if activeAdministratorCount != 1 {
		t.Fatalf("active system administrators = %d, want 1", activeAdministratorCount)
	}
}

func domainErrorCode(err error) string {
	code, _, _ := domain.ErrorDetails(err)
	return code
}
