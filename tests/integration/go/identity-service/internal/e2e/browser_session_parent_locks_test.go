package e2e

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestBrowserOIDCAndRoleChangeShareParentLockOrder(t *testing.T) {
	for _, test := range []struct {
		name, binding string
		authoritative bool
	}{
		{name: "trusted-first-email", binding: "first-email", authoritative: true},
		{name: "trusted-existing-subject", binding: "existing-subject", authoritative: true},
		{name: "untrusted-first-email", binding: "first-email"},
		{name: "untrusted-existing-subject", binding: "existing-subject"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := browserOIDCFixture(t)
			f.providerInput.Authoritative = &test.authoritative
			if _, err := f.flow.UpsertProvider(t.Context(), f.providerInput); err != nil {
				t.Fatal(err)
			}
			wantTokens := 1
			wantLinks := 1
			deny := test.binding == "first-email" && !test.authoritative
			if deny {
				wantTokens, wantLinks = 0, 0
			}
			if test.binding == "existing-subject" {
				if _, err := f.flow.CompleteLogin(t.Context(), f.start(t)); err != nil {
					t.Fatal(err)
				}
				wantTokens++
			}
			input := f.start(t)
			ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
			var workers sync.WaitGroup
			defer func() { cancel(); workers.Wait() }()
			roleAtMembership := make(chan uint32, 1)
			releaseRole := make(chan struct{})
			var roleCaptured sync.Once
			roleStore := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "SELECT source, role") && strings.Contains(sql, "FOR UPDATE") {
					roleCaptured.Do(func() {
						roleAtMembership <- conn.PgConn().PID()
						select {
						case <-releaseRole:
						case <-ctx.Done():
						}
					})
				}
			})
			roleDone := make(chan error, 1)
			workers.Go(func() {
				_, err := directory.NewService(roleStore.Directory(), f.newID, f.time, testPasswordEngine(t)).UpdateMembership(ctx, directory.UpdateMembershipInput{
					RequestID: "role-while-login", ActorPrincipalID: f.admin.User.ID,
					OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID,
					Email: f.user.Membership.Email, DisplayName: f.user.Membership.DisplayName,
					Role: domain.OrganizationRoleAdmin, Active: true,
				})
				roleDone <- err
			})
			var rolePID uint32
			select {
			case rolePID = <-roleAtMembership:
			case err := <-roleDone:
				t.Fatalf("role mutation did not acquire the User authority parent: %v", err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			oidcPID := make(chan uint32, 1)
			var loginCaptured sync.Once
			f.repository.Repository = f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
				if strings.Contains(sql, "users") && strings.Contains(sql, "FOR UPDATE") {
					loginCaptured.Do(func() { oidcPID <- conn.PgConn().PID() })
				}
			}).OIDC()
			type outcome struct {
				result oidcflow.CompleteLoginResult
				err    error
			}
			loginDone := make(chan outcome, 1)
			workers.Go(func() { result, err := f.flow.CompleteLogin(ctx, input); loginDone <- outcome{result, err} })
			select {
			case id := <-oidcPID:
				waitForDatabaseLock(t, ctx, f.pool, id)
				var blocked bool
				if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, rolePID, id).Scan(&blocked); err != nil || !blocked {
					t.Fatalf("OIDC did not wait on the role transaction: %v", err)
				}
			case result := <-loginDone:
				t.Fatalf("OIDC bypassed User authority parent lock: %v", result.err)
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			close(releaseRole)
			select {
			case err := <-roleDone:
				if err != nil {
					t.Fatalf("role change did not commit: %v", err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			select {
			case result := <-loginDone:
				if deny {
					if code, _, _ := domain.ErrorDetails(result.err); code != "oidc_membership_required" || result.result.AccessToken != "" {
						t.Fatalf("untrusted Provider auto-linked a member promoted during lock wait: %v", result.err)
					}
				} else if result.err != nil || result.result.Principal.OrganizationRole != domain.OrganizationRoleAdmin ||
					result.result.Principal.UserID != f.user.User.ID || result.result.Principal.OrganizationID != f.admin.Organization.ID ||
					result.result.Principal.MembershipID != f.user.Membership.ID || result.result.AccessToken == "" {
					var databaseError *pgconn.PgError
					if errors.As(result.err, &databaseError) {
						t.Logf("OIDC persistence SQLSTATE = %s", databaseError.Code)
					}
					t.Fatalf("OIDC did not issue under the committed role: %v", result.err)
				}
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			}
			var tokens, links, completedEvents int
			if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities), (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')`).Scan(&tokens, &links, &completedEvents); err != nil {
				t.Fatal(err)
			}
			if tokens != wantTokens || links != wantLinks || completedEvents != wantTokens {
				t.Fatal("overlap duplicated or lost OIDC issuance")
			}
		})
	}
}

func TestBrowserConcurrentRoleChangesDoNotUpgradeSharedOrganizationLocks(t *testing.T) {
	f := browserOIDCFixture(t)
	second, err := directory.NewService(f.store.Directory(), f.newID, f.time, testPasswordEngine(t)).CreateLocalUser(t.Context(), directory.CreateLocalUserInput{
		RequestID: "second-member", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID,
		Email: "second@example.com", DisplayName: "Second", Password: "another correct password", Role: domain.OrganizationRoleMember,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	ready := make(chan uint32, 2)
	release := make(chan struct{})
	done := make(chan error, 2)
	for _, member := range []domain.OrganizationMembership{f.user.Membership, second.Membership} {
		var captured sync.Once
		store := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
			if strings.Contains(sql, "FROM organizations") && strings.Contains(sql, "FOR UPDATE") {
				captured.Do(func() {
					ready <- conn.PgConn().PID()
					select {
					case <-release:
					case <-ctx.Done():
					}
				})
			}
		})
		workers.Go(func() {
			_, err := directory.NewService(store.Directory(), f.newID, f.time, testPasswordEngine(t)).UpdateMembership(ctx, directory.UpdateMembershipInput{
				RequestID: "promote-" + member.ID, ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID,
				MembershipID: member.ID, Email: member.Email, DisplayName: member.DisplayName, Role: domain.OrganizationRoleAdmin, Active: true,
			})
			done <- err
		})
	}
	for range 2 {
		select {
		case <-ready:
		case err := <-done:
			t.Fatalf("role change did not reach organization write admission: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	close(release)
	for range 2 {
		select {
		case err := <-done:
			if err != nil {
				t.Fatalf("independent role change failed: %v", err)
			}
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	var promoted int
	if err := f.pool.QueryRow(ctx, `SELECT count(*) FROM organization_memberships WHERE id = ANY($1::text[]) AND role = 'admin'`, []string{f.user.Membership.ID, second.Membership.ID}).Scan(&promoted); err != nil || promoted != 2 {
		t.Fatalf("both independent role changes did not persist: %v", err)
	}
}

func TestBrowserLocalLoginAndSCIMReplacementShareParentLockOrder(t *testing.T) {
	f := browserOIDCFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET source = 'scim', scim_user_name = email WHERE id = $1`, f.user.Membership.ID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	loginReady := make(chan uint32, 1)
	releaseLogin := make(chan struct{})
	var loginCaptured sync.Once
	loginStore := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM organization_memberships") && strings.Contains(sql, "FOR SHARE") {
			loginCaptured.Do(func() {
				loginReady <- conn.PgConn().PID()
				select {
				case <-releaseLogin:
				case <-ctx.Done():
				}
			})
		}
	})
	auth, err := localauth.NewService(t.Context(), loginStore.LocalAuth(), f.newID, f.time, time.Hour, testPasswordEngine(t))
	if err != nil {
		t.Fatal(err)
	}
	type outcome struct {
		login localauth.LoginResult
		err   error
	}
	loginDone := make(chan outcome, 1)
	workers.Go(func() {
		login, err := auth.Login(ctx, localauth.LoginInput{RequestID: "login-before-scim", OrganizationSlug: "admission", Email: "member@example.com", Password: "correct horse battery staple"})
		loginDone <- outcome{login, err}
	})
	var loginPID uint32
	select {
	case loginPID = <-loginReady:
	case result := <-loginDone:
		t.Fatalf("login did not hold User/Organization before membership: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	replacePID := make(chan uint32, 1)
	var replaceCaptured sync.Once
	replaceStore := f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "users") && strings.Contains(sql, "FOR UPDATE") {
			replaceCaptured.Do(func() { replacePID <- conn.PgConn().PID() })
		}
	})
	current, err := f.store.SCIM().GetUser(ctx, f.admin.Organization.ID, f.user.Membership.ID)
	if err != nil {
		t.Fatal(err)
	}
	replacement := current.Membership
	replacement.Active, replacement.UpdatedAt = false, current.Membership.UpdatedAt.Add(time.Second)
	replaceDone := make(chan error, 1)
	workers.Go(func() {
		_, err := replaceStore.SCIM().ReplaceUser(ctx, scim.ReplaceUserCommand{OrganizationID: f.admin.Organization.ID, User: current.User, Membership: replacement, ExpectedUpdatedAt: current.Membership.UpdatedAt})
		replaceDone <- err
	})
	select {
	case id := <-replacePID:
		waitForDatabaseLock(t, ctx, f.pool, id)
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, loginPID, id).Scan(&blocked); err != nil || !blocked {
			t.Fatalf("SCIM did not wait on the admitted login: %v", err)
		}
	case err := <-replaceDone:
		t.Fatalf("SCIM bypassed the admitted login: %v", err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(releaseLogin)
	var login localauth.LoginResult
	select {
	case result := <-loginDone:
		if result.err != nil || result.login.AccessToken == "" {
			t.Fatalf("login did not commit before SCIM replacement: %v", result.err)
		}
		login = result.login
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case err := <-replaceDone:
		if err != nil {
			t.Fatalf("SCIM replacement did not commit: %v", err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := auth.Resolve(ctx, login.AccessToken); !errors.Is(err, domain.ErrUnauthenticated) {
		t.Fatalf("replaced inactive membership still resolves: %v", err)
	}
	f.assertIssuanceCount(t, 1)
}

func TestBrowserOIDCAndSCIMReprovisionDoNotReverseExternalMappingLocks(t *testing.T) {
	f := browserOIDCFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE organization_memberships SET source = 'scim', scim_user_name = email, scim_external_id = 'reprovisioned-subject' WHERE id = $1`, f.user.Membership.ID); err != nil {
		t.Fatal(err)
	}
	initial, err := f.flow.CompleteLogin(t.Context(), f.start(t))
	if err != nil {
		t.Fatal(err)
	}
	if err := f.store.SCIM().DeleteUser(t.Context(), scim.DeleteUserCommand{OrganizationID: f.admin.Organization.ID, MembershipID: f.user.Membership.ID, DeletedAt: f.time()}); err != nil {
		t.Fatal(err)
	}
	input := f.start(t)
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	var workers sync.WaitGroup
	defer func() { cancel(); workers.Wait() }()
	reprovisionReady := make(chan uint32, 1)
	release := make(chan struct{})
	var reprovisionCaptured sync.Once
	reprovisionStore := f.tracedStore(t, func(ctx context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "UPDATE external_identities") {
			reprovisionCaptured.Do(func() {
				reprovisionReady <- conn.PgConn().PID()
				select {
				case <-release:
				case <-ctx.Done():
				}
			})
		}
	})
	newUserID, newMembershipID := f.newID("user"), f.newID("membership")
	type provisionOutcome struct {
		resource scim.UserResource
		err      error
	}
	provisioned := make(chan provisionOutcome, 1)
	workers.Go(func() {
		resource, err := reprovisionStore.SCIM().CreateUser(ctx, scim.CreateUserCommand{
			OrganizationID: f.admin.Organization.ID,
			User:           domain.User{ID: newUserID, SystemRole: domain.SystemRoleUser, Active: true, CreatedAt: f.time(), UpdatedAt: f.time()},
			Membership: domain.OrganizationMembership{ID: newMembershipID, UserID: newUserID, OrganizationID: f.admin.Organization.ID,
				Email: "member@example.com", DisplayName: "Reprovisioned", Role: domain.OrganizationRoleMember, Source: domain.SourceSCIM,
				Active: true, SCIMUserName: "member@example.com", SCIMExternalID: "reprovisioned-subject", CreatedAt: f.time(), UpdatedAt: f.time()},
		})
		provisioned <- provisionOutcome{resource, err}
	})
	var provisionPID uint32
	select {
	case provisionPID = <-reprovisionReady:
	case result := <-provisioned:
		t.Fatalf("reprovision did not hold parent rows: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	loginPID := make(chan uint32, 1)
	var loginCaptured sync.Once
	f.repository.Repository = f.tracedStore(t, func(_ context.Context, conn *pgx.Conn, sql string) {
		if strings.Contains(sql, "FROM oidc_providers") && strings.Contains(sql, "FOR UPDATE") {
			loginCaptured.Do(func() { loginPID <- conn.PgConn().PID() })
		}
	}).OIDC()
	type loginOutcome struct {
		result oidcflow.CompleteLoginResult
		err    error
	}
	completed := make(chan loginOutcome, 1)
	workers.Go(func() { result, err := f.flow.CompleteLogin(ctx, input); completed <- loginOutcome{result, err} })
	select {
	case id := <-loginPID:
		waitForDatabaseLock(t, ctx, f.pool, id)
		var blocked bool
		if err := f.pool.QueryRow(ctx, `SELECT $1::integer = ANY(pg_blocking_pids($2))`, provisionPID, id).Scan(&blocked); err != nil || !blocked {
			t.Fatalf("OIDC did not wait on reprovision Provider lock: %v", err)
		}
	case result := <-completed:
		t.Fatalf("OIDC did not reach reprovision overlap: %v", result.err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	close(release)
	select {
	case result := <-provisioned:
		if result.err != nil || result.resource.User.ID != initial.Principal.UserID || result.resource.Membership.ID != newMembershipID {
			t.Fatalf("reprovision did not preserve User and replace Membership: %v", result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	select {
	case result := <-completed:
		// Provider serialization happens before the first binding lookup. This
		// login has not selected the old Membership, so it must see the fully
		// committed replacement and issue a new credential for that Membership.
		if result.err != nil || result.result.AccessToken == "" || result.result.Principal.UserID != initial.Principal.UserID || result.result.Principal.MembershipID != newMembershipID {
			var databaseError *pgconn.PgError
			if errors.As(result.err, &databaseError) {
				t.Logf("OIDC persistence SQLSTATE = %s", databaseError.Code)
			}
			t.Fatalf("in-flight login did not use the committed replacement or deadlocked: %v", result.err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if _, err := f.store.LocalAuth().ResolveSession(ctx, initial.TokenID, f.time()); !errors.Is(err, domain.ErrNotFound) {
		t.Fatalf("reprovision revived the old membership credential: %v", err)
	}
	fresh, err := f.flow.CompleteLogin(ctx, f.start(t))
	if err != nil || fresh.Principal.UserID != initial.Principal.UserID || fresh.Principal.MembershipID != newMembershipID || fresh.AccessToken == "" {
		t.Fatalf("fresh login did not use the committed reprovisioned binding: %v", err)
	}
	var tokens, links, completedEvents int
	if err := f.pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM api_tokens), (SELECT count(*) FROM external_identities), (SELECT count(*) FROM identity_events WHERE event_type = 'oidc_login.completed')`).Scan(&tokens, &links, &completedEvents); err != nil {
		t.Fatal(err)
	}
	if tokens != 3 || links != 1 || completedEvents != 3 || f.idp.ExchangeCount() != 3 {
		t.Fatal("reprovision overlap lost or duplicated token/link/exchange effects")
	}
}
