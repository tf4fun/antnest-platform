package scim

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

type versionRepositoryStub struct {
	scimRepositoryStub
	readErr  error
	writeErr error
	writes   int
}

func (r *versionRepositoryStub) GetUser(context.Context, string, string) (UserResource, error) {
	return r.user, r.readErr
}

func (r *versionRepositoryStub) GetGroup(context.Context, string, string) (GroupResource, error) {
	return r.group, r.readErr
}

func (r *versionRepositoryStub) ListUsers(context.Context, ListQuery) (UserPage, error) {
	return UserPage{Items: []UserResource{r.user}, TotalResults: 1}, nil
}

func (r *versionRepositoryStub) ListGroups(context.Context, ListQuery) (GroupPage, error) {
	return GroupPage{Items: []GroupResource{r.group}, TotalResults: 1}, nil
}

func (r *versionRepositoryStub) ReplaceUser(ctx context.Context, command ReplaceUserCommand) (UserResource, error) {
	r.writes++
	if r.writeErr != nil {
		return UserResource{}, r.writeErr
	}
	return r.scimRepositoryStub.ReplaceUser(ctx, command)
}

func (r *versionRepositoryStub) ReplaceGroup(ctx context.Context, command ReplaceGroupCommand) (GroupResource, error) {
	r.writes++
	if r.writeErr != nil {
		return GroupResource{}, r.writeErr
	}
	return r.scimRepositoryStub.ReplaceGroup(ctx, command)
}

func (r *versionRepositoryStub) DeleteUser(ctx context.Context, command DeleteUserCommand) error {
	r.writes++
	if r.writeErr != nil {
		return r.writeErr
	}
	return r.scimRepositoryStub.DeleteUser(ctx, command)
}

func (r *versionRepositoryStub) DeleteGroup(ctx context.Context, command DeleteGroupCommand) error {
	r.writes++
	if r.writeErr != nil {
		return r.writeErr
	}
	return r.scimRepositoryStub.DeleteGroup(ctx, command)
}

func versionHTTPFixture(t *testing.T) (*HTTPHandler, *versionRepositoryStub) {
	t.Helper()
	now := fixedSCIMNow()
	repo := &versionRepositoryStub{scimRepositoryStub: scimRepositoryStub{
		authorization: Authorization{TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{domain.SCIMScopeWrite}},
		user: UserResource{
			User: domain.User{ID: "user-1", Active: true, CreatedAt: now, UpdatedAt: now},
			Membership: domain.OrganizationMembership{
				ID: "membership-1", UserID: "user-1", OrganizationID: "org-1", Source: domain.SourceSCIM,
				Active: true, Email: "alice@example.com", DisplayName: "Alice", SCIMUserName: "alice",
				CreatedAt: now, UpdatedAt: now,
			},
		},
		group: GroupResource{Group: domain.Group{
			ID: "group-1", OrganizationID: "org-1", Source: domain.SourceSCIM, Active: true,
			DisplayName: "Team", CreatedAt: now, UpdatedAt: now,
		}, MemberIDs: []string{"membership-1"}},
	}}
	h, err := NewHTTPHandler(newSCIMTestService(t, repo), "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	return h, repo
}

func versionMutationBody(resource, method string) any {
	if method == http.MethodDelete || method == http.MethodGet {
		return nil
	}
	if method == http.MethodPatch {
		return map[string]any{"schemas": []string{patchSchema}, "Operations": []map[string]any{
			{"op": "replace", "path": "displayName", "value": "Updated"},
		}}
	}
	if resource == "Users" {
		return map[string]any{"schemas": []string{userSchema}, "userName": "alice", "displayName": "Updated",
			"emails": []map[string]any{{"value": "alice@example.com"}}, "active": true}
	}
	return map[string]any{"schemas": []string{groupSchema}, "displayName": "Updated", "members": []map[string]any{{"value": "membership-1"}}}
}

func versionRequest(t *testing.T, h http.Handler, resource, method string, headers []string) *httptest.ResponseRecorder {
	t.Helper()
	var buffer bytes.Buffer
	if body := versionMutationBody(resource, method); body != nil {
		if err := json.NewEncoder(&buffer).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	target := "/scim/v2/" + resource
	if method != http.MethodPost {
		if resource == "Users" {
			target += "/membership-1"
		} else {
			target += "/group-1"
		}
	}
	request := httptest.NewRequest(method, target, &buffer)
	request.Header.Set("Authorization", "Bearer ant_scim_secret")
	for _, header := range headers {
		request.Header.Add("If-Match", header)
	}
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	return response
}

func assertVersionResponse(t *testing.T, body []byte, header string) {
	t.Helper()
	var resource struct {
		Meta struct {
			Version      string    `json:"version"`
			LastModified time.Time `json:"lastModified"`
		} `json:"meta"`
	}
	if err := json.Unmarshal(body, &resource); err != nil {
		t.Fatal(err)
	}
	want := fmt.Sprintf(`W/"%d"`, resource.Meta.LastModified.UnixNano())
	if resource.Meta.LastModified.IsZero() || resource.Meta.Version != want || header != want {
		t.Fatalf("version=%q header=%q want=%q body=%s", resource.Meta.Version, header, want, body)
	}
}

func TestSCIMVersionResponseHeadersAndListEntries(t *testing.T) {
	for _, resource := range []string{"Users", "Groups"} {
		for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodPatch} {
			t.Run(resource+"/"+method, func(t *testing.T) {
				h, _ := versionHTTPFixture(t)
				response := versionRequest(t, h, resource, method, nil)
				want := http.StatusOK
				if method == http.MethodPost {
					want = http.StatusCreated
				}
				if response.Code != want {
					t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
				}
				assertVersionResponse(t, response.Body.Bytes(), response.Header().Get("ETag"))
			})
		}
		t.Run(resource+"/list", func(t *testing.T) {
			h, _ := versionHTTPFixture(t)
			response := requestSCIM(t, h, http.MethodGet, "/scim/v2/"+resource, nil)
			var page struct{ Resources []json.RawMessage }
			if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || len(page.Resources) != 1 {
				t.Fatalf("list err=%v body=%s", err, response.Body.String())
			}
			assertVersionResponse(t, page.Resources[0], fmt.Sprintf(`W/"%d"`, fixedSCIMNow().UnixNano()))
		})
	}
	h, _ := versionHTTPFixture(t)
	response := requestSCIM(t, h, http.MethodGet, "/scim/v2/ServiceProviderConfig", nil)
	var config struct{ ETag struct{ Supported bool } }
	if err := json.Unmarshal(response.Body.Bytes(), &config); err != nil || !config.ETag.Supported {
		t.Fatalf("discovery err=%v body=%s", err, response.Body.String())
	}
}

func TestSCIMIfMatchSyntaxIsRejectedBeforeMutation(t *testing.T) {
	for _, resource := range []string{"Users", "Groups"} {
		for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
			for _, header := range []string{`W/"unterminated`, `* , "tag"`, `w/"tag"`, strings.Repeat("x", 8193)} {
				t.Run(resource+"/"+method+"/"+fmt.Sprint(len(header)), func(t *testing.T) {
					h, repo := versionHTTPFixture(t)
					response := versionRequest(t, h, resource, method, []string{header})
					if response.Code != http.StatusBadRequest || !bytes.Contains(response.Body.Bytes(), []byte(`"scimType":"invalidSyntax"`)) || repo.writes != 0 {
						t.Fatalf("status=%d writes=%d body=%s", response.Code, repo.writes, response.Body.String())
					}
				})
			}
		}
	}
}

func TestSCIMIfMatchKeepsMissingResourceAndRepositoryConflictStatus(t *testing.T) {
	for _, resource := range []string{"Users", "Groups"} {
		for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
			t.Run(resource+"/"+method+"/missing", func(t *testing.T) {
				h, repo := versionHTTPFixture(t)
				repo.readErr = domain.ErrNotFound
				response := versionRequest(t, h, resource, method, []string{`broken`})
				if response.Code != http.StatusNotFound || repo.writes != 0 {
					t.Fatalf("status=%d writes=%d body=%s", response.Code, repo.writes, response.Body.String())
				}
			})
			for _, condition := range []struct {
				name     string
				err      error
				status   int
				scimType string
			}{
				{"precondition", domain.NewError("precondition_failed", "The SCIM resource version does not match", false), http.StatusPreconditionFailed, "mutability"},
				{"internal-cas", domain.ErrVersionConflict, http.StatusConflict, ""},
			} {
				t.Run(resource+"/"+method+"/"+condition.name, func(t *testing.T) {
					h, repo := versionHTTPFixture(t)
					repo.writeErr = condition.err
					response := versionRequest(t, h, resource, method, []string{`*`})
					var body struct {
						SCIMType string `json:"scimType"`
					}
					if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != condition.status || body.SCIMType != condition.scimType {
						t.Fatalf("status=%d err=%v body=%s", response.Code, err, response.Body.String())
					}
				})
			}
		}
	}
}

func TestSCIMPatchProfileDoesNotDeactivateMembershipOfGloballyInactiveUser(t *testing.T) {
	h, repo := versionHTTPFixture(t)
	repo.user.User.Active = false
	response := versionRequest(t, h, "Users", http.MethodPatch, nil)
	if response.Code != http.StatusOK || !repo.replacedUser.Membership.Active {
		t.Fatalf("status=%d membership.active=%v body=%s", response.Code, repo.replacedUser.Membership.Active, response.Body.String())
	}
	var resource struct{ Active bool }
	if err := json.Unmarshal(response.Body.Bytes(), &resource); err != nil || resource.Active {
		t.Fatalf("effective active err=%v body=%s", err, response.Body.String())
	}
}

func TestSCIMReadUsageIsRecordedOnlyAfterSuccessfulRead(t *testing.T) {
	for _, path := range []string{
		"ServiceProviderConfig", "ResourceTypes", "ResourceTypes/User", "Schemas", "Schemas/" + userSchema,
		"Users", "Users/membership-1", "Groups", "Groups/group-1",
	} {
		t.Run(path, func(t *testing.T) {
			h, repo := versionHTTPFixture(t)
			response := requestSCIM(t, h, http.MethodGet, "/scim/v2/"+path, nil)
			if response.Code != http.StatusOK || repo.usageCalls != 1 {
				t.Fatalf("status=%d usage calls=%d", response.Code, repo.usageCalls)
			}
		})
	}
	for _, path := range []string{"ResourceTypes/unknown", "Schemas/unknown", "Users?startIndex=invalid", "Groups?count=invalid"} {
		t.Run(path, func(t *testing.T) {
			h, repo := versionHTTPFixture(t)
			response := requestSCIM(t, h, http.MethodGet, "/scim/v2/"+path, nil)
			if response.Code < 400 || repo.usageCalls != 0 {
				t.Fatalf("status=%d usage calls=%d", response.Code, repo.usageCalls)
			}
		})
	}
	t.Run("failed-resource-read", func(t *testing.T) {
		h, repo := versionHTTPFixture(t)
		repo.readErr = domain.ErrNotFound
		response := versionRequest(t, h, "Users", http.MethodGet, nil)
		if response.Code != http.StatusNotFound || repo.usageCalls != 0 {
			t.Fatalf("status=%d usage calls=%d", response.Code, repo.usageCalls)
		}
	})
	t.Run("usage-failure-before-success-response", func(t *testing.T) {
		h, repo := versionHTTPFixture(t)
		repo.usageError = errors.New("private database details")
		response := versionRequest(t, h, "Users", http.MethodGet, nil)
		if response.Code != http.StatusInternalServerError || repo.usageCalls != 1 || response.Header().Get("ETag") != "" || bytes.Contains(response.Body.Bytes(), []byte("private database details")) {
			t.Fatalf("status=%d usage calls=%d body=%s", response.Code, repo.usageCalls, response.Body.String())
		}
	})
	for _, resource := range []string{"Users", "Groups"} {
		for _, method := range []string{http.MethodPut, http.MethodPatch, http.MethodDelete} {
			t.Run(resource+"/"+method, func(t *testing.T) {
				h, repo := versionHTTPFixture(t)
				response := versionRequest(t, h, resource, method, []string{"*"})
				if response.Code >= 300 || repo.usageCalls != 0 {
					t.Fatalf("write request pre-read recorded usage outside its transaction: status=%d usage calls=%d", response.Code, repo.usageCalls)
				}
			})
		}
	}
}
