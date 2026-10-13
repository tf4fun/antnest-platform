package e2e

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

type scimVersionFixture struct {
	bindingFixture
	service    *scim.Service
	auth       scim.Authorization
	credential string
	user       scim.UserResource
	group      scim.GroupResource
}

func newSCIMVersionFixture(t *testing.T) scimVersionFixture {
	t.Helper()
	f := newBindingFixture(t)
	s := pairingService(t, f)
	issued, err := s.IssueToken(f.adminCtx, scim.IssueTokenInput{
		RequestID: "versions-token", ActorPrincipalID: f.admin.User.ID, OrganizationID: f.admin.Organization.ID,
		OIDCProviderID: &f.providerID, Name: "Versioned directory", Scopes: []string{domain.SCIMScopeWrite},
	})
	if err != nil {
		t.Fatal(err)
	}
	auth, err := s.Authorize(t.Context(), issued.Credential, domain.SCIMScopeWrite)
	if err != nil {
		t.Fatal(err)
	}
	user, err := s.CreateUser(t.Context(), auth, pairedUserInput())
	if err != nil {
		t.Fatal(err)
	}
	group, err := s.CreateGroup(t.Context(), auth, scim.GroupInput{DisplayName: "Versioned team", MemberIDs: []string{user.Membership.ID}})
	if err != nil {
		t.Fatal(err)
	}
	return scimVersionFixture{bindingFixture: f, service: s, auth: auth, credential: issued.Credential, user: user, group: group}
}

func scimVersionCondition(t *testing.T, tag string) *scim.IfMatchCondition {
	t.Helper()
	condition, err := scim.ParseIfMatch([]string{tag})
	if err != nil {
		t.Fatal(err)
	}
	return condition
}

func (f scimVersionFixture) versionSnapshot(t *testing.T) string {
	t.Helper()
	// Unlike the older pairing snapshot, a refused conditional request must not
	// persist a token usage timestamp either.
	query := strings.Replace(scimPairingSnapshotSQL, "to_jsonb(t)-'last_used_at'", "to_jsonb(t) || jsonb_build_object('xmin',t.xmin::text)", 1)
	var result string
	if err := f.pool.QueryRow(t.Context(), query).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestSCIMVersionPreconditionsRefuseWithoutResourceAuditOrFeedWrites(t *testing.T) {
	for _, kind := range []string{"user", "group"} {
		for _, operation := range []string{"replace", "delete"} {
			for _, tag := range []string{`W/"0"`, ``, `"opaque,unknown"`} {
				t.Run(kind+"/"+operation+"/"+tag, func(t *testing.T) {
					f := newSCIMVersionFixture(t)
					condition := scimVersionCondition(t, tag)
					before := f.versionSnapshot(t)
					var err error
					switch {
					case kind == "user" && operation == "replace":
						command := scim.ReplaceUserCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
							User: f.user.User, Membership: f.user.Membership, ExpectedUpdatedAt: f.user.Membership.UpdatedAt, IfMatch: condition}
						command.Membership.Active = false
						command.Membership.UpdatedAt = command.Membership.UpdatedAt.Add(time.Second)
						_, err = f.store.SCIM().ReplaceUser(t.Context(), command)
					case kind == "user":
						err = f.service.DeleteUser(t.Context(), f.auth, f.user.Membership.ID, condition)
					case operation == "replace":
						command := scim.ReplaceGroupCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
							Group: f.group.Group, MemberIDs: nil, ExpectedUpdatedAt: f.group.Group.UpdatedAt, IfMatch: condition}
						command.Group.DisplayName = "Must not persist"
						command.Group.UpdatedAt = command.Group.UpdatedAt.Add(time.Second)
						_, err = f.store.SCIM().ReplaceGroup(t.Context(), command)
					default:
						err = f.service.DeleteGroup(t.Context(), f.auth, f.group.Group.ID, condition)
					}
					if !errors.Is(err, domain.ErrPreconditionFailed) || f.versionSnapshot(t) != before {
						t.Fatalf("conditional refusal err=%v or durable state changed", err)
					}
				})
			}
		}
	}
}

func TestSCIMVersionMatchingConditionKeepsIndependentCAS(t *testing.T) {
	for _, kind := range []string{"user", "group"} {
		for _, mode := range []string{"absent", "wildcard", "matched-list", "stale-and-old-baseline"} {
			t.Run(kind+"/"+mode, func(t *testing.T) {
				f := newSCIMVersionFixture(t)
				updatedAt := f.user.Membership.UpdatedAt
				if kind == "group" {
					updatedAt = f.group.Group.UpdatedAt
				}
				var condition *scim.IfMatchCondition
				want := domain.ErrVersionConflict
				switch mode {
				case "wildcard":
					condition = scimVersionCondition(t, "*")
				case "matched-list":
					condition = scimVersionCondition(t, `"other", `+scim.ResourceVersion(updatedAt))
				case "stale-and-old-baseline":
					condition = scimVersionCondition(t, scim.ResourceVersion(updatedAt.Add(-time.Second)))
					want = domain.ErrPreconditionFailed
				}
				before := f.versionSnapshot(t)
				var err error
				if kind == "user" {
					command := scim.ReplaceUserCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
						User: f.user.User, Membership: f.user.Membership, ExpectedUpdatedAt: updatedAt.Add(-time.Second), IfMatch: condition}
					command.Membership.DisplayName = "Obsolete computed update"
					_, err = f.store.SCIM().ReplaceUser(t.Context(), command)
				} else {
					command := scim.ReplaceGroupCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
						Group: f.group.Group, MemberIDs: nil, ExpectedUpdatedAt: updatedAt.Add(-time.Second), IfMatch: condition}
					command.Group.DisplayName = "Obsolete computed update"
					_, err = f.store.SCIM().ReplaceGroup(t.Context(), command)
				}
				if !errors.Is(err, want) || f.versionSnapshot(t) != before {
					t.Fatalf("conflict err=%v want=%v or durable state changed", err, want)
				}
			})
		}
	}
}

func TestSCIMVersionStaleHTTPPatchDoesNotPersistTokenUsage(t *testing.T) {
	f := newSCIMVersionFixture(t)
	if _, err := f.pool.Exec(t.Context(), `UPDATE scim_tokens SET last_used_at=NULL WHERE id=$1`, f.auth.TokenID); err != nil {
		t.Fatal(err)
	}
	f.advance(time.Second)
	handler, err := scim.NewHTTPHandler(f.service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPatch, "/scim/v2/Users/"+f.user.Membership.ID, strings.NewReader(
		`{"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"replace","path":"active","value":false}]}`))
	request.Header.Set("Authorization", "Bearer "+f.credential)
	request.Header.Set("If-Match", `W/"0"`)
	before := f.versionSnapshot(t)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusPreconditionFailed || !bytes.Contains(response.Body.Bytes(), []byte(`"scimType":"mutability"`)) || f.versionSnapshot(t) != before {
		t.Fatalf("status=%d body=%s or durable state changed", response.Code, response.Body.String())
	}
}

func TestSCIMVersionResponsesUsePersistedPrecisionAndMonotonicClock(t *testing.T) {
	f := newSCIMVersionFixture(t)
	f.advance(123 * time.Nanosecond)
	created, err := f.service.CreateGroup(t.Context(), f.auth, scim.GroupInput{DisplayName: "Precision", MemberIDs: []string{f.user.Membership.ID}})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := f.service.GetGroup(t.Context(), f.auth, created.Group.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !created.Group.UpdatedAt.Equal(stored.Group.UpdatedAt) || scim.ResourceVersion(created.Group.UpdatedAt) != scim.ResourceVersion(stored.Group.UpdatedAt) {
		t.Errorf("created group response=%s stored=%s", created.Group.UpdatedAt, stored.Group.UpdatedAt)
	}
	for _, kind := range []string{"user", "group"} {
		for _, offset := range []time.Duration{123 * time.Nanosecond, 0, -time.Hour} {
			t.Run(kind+"/"+offset.String(), func(t *testing.T) {
				var before, returned, persisted time.Time
				if kind == "user" {
					current, err := f.service.GetUser(t.Context(), f.auth, f.user.Membership.ID)
					if err != nil {
						t.Fatal(err)
					}
					before = current.Membership.UpdatedAt
					command := scim.ReplaceUserCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
						User: current.User, Membership: current.Membership, ExpectedUpdatedAt: before,
						IfMatch: scimVersionCondition(t, scim.ResourceVersion(before))}
					command.Membership.DisplayName += " updated"
					command.Membership.UpdatedAt = before.Add(offset)
					result, err := f.store.SCIM().ReplaceUser(t.Context(), command)
					if err != nil {
						t.Fatal(err)
					}
					stored, err := f.service.GetUser(t.Context(), f.auth, current.Membership.ID)
					if err != nil {
						t.Fatal(err)
					}
					returned, persisted = result.Membership.UpdatedAt, stored.Membership.UpdatedAt
				} else {
					current, err := f.service.GetGroup(t.Context(), f.auth, f.group.Group.ID)
					if err != nil {
						t.Fatal(err)
					}
					before = current.Group.UpdatedAt
					command := scim.ReplaceGroupCommand{OrganizationID: f.auth.OrganizationID, ActorTokenID: f.auth.TokenID, ActorOIDCProviderID: f.auth.OIDCProviderID,
						Group: current.Group, MemberIDs: current.MemberIDs, ExpectedUpdatedAt: before,
						IfMatch: scimVersionCondition(t, scim.ResourceVersion(before))}
					command.Group.DisplayName += " updated"
					command.Group.UpdatedAt = before.Add(offset)
					result, err := f.store.SCIM().ReplaceGroup(t.Context(), command)
					if err != nil {
						t.Fatal(err)
					}
					stored, err := f.service.GetGroup(t.Context(), f.auth, current.Group.ID)
					if err != nil {
						t.Fatal(err)
					}
					returned, persisted = result.Group.UpdatedAt, stored.Group.UpdatedAt
				}
				if !returned.Equal(persisted) || !persisted.After(before) || persisted.Nanosecond()%1000 != 0 {
					t.Fatalf("before=%s returned=%s persisted=%s", before, returned, persisted)
				}
			})
		}
	}
}

func TestSCIMVersionGlobalActivationAdvancesAllLiveSCIMMemberships(t *testing.T) {
	f := newSCIMVersionFixture(t)
	other := f.browser.otherOrganization(t)
	otherID := f.newID("membership")
	if _, err := f.pool.Exec(t.Context(), `INSERT INTO organization_memberships
		(id, organization_id, user_id, email, display_name, role, source, active, scim_user_name, created_at, updated_at)
		VALUES ($1,$2,$3,'other@example.com','Other','member','scim',TRUE,'other',$4,$4)`,
		otherID, other.ID, f.user.User.ID, f.user.Membership.UpdatedAt); err != nil {
		t.Fatal(err)
	}
	before := f.user.Membership.UpdatedAt
	for _, active := range []bool{false, true} {
		if err := f.store.Directory().SetUserActive(f.adminCtx, directory.SetUserActiveCommand{
			RequestID: "global-active-version", ActorPrincipalID: f.admin.User.ID, UserID: f.user.User.ID, Active: active, UpdatedAt: f.clock(),
		}); err != nil {
			t.Fatal(err)
		}
		for _, member := range []struct{ org, id string }{{f.auth.OrganizationID, f.user.Membership.ID}, {other.ID, otherID}} {
			resource, err := f.store.SCIM().GetUser(t.Context(), member.org, member.id)
			if err != nil {
				t.Fatal(err)
			}
			if resource.User.Active != active || !resource.Membership.Active || !resource.Membership.UpdatedAt.After(before) {
				t.Errorf("global active=%v resource=%+v prior=%s", active, resource, before)
			}
		}
		current, err := f.store.SCIM().GetUser(t.Context(), f.auth.OrganizationID, f.user.Membership.ID)
		if err != nil {
			t.Fatal(err)
		}
		before = current.Membership.UpdatedAt
	}
	// Assert the stored version is the one exposed over the actual SCIM handler.
	h, err := scim.NewHTTPHandler(f.service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/scim/v2/Users/"+f.user.Membership.ID, nil)
	req.Header.Set("Authorization", "Bearer "+f.credential)
	res := httptest.NewRecorder()
	h.ServeHTTP(res, req)
	var body struct{ Meta struct{ Version string } }
	if err := json.Unmarshal(res.Body.Bytes(), &body); err != nil || body.Meta.Version != scim.ResourceVersion(before) || res.Header().Get("ETag") != body.Meta.Version {
		t.Fatalf("version response err=%v status=%d body=%s", err, res.Code, res.Body.String())
	}
}
