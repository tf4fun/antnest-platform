package scim

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

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

	created := requestSCIM(t, handler, http.MethodPost, "/scim/v2/Users", map[string]any{
		"schemas": []string{userSchema}, "externalId": "workday-42",
		"userName": "alice@example.com", "displayName": "Alice", "active": true,
	})
	if created.Code != http.StatusCreated {
		t.Fatalf("create status=%d body=%s", created.Code, created.Body.String())
	}
	var resource map[string]any
	if err := json.Unmarshal(created.Body.Bytes(), &resource); err != nil {
		t.Fatal(err)
	}
	if resource["id"] != "id-2" || resource["userName"] != "alice@example.com" {
		t.Fatalf("resource = %#v", resource)
	}
	meta, _ := resource["meta"].(map[string]any)
	if meta["location"] != "https://identity.example.com/scim/v2/Users/id-2" {
		t.Fatalf("meta = %#v", meta)
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
