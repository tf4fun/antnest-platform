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
	poolConfig, err := pgxpool.ParseConfig(databaseURL)
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
	store, err := New(pool, func() string { return fmt.Sprintf("id-%d", sequence.Add(1)) })
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 8, 31, 5, 0, 0, 0, time.UTC)
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
	secondaryOrganization, err := directoryService.CreateOrganization(ctx, directory.CreateOrganizationInput{
		RequestID: "organization-2", ActorPrincipalID: bootstrap.User.ID,
		Slug: "research", Name: "Research",
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
	sharedMembership, err := directoryService.AddOrganizationMembership(ctx, directory.AddOrganizationMembershipInput{
		RequestID: "share-secondary-user", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, UserID: secondaryUser.User.ID,
		Role: domain.OrganizationRoleMember,
	})
	if err != nil || sharedMembership.UserID != secondaryUser.User.ID ||
		sharedMembership.OrganizationID != bootstrap.Organization.ID {
		t.Fatalf("add existing User to another organization = %#v, %v", sharedMembership, err)
	}
	repeatedMembership, err := directoryService.AddOrganizationMembership(ctx, directory.AddOrganizationMembershipInput{
		RequestID: "share-secondary-user-again", ActorPrincipalID: bootstrap.User.ID,
		OrganizationID: bootstrap.Organization.ID, UserID: secondaryUser.User.ID,
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
	authorization, err := scimService.Authorize(ctx, scimToken.Credential, domain.SCIMScopeRead)
	if err != nil {
		t.Fatalf("authorize SCIM token: %v", err)
	}
	user, err := scimService.CreateUser(ctx, authorization, scim.UserInput{
		ExternalID: "workday-user-1", UserName: "alice@example.com", DisplayName: "Alice", Active: true,
	})
	if err != nil {
		t.Fatalf("create SCIM user: %v", err)
	}
	repeatedUser, err := scimService.CreateUser(ctx, authorization, scim.UserInput{
		ExternalID: "workday-user-1", UserName: "alice@example.com", DisplayName: "Alice Updated", Active: true,
	})
	if err != nil || repeatedUser.Membership.ID != user.Membership.ID || repeatedUser.User.ID != user.User.ID {
		t.Fatalf("repeat SCIM user = %#v, %v", repeatedUser, err)
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
	repeatedGroup, err := scimService.CreateGroup(ctx, authorization, scim.GroupInput{
		ExternalID: "workday-group-1", DisplayName: "Engineering Updated",
		MemberIDs: []string{user.Membership.ID},
	})
	if err != nil || repeatedGroup.Group.ID != group.Group.ID {
		t.Fatalf("repeat SCIM group = %#v, %v", repeatedGroup, err)
	}
	var reconciliationEvents int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM identity_events
		WHERE event_type IN ('scim_user.reconciled', 'scim_group.reconciled')`,
	).Scan(&reconciliationEvents); err != nil {
		t.Fatalf("count SCIM reconciliation events: %v", err)
	}
	if reconciliationEvents != 2 {
		t.Fatalf("SCIM reconciliation event count = %d, want 2", reconciliationEvents)
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
		_, replaceErr := scimService.ReplaceGroup(ctx, authorization, recreatedGroup.Group.ID, scim.GroupInput{
			ExternalID: "workday-group-1", DisplayName: "Must Not Survive Concurrent Delete",
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
		RedirectURI: "https://identity.example.com/protocol/oidc/callback", Scopes: []string{"openid"}, Enabled: true,
		AuthorizationEndpoint: "https://id.example.com/auth", TokenEndpoint: "https://id.example.com/token",
		JWKSURI: "https://id.example.com/jwks", CreatedAt: now, UpdatedAt: now,
	}}
	storedProvider, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-1", Provider: provider,
	})
	if err != nil {
		t.Fatalf("upsert OIDC provider: %v", err)
	}
	provider.Provider = storedProvider
	competingProvider := provider
	competingProvider.Provider.ID = "provider-proposed-by-concurrent-request"
	canonicalProvider, err := store.OIDC().UpsertProvider(ctx, oidcflow.UpsertProviderCommand{
		ActorPrincipalID: bootstrap.User.ID, RequestID: "provider-1-repeat", Provider: competingProvider,
	})
	if err != nil || canonicalProvider.ID != provider.ID {
		t.Fatalf("repeat Provider canonical ID = %#v, %v; want %q", canonicalProvider, err, provider.ID)
	}
	changedIssuer := competingProvider
	changedIssuer.Provider.Issuer = "https://replacement-id.example.com"
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
	sessionSecrets, err := box.Seal([]byte(`{"nonce":"nonce","pkce_verifier":"verifier"}`), "session-1")
	if err != nil {
		t.Fatal(err)
	}
	state := "state-secret"
	if err := store.OIDC().CreateSession(ctx, oidcflow.CreateSessionCommand{
		RequestID: "session-1", StateHash: credentials.HashToken(state),
		Session: oidcflow.AuthSession{
			ID: "session-1", ProviderID: provider.ID, OrganizationID: bootstrap.Organization.ID,
			Status: oidcflow.SessionStatusPending, Secrets: sessionSecrets,
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
			Issuer: provider.Issuer, Subject: "subject-1", Email: "oidc@example.com",
			EmailVerified: true, DisplayName: "OIDC User",
		},
		AccessTokenID: "oidc-token-1", AccessTokenHash: accessHash,
		IssuedAt: now, ExpiresAt: now.Add(12 * time.Hour),
	})
	if err != nil || completed.Principal.UserID == "" || completed.TokenID != "oidc-token-1" {
		t.Fatalf("complete OIDC login = %#v, %v", completed, err)
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
			OrganizationID: secondaryOrganization.ID, Status: oidcflow.SessionStatusPending,
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
			id, provider_id, organization_id, state_hash, request_id, status,
			secret_ciphertext, secret_nonce, expires_at,
			completed_user_id, completed_membership_id, completed_access_token_id, completed_at,
			created_at, updated_at
		) VALUES (
			'completed-token-mismatch', $1, $2, $3, 'completed-token-mismatch', 'completed',
			$4, $5, $6, $7, $8, $9, $10, $10, $10
		)`,
		provider.ID, bootstrap.Organization.ID, credentials.HashToken("completed-token-mismatch"),
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
		RedirectURI: "https://identity.example.com/protocol/oidc/callback",
		Scopes:      []string{"openid", "email"}, Enabled: true,
		AuthorizationEndpoint: "https://id.example.com/auth", TokenEndpoint: "https://id.example.com/token",
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
			Status: oidcflow.SessionStatusPending, Secrets: secondSessionSecrets,
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
	if !errors.Is(err, domain.ErrConflict) {
		t.Fatalf("cross-organization email binding error = %v, want conflict", err)
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
			Status: oidcflow.SessionStatusPending, Secrets: expiredSecrets,
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
}

func domainErrorCode(err error) string {
	code, _, _ := domain.ErrorDetails(err)
	return code
}
