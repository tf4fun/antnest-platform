package scim

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/identity-service/internal/domain"
)

func TestSCIMDiscoveryAndUserProtocolShape(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read", "scim:write"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	discovery := requestSCIM(t, handler, http.MethodGet, "/scim/v2/ServiceProviderConfig", nil)
	if discovery.Code != http.StatusOK || !bytes.Contains(discovery.Body.Bytes(), []byte("ServiceProviderConfig")) {
		t.Fatalf("discovery status=%d body=%s", discovery.Code, discovery.Body.String())
	}
	if !bytes.Contains(discovery.Body.Bytes(), []byte(`"authenticationSchemes"`)) ||
		!bytes.Contains(discovery.Body.Bytes(), []byte(`"type":"oauthbearertoken"`)) {
		t.Fatalf("discovery does not advertise Bearer authentication: %s", discovery.Body.String())
	}

	created := requestSCIM(t, handler, http.MethodPost, "/scim/v2/Users", map[string]any{
		"schemas": []string{userSchema}, "externalId": "workday-42",
		"userName": "alice.employee", "displayName": "Alice", "active": true,
		"emails": []map[string]any{{"value": "alice@example.com", "type": "work", "primary": true}},
	})
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var resource map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &resource); err != nil {
		t.Fatal(err)
	}
	if resource["id"] != "id-2" || resource["userName"] != "alice.employee" {
		t.Fatalf("resource = %#v", resource)
	}
	meta, _ := resource["meta"].(map[string]any)
	if meta["location"] != "https://identity.example.com/scim/v2/Users/id-2" {
		t.Fatalf("meta = %#v", meta)
	}
}

func TestSCIMItemDiscoveryAndPrimaryEmailProfile(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	for _, target := range []string{
		"/scim/v2/ResourceTypes/User",
		"/scim/v2/Schemas/" + userSchema,
	} {
		response := requestSCIM(t, handler, http.MethodGet, target, nil)
		if response.Code != http.StatusOK {
			t.Fatalf("%s status=%d body=%s", target, response.Code, response.Body.String())
		}
	}
}

func TestSCIMRejectsMultiplePrimaryEmails(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	response := requestSCIM(t, handler, http.MethodPost, "/scim/v2/Users", map[string]any{
		"schemas": []string{userSchema}, "userName": "alice.employee",
		"emails": []map[string]any{
			{"value": "alice@example.com", "primary": true},
			{"value": "other@example.com", "primary": true},
		},
	})
	if response.Code != http.StatusBadRequest || repository.createdUser.User.ID != "" {
		t.Fatalf("status=%d created=%#v body=%s", response.Code, repository.createdUser, response.Body.String())
	}
}

func TestSCIMRequiresTheOperationSchemaAndAcceptsEmailFilter(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read", "scim:write"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	missingSchema := requestSCIM(t, handler, http.MethodPost, "/scim/v2/Users", map[string]any{
		"userName": "alice.employee", "emails": []map[string]any{{"value": "alice@example.com"}},
	})
	if missingSchema.Code != http.StatusBadRequest || repository.createdUser.User.ID != "" {
		t.Fatalf("missing schema status=%d created=%#v body=%s", missingSchema.Code, repository.createdUser, missingSchema.Body.String())
	}

	filtered := requestSCIM(t, handler, http.MethodGet,
		`/scim/v2/Users?filter=emails.value%20eq%20%22Alice%40Example.COM%22`, nil)
	if filtered.Code != http.StatusOK || repository.listedUsers.FilterAttribute != "emails.value" ||
		repository.listedUsers.FilterValue != "Alice@Example.COM" {
		t.Fatalf("filter status=%d query=%#v body=%s", filtered.Code, repository.listedUsers, filtered.Body.String())
	}
}

func TestSCIMSchemasDescribeSupportedAttributes(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	response := requestSCIM(t, handler, http.MethodGet, "/scim/v2/Schemas", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var body struct {
		Resources []struct {
			ID         string `json:"id"`
			Attributes []struct {
				Name          string `json:"name"`
				Type          string `json:"type"`
				Required      bool   `json:"required"`
				SubAttributes []struct {
					Name string `json:"name"`
				} `json:"subAttributes"`
			} `json:"attributes"`
		} `json:"Resources"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Resources) != 2 {
		t.Fatalf("schemas=%#v", body.Resources)
	}
	byID := make(map[string]map[string]bool, len(body.Resources))
	for _, schema := range body.Resources {
		attributes := make(map[string]bool, len(schema.Attributes))
		for _, attribute := range schema.Attributes {
			attributes[attribute.Name] = attribute.Required
		}
		byID[schema.ID] = attributes
	}
	if !byID[userSchema]["userName"] || !byID[groupSchema]["displayName"] {
		t.Fatalf("required attributes=%#v", byID)
	}
	if _, ok := byID[groupSchema]["active"]; ok {
		t.Fatal("Group schema must not advertise the unsupported active attribute")
	}
}

func TestSCIMAuthenticatesBeforeParsingMutationBody(t *testing.T) {
	repository := &scimRepositoryStub{}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/scim/v2/Users", bytes.NewBufferString("not-json"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("WWW-Authenticate"); got != `Bearer realm="antnest-scim"` {
		t.Fatalf("WWW-Authenticate = %q", got)
	}
	if bytes.Contains(response.Body.Bytes(), []byte(`"scimType":"invalidToken"`)) {
		t.Fatalf("OAuth Bearer error leaked into SCIM scimType: %s", response.Body.String())
	}
}

func TestSCIMRejectsTrailingJSONValues(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/scim/v2/Users", strings.NewReader(
		`{"userName":"alice@example.com","displayName":"Alice"}{"active":false}`,
	))
	request.Header.Set("Authorization", "Bearer ant_scim_secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || repository.createdUser.User.ID != "" {
		t.Fatalf("status=%d created=%#v body=%s", response.Code, repository.createdUser, response.Body.String())
	}
}

func TestSCIMRejectsMutationBodyLargerThanOneMiB(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	body := `{"userName":"alice@example.com","displayName":"` + strings.Repeat("x", maxSCIMBody) + `"}`
	request := httptest.NewRequest(http.MethodPost, "/scim/v2/Users", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer ant_scim_secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || repository.createdUser.User.ID != "" {
		t.Fatalf("status=%d created=%#v body=%s", response.Code, repository.createdUser, response.Body.String())
	}
}

func TestSCIMGroupPatchReportsAnEmptyMemberAsInvalidValue(t *testing.T) {
	repository := &scimRepositoryStub{
		authorization: Authorization{
			TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"},
		},
		group: GroupResource{Group: domain.Group{
			ID: "group-1", OrganizationID: "org-1", DisplayName: "Engineering", Source: domain.SourceSCIM,
		}},
	}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	response := requestSCIM(t, handler, http.MethodPatch, "/scim/v2/Groups/group-1", map[string]any{
		"schemas": []string{patchSchema},
		"Operations": []map[string]any{{
			"op": "replace", "path": "members", "value": []map[string]string{{"value": ""}},
		}},
	})
	if response.Code != http.StatusBadRequest || !bytes.Contains(response.Body.Bytes(), []byte(`"scimType":"invalidValue"`)) {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}

func TestSCIMRejectsUnsupportedFilterAndPatchPath(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read", "scim:write"},
	}, user: UserResource{}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	filtered := requestSCIM(t, handler, http.MethodGet, `/scim/v2/Users?filter=name.familyName%20eq%20%22Alice%22`, nil)
	if filtered.Code != http.StatusBadRequest || !bytes.Contains(filtered.Body.Bytes(), []byte("invalidFilter")) {
		t.Fatalf("filter status=%d body=%s", filtered.Code, filtered.Body.String())
	}
	patched := requestSCIM(t, handler, http.MethodPatch, "/scim/v2/Users/user-1", map[string]any{
		"schemas":    []string{patchSchema},
		"Operations": []map[string]any{{"op": "replace", "path": "title", "value": "Engineer"}},
	})
	if patched.Code != http.StatusBadRequest || !bytes.Contains(patched.Body.Bytes(), []byte("invalidPath")) {
		t.Fatalf("patch status=%d body=%s", patched.Code, patched.Body.String())
	}
}

func TestSCIMRejectsEmptyPatchOperationsWithoutWriting(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	response := requestSCIM(t, handler, http.MethodPatch, "/scim/v2/Users/user-1", map[string]any{
		"schemas": []string{patchSchema}, "Operations": []map[string]any{},
	})
	if response.Code != http.StatusBadRequest || repository.replacedUser.Membership.ID != "" {
		t.Fatalf("status=%d replacement=%#v body=%s", response.Code, repository.replacedUser, response.Body.String())
	}
}

func TestSCIMRejectsUnimplementedFilteredEmailPatch(t *testing.T) {
	repository := &scimRepositoryStub{
		authorization: Authorization{TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"}},
		user: UserResource{
			User: domain.User{ID: "user-1", Active: true},
			Membership: domain.OrganizationMembership{
				ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
				Email: "alice@example.com", DisplayName: "Alice", SCIMUserName: "alice",
				Source: domain.SourceSCIM, Active: true,
			},
		},
	}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	response := requestSCIM(t, handler, http.MethodPatch, "/scim/v2/Users/membership-1", map[string]any{
		"schemas": []string{patchSchema},
		"Operations": []map[string]any{{
			"op": "replace", "path": `emails[type eq "home"].value`, "value": "home@example.com",
		}},
	})
	if response.Code != http.StatusBadRequest || !bytes.Contains(response.Body.Bytes(), []byte(`"scimType":"invalidPath"`)) ||
		repository.replacedUser.Membership.ID != "" {
		t.Fatalf("status=%d replacement=%#v body=%s", response.Code, repository.replacedUser, response.Body.String())
	}
}

func TestSCIMPatchCarriesTheVersionItRead(t *testing.T) {
	version := time.Date(2026, 8, 31, 4, 0, 0, 0, time.UTC)
	repository := &scimRepositoryStub{
		authorization: Authorization{TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:write"}},
		user: UserResource{
			User: domain.User{ID: "user-1", Active: true},
			Membership: domain.OrganizationMembership{
				ID: "membership-1", OrganizationID: "org-1", UserID: "user-1",
				Email: "alice@example.com", DisplayName: "Alice", SCIMUserName: "alice",
				Source: domain.SourceSCIM, Active: true, UpdatedAt: version,
			},
		},
	}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	response := requestSCIM(t, handler, http.MethodPatch, "/scim/v2/Users/membership-1", map[string]any{
		"schemas":    []string{patchSchema},
		"Operations": []map[string]any{{"op": "replace", "path": "displayName", "value": "Alice Updated"}},
	})
	if response.Code != http.StatusOK || !repository.replacedUser.ExpectedUpdatedAt.Equal(version) {
		t.Fatalf("status=%d replacement=%#v body=%s", response.Code, repository.replacedUser, response.Body.String())
	}
}

func TestSCIMCountZeroReturnsNoResourcesWithoutExpandingThePage(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	response := requestSCIM(t, handler, http.MethodGet, "/scim/v2/Users?count=0", nil)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if repository.listedUsers.Count != 0 {
		t.Fatalf("repository count = %d, want 0", repository.listedUsers.Count)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["itemsPerPage"] != float64(0) {
		t.Fatalf("response = %#v", body)
	}
}

func TestSCIMUsesProtocolErrorsForPaginationRoutesAndMethods(t *testing.T) {
	repository := &scimRepositoryStub{authorization: Authorization{
		TokenID: "token-1", OrganizationID: "org-1", Scopes: []string{"scim:read"},
	}}
	service := newSCIMTestService(t, repository)
	handler, err := NewHTTPHandler(service, "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}

	invalidPage := requestSCIM(t, handler, http.MethodGet, "/scim/v2/Users?startIndex=0", nil)
	if invalidPage.Code != http.StatusBadRequest ||
		!bytes.Contains(invalidPage.Body.Bytes(), []byte(`"scimType":"invalidValue"`)) {
		t.Fatalf("invalid pagination status=%d body=%s", invalidPage.Code, invalidPage.Body.String())
	}
	wrongMethod := requestSCIM(t, handler, http.MethodPost, "/scim/v2/ServiceProviderConfig", nil)
	if wrongMethod.Code != http.StatusMethodNotAllowed ||
		wrongMethod.Header().Get("Content-Type") != "application/scim+json" ||
		wrongMethod.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("wrong method status=%d headers=%v body=%s", wrongMethod.Code, wrongMethod.Header(), wrongMethod.Body.String())
	}
	unknown := requestSCIM(t, handler, http.MethodGet, "/scim/v2/Unknown", nil)
	if unknown.Code != http.StatusNotFound || unknown.Header().Get("Content-Type") != "application/scim+json" {
		t.Fatalf("unknown route status=%d headers=%v body=%s", unknown.Code, unknown.Header(), unknown.Body.String())
	}
}

func TestSCIMDistinguishesVersionAndMemberReferenceConflicts(t *testing.T) {
	versionResponse := httptest.NewRecorder()
	writeServiceError(versionResponse, domain.ErrVersionConflict)
	if versionResponse.Code != http.StatusConflict ||
		bytes.Contains(versionResponse.Body.Bytes(), []byte(`"scimType":"uniqueness"`)) {
		t.Fatalf("version conflict status=%d body=%s", versionResponse.Code, versionResponse.Body.String())
	}

	memberResponse := httptest.NewRecorder()
	writeServiceError(memberResponse, domain.ErrInvalidReference)
	if memberResponse.Code != http.StatusBadRequest ||
		!bytes.Contains(memberResponse.Body.Bytes(), []byte(`"scimType":"invalidValue"`)) {
		t.Fatalf("invalid member status=%d body=%s", memberResponse.Code, memberResponse.Body.String())
	}
}

func requestSCIM(t *testing.T, handler http.Handler, method, target string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, target, bytes.NewReader(encoded))
	request.Header.Set("Authorization", "Bearer ant_scim_secret")
	request.Header.Set("Content-Type", "application/scim+json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}
