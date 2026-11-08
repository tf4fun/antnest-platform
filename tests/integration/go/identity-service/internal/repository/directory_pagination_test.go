package repository

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

const pageTestRows = 10000

func mustDirectoryStore(t *testing.T, pool *pgxpool.Pool) *Store {
	t.Helper()
	store, err := New(pool, func(kind string) string { return "id-0" }, time.Now)
	if err != nil {
		t.Fatalf("create store: %v", err)
	}
	return store
}

func seedDirectoryPages(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	ctx := t.Context()
	if _, err := pool.Exec(ctx, `
		INSERT INTO organizations (id, slug, name, active, created_at, updated_at)
		VALUES ('org-1', 'page-org', 'Page Org', true, now(), now()),
		       ('org-2', 'other-org', 'Other Org', true, now(), now())`); err != nil {
		t.Fatalf("insert organizations: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, system_role, active, created_at, updated_at)
		SELECT 'user-' || g, 'user', (g % 7 <> 0), now(), now()
		FROM generate_series(1, $1) g`, pageTestRows); err != nil {
		t.Fatalf("insert users: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_memberships
			(id, organization_id, user_id, email, display_name, role, source, active,
			 scim_external_id, scim_user_name, created_at, updated_at)
		SELECT 'membership-' || g, 'org-1', 'user-' || g,
		       'member' || lpad(g::text, 5, '0') || '@example.com', 'Member ' || g,
		       CASE WHEN g % 11 = 0 THEN 'admin' ELSE 'member' END,
		       CASE WHEN g % 13 = 0 THEN 'scim' ELSE 'local' END,
		       g % 5 <> 0,
		       CASE WHEN g % 13 = 0 THEN 'ext-' || g ELSE NULL END,
		       CASE WHEN g % 13 = 0 THEN 'member' || lpad(g::text, 5, '0') ELSE NULL END,
		       now(), now()
		FROM generate_series(1, $1) g`, pageTestRows); err != nil {
		t.Fatalf("insert memberships: %v", err)
	}
	for i := 1; i <= 4; i++ {
		if _, err := pool.Exec(ctx, `
			INSERT INTO users (id, system_role, active, created_at, updated_at)
			VALUES ($1, 'user', true, now(), now())`, fmt.Sprintf("other-user-%d", i)); err != nil {
			t.Fatalf("insert foreign user: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO organization_memberships
				(id, organization_id, user_id, email, display_name, role, source, active, created_at, updated_at)
			VALUES ($1, 'org-2', $2, $3, 'Other', 'member', 'local', true, now(), now())`,
			fmt.Sprintf("other-membership-%d", i), fmt.Sprintf("other-user-%d", i),
			fmt.Sprintf("member%05d@example.com", i)); err != nil {
			t.Fatalf("insert foreign membership: %v", err)
		}
	}
	for i, id := range []string{"tombstone-1", "tombstone-2"} {
		if _, err := pool.Exec(ctx, `
			INSERT INTO users (id, system_role, active, created_at, updated_at)
			VALUES ($1, 'user', true, now(), now())`, "tomb-user-"+id); err != nil {
			t.Fatalf("insert tombstone user: %v", err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO organization_memberships
				(id, organization_id, user_id, email, display_name, role, source, active,
				 scim_external_id, scim_user_name, created_at, updated_at, scim_deleted_at)
			VALUES ($1, 'org-1', $2, $3, 'Tomb', 'member', 'scim', false,
			        $4, $5, now(), now(), now())`,
			id, "tomb-user-"+id, fmt.Sprintf("member%05d@example.com", i+5),
			"ext-"+id, "member"+fmt.Sprintf("%05d", i+5)); err != nil {
			t.Fatalf("insert tombstone membership: %v", err)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, system_role, active, created_at, updated_at)
		VALUES ('page-admin-user', 'user', true, now(), now())`); err != nil {
		t.Fatalf("insert admin user: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_memberships
			(id, organization_id, user_id, email, display_name, role, source, active, created_at, updated_at)
		VALUES ('page-admin', 'org-1', 'page-admin-user', 'admin@example.com', 'Admin', 'admin', 'local', true, now(), now())`); err != nil {
		t.Fatalf("insert admin membership: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO groups (id, organization_id, display_name, source, active, created_at, updated_at)
		SELECT 'group-' || g, 'org-1',
		       CASE WHEN g <= 3 THEN 'Operators' ELSE 'Team ' || lpad(g::text, 3, '0') END,
		       CASE WHEN g % 4 = 0 THEN 'scim' ELSE 'local' END,
		       g % 6 <> 0, now(), now()
		FROM generate_series(1, 260) g`); err != nil {
		t.Fatalf("insert groups: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO groups (id, organization_id, display_name, source, active, created_at, updated_at)
		VALUES ('foreign-group', 'org-2', 'Operators', 'local', true, now(), now())`); err != nil {
		t.Fatalf("insert foreign group: %v", err)
	}
}

func TestDirectoryMemberPagesCoverTenThousandUnderInserts(t *testing.T) {
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	seedDirectoryPages(t, pool)
	adapter := mustDirectoryStore(t, pool).Directory()
	ctx := t.Context()

	start := make(chan struct{})
	writerResult := make(chan error, 1)
	done := make(chan struct{})
	writerCtx, cancel := context.WithCancel(t.Context())
	go func() {
		defer close(done)
		select {
		case <-start:
		case <-writerCtx.Done():
			return
		}
		for i := 0; i < 20; i++ {
			userID := fmt.Sprintf("late-user-%d", i)
			email := fmt.Sprintf("zzz%05d@example.com", i)
			if i < 10 {
				email = fmt.Sprintf("aaa%05d@example.com", i)
			}
			if _, err := pool.Exec(writerCtx, `
				INSERT INTO users (id, system_role, active, created_at, updated_at)
				VALUES ($1, 'user', true, now(), now())`, userID); err != nil {
				writerResult <- err
				return
			}
			if _, err := pool.Exec(writerCtx, `
				INSERT INTO organization_memberships
					(id, organization_id, user_id, email, display_name, role, source, active, created_at, updated_at)
				VALUES ($1, 'org-1', $2, $3, 'Late', 'member', 'local', true, now(), now())`,
				fmt.Sprintf("late-membership-%d", i), userID, email); err != nil {
				writerResult <- err
				return
			}
		}
		writerResult <- nil
	}()
	t.Cleanup(func() {
		cancel()
		<-done
	})

	originals := make(map[string]bool, pageTestRows)
	for g := 1; g <= pageTestRows; g++ {
		originals[fmt.Sprintf("membership-%d", g)] = false
	}
	seenAll := make(map[string]bool, pageTestRows)
	var cursor, lastID string
	var pages int
	first := true
	for {
		rows, err := adapter.ListMembers(ctx, directory.MembersQuery{
			OrganizationID: "org-1", Limit: 137, AfterEmail: cursor, AfterID: lastID,
		})
		if err != nil {
			t.Fatalf("page %d: %v", pages, err)
		}
		if len(rows) == 0 {
			break
		}
		if len(rows) > 138 {
			t.Fatalf("page %d rows=%d violates lookahead bound", pages, len(rows))
		}
		more := len(rows) > 137
		if more {
			last := rows[136]
			cursor, lastID = last.Membership.Email, last.Membership.ID
			rows = rows[:137]
		}
		for _, member := range rows {
			if member.Membership.OrganizationID != "org-1" {
				t.Fatalf("cross-organization member %s returned", member.Membership.ID)
			}
			id := member.Membership.ID
			if seenAll[id] {
				t.Fatalf("membership %s returned twice", id)
			}
			seenAll[id] = true
			if _, ok := originals[id]; ok {
				originals[id] = true
			} else if !strings.HasPrefix(id, "late-membership-") && id != "page-admin" {
				t.Fatalf("unexpected member %s returned", id)
			}
		}
		pages++
		if first {
			close(start)
			first = false
		}
		if !more {
			break
		}
		if pages > 200 {
			t.Fatal("pagination did not terminate")
		}
	}
	if err := <-writerResult; err != nil {
		t.Fatalf("bounded writer: %v", err)
	}
	for id, seen := range originals {
		if !seen {
			t.Fatalf("original member %s never returned", id)
		}
	}
}

func TestDirectoryMemberFiltersApply(t *testing.T) {
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	seedDirectoryPages(t, pool)
	adapter := mustDirectoryStore(t, pool).Directory()
	ctx := t.Context()

	rows, err := adapter.ListMembers(ctx, directory.MembersQuery{
		OrganizationID: "org-1", Limit: 10,
		Filter: directory.MemberFilter{EmailPrefix: "member000"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 11 {
		t.Fatalf("prefix page rows=%d want 11 (10 + lookahead)", len(rows))
	}
	for _, member := range rows {
		if !strings.HasPrefix(member.Membership.Email, "member000") {
			t.Fatalf("prefix leaked %s", member.Membership.Email)
		}
	}
	inactive := false
	rows, err = adapter.ListMembers(ctx, directory.MembersQuery{
		OrganizationID: "org-1", Limit: 200,
		Filter: directory.MemberFilter{Active: &inactive},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("inactive filter must match seeded inactive members")
	}
	for _, member := range rows {
		if member.User.Active && member.Membership.Active {
			t.Fatalf("effective-active filter leaked %s", member.Membership.ID)
		}
	}
	rows, err = adapter.ListMembers(ctx, directory.MembersQuery{
		OrganizationID: "org-1", Limit: 200,
		Filter: directory.MemberFilter{Source: domain.SourceSCIM},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("scim filter must match seeded scim members")
	}
	for _, member := range rows {
		if member.Membership.Source != domain.SourceSCIM {
			t.Fatalf("source filter leaked %s", member.Membership.Source)
		}
	}
	rows, err = adapter.ListMembers(ctx, directory.MembersQuery{
		OrganizationID: "org-1", Limit: 200,
		Filter: directory.MemberFilter{Role: domain.OrganizationRoleAdmin},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("admin filter must match seeded admins")
	}
	for _, member := range rows {
		if member.Membership.Role != domain.OrganizationRoleAdmin {
			t.Fatalf("role filter leaked %s", member.Membership.Role)
		}
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (id, system_role, active, created_at, updated_at)
		VALUES ('literal-user', 'user', true, now(), now())`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO organization_memberships
			(id, organization_id, user_id, email, display_name, role, source, active, created_at, updated_at)
		VALUES ('literal-membership', 'org-1', 'literal-user', 'a%_b@example.com', 'Literal', 'member', 'local', true, now(), now())`); err != nil {
		t.Fatal(err)
	}
	rows, err = adapter.ListMembers(ctx, directory.MembersQuery{
		OrganizationID: "org-1", Limit: 200,
		Filter: directory.MemberFilter{EmailPrefix: "a%_b"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 1 || rows[0].Membership.ID != "literal-membership" {
		t.Fatalf("literal %%/_ prefix must not act as wildcard: %d rows", len(rows))
	}
}

func TestDirectoryGroupPagesAndFiltersApply(t *testing.T) {
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	seedDirectoryPages(t, pool)
	adapter := mustDirectoryStore(t, pool).Directory()
	ctx := t.Context()

	seen := make(map[string]bool)
	var cursor, lastID string
	for pages := 0; ; pages++ {
		rows, err := adapter.ListGroups(ctx, directory.GroupsQuery{
			OrganizationID: "org-1", Limit: 25, AfterName: cursor, AfterID: lastID,
		})
		if err != nil {
			t.Fatal(err)
		}
		if len(rows) == 0 {
			break
		}
		if len(rows) > 26 {
			t.Fatalf("group page rows=%d violates lookahead bound", len(rows))
		}
		more := len(rows) > 25
		if more {
			last := rows[24]
			cursor, lastID = last.DisplayName, last.ID
			rows = rows[:25]
		}
		for _, group := range rows {
			if group.OrganizationID != "org-1" {
				t.Fatalf("cross-organization group %s returned", group.ID)
			}
			if seen[group.ID] {
				t.Fatalf("group %s repeated", group.ID)
			}
			seen[group.ID] = true
		}
		if !more {
			break
		}
		if pages > 30 {
			t.Fatal("group pagination did not terminate")
		}
	}
	if len(seen) != 260 {
		t.Fatalf("group coverage = %d want 260", len(seen))
	}
	if seen["foreign-group"] {
		t.Fatal("foreign group returned")
	}

	tied, err := adapter.ListGroups(ctx, directory.GroupsQuery{
		OrganizationID: "org-1", Limit: 10,
		Filter: directory.GroupFilter{DisplayNamePrefix: "operators"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(tied) != 3 {
		t.Fatalf("tied display names rows=%d want 3", len(tied))
	}
	inactive := false
	rows, err := adapter.ListGroups(ctx, directory.GroupsQuery{
		OrganizationID: "org-1", Limit: 200, Filter: directory.GroupFilter{Active: &inactive},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("inactive filter must match seeded inactive groups")
	}
	for _, group := range rows {
		if group.Active {
			t.Fatalf("active filter leaked %s", group.ID)
		}
	}
	rows, err = adapter.ListGroups(ctx, directory.GroupsQuery{
		OrganizationID: "org-1", Limit: 200, Filter: directory.GroupFilter{Source: domain.SourceSCIM},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) == 0 {
		t.Fatal("scim filter must match seeded scim groups")
	}
	for _, group := range rows {
		if group.Source != domain.SourceSCIM {
			t.Fatalf("source filter leaked %s", group.Source)
		}
	}
}

func TestDirectoryServiceIssuesUsableCursors(t *testing.T) {
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	seedDirectoryPages(t, pool)
	adapter := mustDirectoryStore(t, pool).Directory()
	service := directory.NewService(adapter, func(string) string { return "id-0" }, time.Now, testPasswordEngine(t))
	ctx := t.Context()

	page, err := service.ListMembers(ctx, directory.ListMembersInput{
		ActorPrincipalID: "page-admin-user", OrganizationID: "org-1", Limit: 137,
	})
	if err != nil {
		t.Fatalf("first service page: %v", err)
	}
	if len(page.Items) != 137 || page.NextCursor == nil {
		t.Fatalf("first page items=%d cursor=%v", len(page.Items), page.NextCursor != nil)
	}
	next, err := service.ListMembers(ctx, directory.ListMembersInput{
		ActorPrincipalID: "page-admin-user", OrganizationID: "org-1",
		Cursor: *page.NextCursor, Limit: 137,
	})
	if err != nil {
		t.Fatalf("cursor rejected by service: %v", err)
	}
	if len(next.Items) == 0 || next.Items[0].Membership.Email <= page.Items[len(page.Items)-1].Membership.Email {
		t.Fatal("second page did not resume after the cursor")
	}
	if _, err := service.ListMembers(ctx, directory.ListMembersInput{
		ActorPrincipalID: "page-admin-user", OrganizationID: "org-1",
		Cursor: *page.NextCursor, Limit: 137, Filter: directory.MemberFilter{Role: domain.OrganizationRoleAdmin},
	}); err == nil {
		t.Fatal("cursor accepted under a changed filter")
	}
	if _, err := service.ListMembers(ctx, directory.ListMembersInput{
		ActorPrincipalID: "page-admin-user", OrganizationID: "org-2",
		Cursor: *page.NextCursor, Limit: 137,
	}); err == nil {
		t.Fatal("cursor accepted under a different organization")
	}
}

func TestLegacyDirectoryStaysCappedAtTwoHundred(t *testing.T) {
	pool := browserMigrationPool(t)
	if err := ApplyMigrations(t.Context(), pool); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}
	seedDirectoryPages(t, pool)
	adapter := mustDirectoryStore(t, pool).Directory()
	result, err := adapter.ListDirectory(t.Context(), "org-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Users) != 200 {
		t.Fatalf("legacy users = %d want 200", len(result.Users))
	}
	if len(result.Groups) != 200 {
		t.Fatalf("legacy groups = %d want 200", len(result.Groups))
	}
}
