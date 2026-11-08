package directory

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

var pageTimestamp = time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)

func pageMember(suffix string) Member {
	return Member{
		User: domain.User{
			ID: "user-" + suffix, SystemRole: domain.SystemRoleUser, Active: true,
			CreatedAt: pageTimestamp, UpdatedAt: pageTimestamp,
		},
		Membership: domain.OrganizationMembership{
			ID: "membership-" + suffix, OrganizationID: "org-1", UserID: "user-" + suffix,
			Email: "member" + suffix + "@example.com", DisplayName: "Member " + suffix,
			Role: domain.OrganizationRoleMember, Source: domain.SourceLocal, Active: true,
			CreatedAt: pageTimestamp, UpdatedAt: pageTimestamp,
		},
	}
}

func pageGroup(suffix string) domain.Group {
	return domain.Group{
		ID: "group-" + suffix, OrganizationID: "org-1", DisplayName: "Group " + suffix,
		Source: domain.SourceLocal, Active: true,
		CreatedAt: pageTimestamp, UpdatedAt: pageTimestamp,
	}
}

func adminActor() domain.Principal {
	return domain.Principal{
		UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-admin",
		Active: true, OrganizationRole: domain.OrganizationRoleAdmin,
	}
}

func decodeTestCursor(t *testing.T, encoded string) map[string]any {
	t.Helper()
	raw, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		t.Fatalf("cursor is not strict base64url: %v", err)
	}
	var cursor map[string]any
	if err := json.Unmarshal(raw, &cursor); err != nil {
		t.Fatalf("cursor is not JSON: %v", err)
	}
	return cursor
}

func TestListMembersPaginatesAcrossPages(t *testing.T) {
	first, second, third := pageMember("a"), pageMember("b"), pageMember("c")
	repository := &directoryRepositoryStub{
		principal:   adminActor(),
		membersPage: []Member{first, second, third},
	}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	page, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2,
	})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(page.Items) != 2 || page.Items[0] != first || page.Items[1] != second {
		t.Fatalf("first page items = %v", page.Items)
	}
	if page.NextCursor == nil {
		t.Fatal("first page must carry a continuation cursor")
	}
	cursor := decodeTestCursor(t, *page.NextCursor)
	if cursor["version"] != float64(1) || cursor["kind"] != "members" ||
		cursor["organization_id"] != "org-1" {
		t.Fatalf("cursor = %v", cursor)
	}
	if cursor["key"] != second.Membership.Email || cursor["id"] != second.Membership.ID {
		t.Fatalf("cursor must resume after the last returned item: %v", cursor)
	}
	if repository.membersQuery.Limit != 2 || repository.membersQuery.AfterEmail != "" {
		t.Fatalf("first query = %+v", repository.membersQuery)
	}
	repository.membersPage = []Member{third}
	next, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1",
		Cursor: *page.NextCursor, Limit: 2,
	})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if repository.membersQuery.AfterEmail != second.Membership.Email ||
		repository.membersQuery.AfterID != second.Membership.ID {
		t.Fatalf("keyset query = %+v", repository.membersQuery)
	}
	if len(next.Items) != 1 || next.Items[0] != third || next.NextCursor != nil {
		t.Fatalf("terminal page = %+v", next)
	}
	if next.Items == nil {
		t.Fatal("terminal items must be a non-null array")
	}
}

func TestListMembersTerminalPageIsEmpty(t *testing.T) {
	repository := &directoryRepositoryStub{principal: adminActor(), membersPage: []Member{}}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	page, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 50,
	})
	if err != nil {
		t.Fatalf("terminal page: %v", err)
	}
	if page.Items == nil || len(page.Items) != 0 || page.NextCursor != nil {
		t.Fatalf("terminal page = %+v", page)
	}
}

func TestListMembersChangedPageSizeKeepsCursor(t *testing.T) {
	first, second := pageMember("a"), pageMember("b")
	repository := &directoryRepositoryStub{
		principal:   adminActor(),
		membersPage: []Member{first, second, pageMember("c")},
	}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	page, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	repository.membersPage = []Member{pageMember("d")}
	next, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1",
		Cursor: *page.NextCursor, Limit: 10,
	})
	if err != nil {
		t.Fatalf("a cursor must not bind the page size: %v", err)
	}
	if repository.membersQuery.Limit != 10 || len(next.Items) != 1 {
		t.Fatalf("page-size change = %+v", repository.membersQuery)
	}
}

func TestListMembersValidatesLimitAndFiltersBeforeListing(t *testing.T) {
	for _, test := range []struct {
		name  string
		limit int
	}{
		{"zero", 0}, {"over maximum", 201}, {"negative", -5},
	} {
		t.Run(test.name, func(t *testing.T) {
			repository := &directoryRepositoryStub{principal: adminActor()}
			service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
			_, err := service.ListMembers(context.Background(), ListMembersInput{
				ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: test.limit,
			})
			if !errors.Is(err, domain.ErrInvalidArgument) {
				t.Fatalf("limit %d error = %v", test.limit, err)
			}
			if repository.membersCalls != 0 {
				t.Fatal("repository must not be called for an invalid limit")
			}
		})
	}
	for _, filter := range []MemberFilter{
		{Role: domain.OrganizationRole("owner")},
		{Source: domain.Source("oidc")},
		{EmailPrefix: strings.Repeat("x", 300)},
		{EmailPrefix: "\xff"},
	} {
		repository := &directoryRepositoryStub{principal: adminActor()}
		service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
		_, err := service.ListMembers(context.Background(), ListMembersInput{
			ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 5, Filter: filter,
		})
		if !errors.Is(err, domain.ErrInvalidArgument) {
			t.Fatalf("filter %+v error = %v", filter, err)
		}
		if repository.membersCalls != 0 {
			t.Fatal("repository must not be called for an invalid filter")
		}
	}
}

func TestListMembersNormalizesAndCarriesFilters(t *testing.T) {
	repository := &directoryRepositoryStub{principal: adminActor(), membersPage: []Member{}}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	inactive := false
	_, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 5,
		Filter: MemberFilter{
			EmailPrefix: "  Alice@Example.COM  ",
			Role:        domain.OrganizationRoleMember,
			Active:      &inactive,
			Source:      domain.SourceSCIM,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	filter := repository.membersQuery.Filter
	if filter.EmailPrefix != "alice@example.com" || filter.Role != domain.OrganizationRoleMember ||
		filter.Active == nil || *filter.Active != false || filter.Source != domain.SourceSCIM {
		t.Fatalf("normalized query filter = %+v", filter)
	}
}

func TestListMembersRejectsInvalidCursorsBeforeListing(t *testing.T) {
	repository := &directoryRepositoryStub{principal: adminActor(), membersPage: []Member{pageMember("a"), pageMember("b"), pageMember("c")}}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	page, err := service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	issued := decodeTestCursor(t, *page.NextCursor)
	encode := func(mutate func(map[string]any)) string {
		clone := map[string]any{}
		for key, value := range issued {
			clone[key] = value
		}
		if mutate != nil {
			mutate(clone)
		}
		raw, _ := json.Marshal(clone)
		return base64.RawURLEncoding.EncodeToString(raw)
	}
	for name, cursor := range map[string]string{
		"not base64":         "!!!",
		"embedded newline":   (*page.NextCursor)[:4] + "\n" + (*page.NextCursor)[4:],
		"not JSON":           base64.RawURLEncoding.EncodeToString([]byte("nope")),
		"trailing data":      base64.RawURLEncoding.EncodeToString([]byte(`{"version":1,"kind":"members","organization_id":"org-1","filter":"f","key":"k","id":"i"}{"x":1}`)),
		"duplicate key":      base64.RawURLEncoding.EncodeToString([]byte(`{"version":1,"kind":"members","kind":"groups","organization_id":"org-1","filter":"f","key":"k","id":"i"}`)),
		"wrong version":      encode(func(c map[string]any) { c["version"] = 2 }),
		"wrong kind":         encode(func(c map[string]any) { c["kind"] = "groups" }),
		"wrong organization": encode(func(c map[string]any) { c["organization_id"] = "org-2" }),
		"wrong filter":       encode(func(c map[string]any) { c["filter"] = strings.Repeat("0", 64) }),
		"missing key":        encode(func(c map[string]any) { delete(c, "key") }),
		"empty key":          encode(func(c map[string]any) { c["key"] = "" }),
		"missing id":         encode(func(c map[string]any) { delete(c, "id") }),
		"empty id":           encode(func(c map[string]any) { c["id"] = "" }),
		"extra key":          encode(func(c map[string]any) { c["extra"] = true }),
	} {
		t.Run(name, func(t *testing.T) {
			repository.membersCalls = 0
			_, err := service.ListMembers(context.Background(), ListMembersInput{
				ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2, Cursor: cursor,
			})
			if !errors.Is(err, domain.ErrInvalidArgument) {
				t.Fatalf("cursor error = %v", err)
			}
			if repository.membersCalls != 0 {
				t.Fatal("repository must not be called for an invalid cursor")
			}
		})
	}
	repository.membersCalls = 0
	_, err = service.ListMembers(context.Background(), ListMembersInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2,
		Cursor: *page.NextCursor, Filter: MemberFilter{Role: domain.OrganizationRoleAdmin},
	})
	if !errors.Is(err, domain.ErrInvalidArgument) {
		t.Fatal("a cursor must be bound to its filter")
	}
	if repository.membersCalls != 0 {
		t.Fatal("repository must not be called for a filter-mismatched cursor")
	}
}

func TestListMembersRequiresDirectoryAuthority(t *testing.T) {
	for name, principal := range map[string]domain.Principal{
		"member": {
			UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
			Active: true, OrganizationRole: domain.OrganizationRoleMember,
		},
		"inactive administrator": {
			UserID: "admin", OrganizationID: "org-1", MembershipID: "membership-admin",
			Active: false, OrganizationRole: domain.OrganizationRoleAdmin,
		},
		"cross organization administrator": {
			UserID: "admin", OrganizationID: "org-2", MembershipID: "membership-admin",
			Active: true, OrganizationRole: domain.OrganizationRoleAdmin,
		},
	} {
		t.Run(name, func(t *testing.T) {
			repository := &directoryRepositoryStub{principal: principal}
			service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
			_, err := service.ListMembers(context.Background(), ListMembersInput{
				ActorPrincipalID: principal.UserID, OrganizationID: "org-1", Limit: 5,
			})
			if !errors.Is(err, domain.ErrForbidden) {
				t.Fatalf("error = %v", err)
			}
			if repository.membersCalls != 0 {
				t.Fatal("repository must not be called without authority")
			}
		})
	}
}

func TestListGroupsPaginatesAndFilters(t *testing.T) {
	first, second, third := pageGroup("a"), pageGroup("b"), pageGroup("c")
	repository := &directoryRepositoryStub{
		principal:  adminActor(),
		groupsPage: []domain.Group{first, second, third},
	}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	inactive := true
	page, err := service.ListGroups(context.Background(), ListGroupsInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2,
		Filter: GroupFilter{DisplayNamePrefix: " group", Active: &inactive, Source: domain.SourceLocal},
	})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	if len(page.Items) != 2 || page.NextCursor == nil {
		t.Fatalf("first page = %+v", page)
	}
	cursor := decodeTestCursor(t, *page.NextCursor)
	if cursor["kind"] != "groups" || cursor["key"] != second.DisplayName ||
		cursor["id"] != second.ID {
		t.Fatalf("group cursor = %v", cursor)
	}
	filter := repository.groupsQuery.Filter
	if filter.DisplayNamePrefix != "group" || filter.Active == nil || *filter.Active != true ||
		filter.Source != domain.SourceLocal {
		t.Fatalf("normalized group filter = %+v", filter)
	}
	repository.groupsPage = []domain.Group{third}
	next, err := service.ListGroups(context.Background(), ListGroupsInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1",
		Cursor: *page.NextCursor, Limit: 2,
		Filter: GroupFilter{DisplayNamePrefix: " group", Active: &inactive, Source: domain.SourceLocal},
	})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if repository.groupsQuery.AfterName != second.DisplayName ||
		repository.groupsQuery.AfterID != second.ID {
		t.Fatalf("group keyset = %+v", repository.groupsQuery)
	}
	if len(next.Items) != 1 || next.Items == nil || next.NextCursor != nil {
		t.Fatalf("terminal group page = %+v", next)
	}
}

func TestListGroupsRejectsInvalidInputsBeforeListing(t *testing.T) {
	repository := &directoryRepositoryStub{principal: adminActor(), groupsPage: []domain.Group{pageGroup("a"), pageGroup("b"), pageGroup("c")}}
	service := NewService(repository, sequentialIDs(), fixedNow, testPasswordEngine(t))
	page, err := service.ListGroups(context.Background(), ListGroupsInput{
		ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, input := range []ListGroupsInput{
		{ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 0},
		{ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 201},
		{ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 5, Filter: GroupFilter{Source: domain.Source("oidc")}},
		{ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 5, Filter: GroupFilter{DisplayNamePrefix: strings.Repeat("x", 300)}},
		{ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2, Cursor: "not-a-cursor"},
		{ActorPrincipalID: "admin", OrganizationID: "org-1", Limit: 2, Cursor: *page.NextCursor, Filter: GroupFilter{Source: domain.SourceSCIM}},
	} {
		repository.groupsCalls = 0
		_, err := service.ListGroups(context.Background(), input)
		if !errors.Is(err, domain.ErrInvalidArgument) {
			t.Fatalf("input %+v error = %v", input, err)
		}
		if repository.groupsCalls != 0 {
			t.Fatal("repository must not be called for an invalid input")
		}
	}
	repository.groupsCalls = 0
	repository.principal = domain.Principal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1",
		Active: true, OrganizationRole: domain.OrganizationRoleMember,
	}
	_, err = service.ListGroups(context.Background(), ListGroupsInput{
		ActorPrincipalID: "user-1", OrganizationID: "org-1", Limit: 5,
	})
	if !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("member error = %v", err)
	}
	if repository.groupsCalls != 0 {
		t.Fatal("repository must not be called without authority")
	}
}
