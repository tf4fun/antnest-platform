package rpc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/externalidentities"
)

func TestContractConventionsListUserSessionsCursorForms(t *testing.T) {
	for _, form := range []struct {
		name  string
		field string
	}{
		{name: "canonical", field: `"cursor":"public-session"`},
		{name: "legacy", field: `"after_id":"public-session"`},
	} {
		t.Run(form.name, func(t *testing.T) {
			h, _, _, browser, cct := browserRPC(t)
			body := `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10,` + form.field + `}`
			response := browserRPCRequest(h, ContractRoutes["list_user_sessions"], body, gatewayTestToken, cct)
			if response.Code != 200 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if browser.list.AfterID != "public-session" {
				t.Fatalf("AfterID=%q", browser.list.AfterID)
			}
			var document map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
				t.Fatal(err)
			}
			if _, ok := document["items"]; !ok {
				t.Fatalf("missing items: %s", response.Body.String())
			}
			cursor, present := document["next_cursor"]
			if !present {
				t.Fatalf("missing next_cursor: %s", response.Body.String())
			}
			if cursor != nil {
				if _, ok := cursor.(string); !ok {
					t.Fatalf("next_cursor type: %s", response.Body.String())
				}
			}
			for _, banned := range []string{"sessions", "next_after_id"} {
				if _, ok := document[banned]; ok {
					t.Fatalf("legacy field %s emitted: %s", banned, response.Body.String())
				}
			}
		})
	}
}

func TestContractConventionsListExternalIdentitiesCursorForms(t *testing.T) {
	for _, form := range []struct {
		name, body, token string
	}{
		{name: "self_canonical", body: `{"actor_principal_id":"admin","scope":"self","limit":10,"cursor":"binding-1"}`, token: gatewayTestToken},
		{name: "self_legacy", body: `{"actor_principal_id":"admin","scope":"self","limit":10,"after_id":"binding-1"}`, token: gatewayTestToken},
		{name: "org_canonical", body: `{"actor_principal_id":"admin","scope":"organization","membership_id":"member-1","limit":10,"cursor":"binding-1"}`, token: consoleTestToken},
		{name: "org_legacy", body: `{"actor_principal_id":"admin","scope":"organization","membership_id":"member-1","limit":10,"after_id":"binding-1"}`, token: consoleTestToken},
	} {
		t.Run(form.name, func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			notices := []externalidentities.Notice{}
			repository.page = &externalidentities.Page{
				Bindings:    []externalidentities.Binding{},
				NextAfterID: "binding-2",
			}
			if strings.Contains(form.name, "self") {
				repository.page.Notices = &notices
				repository.page.NextNoticeAfterID = "notice-2"
			}
			response := browserRPCRequest(h, ContractRoutes["list_external_identities"], form.body, form.token, cct)
			if response.Code != 200 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var document map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
				t.Fatal(err)
			}
			if _, ok := document["items"]; !ok {
				t.Fatalf("missing items: %s", response.Body.String())
			}
			if document["next_cursor"] != "binding-2" {
				t.Fatalf("next_cursor=%v body=%s", document["next_cursor"], response.Body.String())
			}
			for _, banned := range []string{"bindings", "next_after_id"} {
				if _, ok := document[banned]; ok {
					t.Fatalf("legacy field %s emitted: %s", banned, response.Body.String())
				}
			}
			if strings.Contains(form.name, "self") {
				if _, ok := document["notices"]; !ok {
					t.Fatalf("self notices missing: %s", response.Body.String())
				}
				if document["next_notice_after_id"] != "notice-2" {
					t.Fatalf("self notice cursor=%v body=%s", document["next_notice_after_id"], response.Body.String())
				}
			}
		})
	}
}

func TestContractConventionsListExternalIdentitiesEndOfPage(t *testing.T) {
	h, _, _, repository, cct := externalRPC(t)
	repository.page = &externalidentities.Page{Bindings: []externalidentities.Binding{}}
	response := browserRPCRequest(h, ContractRoutes["list_external_identities"],
		`{"actor_principal_id":"admin","scope":"self","limit":10,"cursor":"binding-1"}`, gatewayTestToken, cct)
	if response.Code != 200 {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var document map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
		t.Fatal(err)
	}
	cursor, present := document["next_cursor"]
	if !present || cursor != nil {
		t.Fatalf("end-of-page next_cursor=%v body=%s", cursor, response.Body.String())
	}
}

func TestContractConventionsListProvidersCursorForms(t *testing.T) {
	for _, form := range []struct {
		name, field string
	}{
		{name: "canonical", field: `"cursor":"provider-1"`},
		{name: "legacy", field: `"after_id":"provider-1"`},
	} {
		t.Run(form.name, func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			repository.providers = &externalidentities.ProvidersPage{
				Providers:   []externalidentities.Provider{},
				NextAfterID: "provider-2",
			}
			body := `{"actor_principal_id":"admin","limit":10,` + form.field + `}`
			response := browserRPCRequest(h, ContractRoutes["list_external_identity_providers"], body, consoleTestToken, cct)
			if response.Code != 200 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			var document map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &document); err != nil {
				t.Fatal(err)
			}
			if document["next_cursor"] != "provider-2" {
				t.Fatalf("next_cursor=%v body=%s", document["next_cursor"], response.Body.String())
			}
			for _, banned := range []string{"providers", "next_after_id"} {
				if _, ok := document[banned]; ok {
					t.Fatalf("legacy field %s emitted: %s", banned, response.Body.String())
				}
			}
		})
	}
}

func TestContractConventionsListRejections(t *testing.T) {
	cases := []struct {
		name    string
		field   string
		noLimit bool
	}{
		{name: "both_equal", field: `"cursor":"public-session","after_id":"public-session"`},
		{name: "both_differ", field: `"cursor":"a","after_id":"b"`},
		{name: "null", field: `"cursor":null`},
		{name: "non_string", field: `"cursor":1`},
		{name: "empty", field: `"cursor":""`},
		{name: "overlong", field: `"cursor":"` + strings.Repeat("a", 4097) + `"`},
		{name: "unknown_field", field: `"cursor":"x","unrelated":1`},
		{name: "limit_zero", field: `"cursor":"x","limit":0`},
		{name: "limit_over", field: `"cursor":"x","limit":101`},
		{name: "limit_negative", field: `"cursor":"x","limit":-1`},
		{name: "missing_limit", field: `"cursor":"x"`, noLimit: true},
	}
	for _, test := range cases {
		t.Run("sessions/"+test.name, func(t *testing.T) {
			h, _, _, browser, cct := browserRPC(t)
			body := `{"actor_principal_id":"admin","user_id":"admin","scope":"self",` + test.field
			if !test.noLimit && !strings.Contains(test.field, `"limit"`) {
				body += `,"limit":10`
			}
			body += `}`
			response := browserRPCRequest(h, ContractRoutes["list_user_sessions"], body, gatewayTestToken, cct)
			if response.Code != 400 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if browser.calls != 0 {
				t.Fatalf("service called: %d", browser.calls)
			}
		})
		t.Run("external/"+test.name, func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			body := `{"actor_principal_id":"admin","scope":"self",` + test.field
			if !test.noLimit && !strings.Contains(test.field, `"limit"`) {
				body += `,"limit":10`
			}
			body += `}`
			response := browserRPCRequest(h, ContractRoutes["list_external_identities"], body, gatewayTestToken, cct)
			if response.Code != 400 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if repository.calls != 0 {
				t.Fatalf("repository called: %d", repository.calls)
			}
		})
		t.Run("providers/"+test.name, func(t *testing.T) {
			h, _, _, repository, cct := externalRPC(t)
			body := `{"actor_principal_id":"admin",` + test.field
			if !test.noLimit && !strings.Contains(test.field, `"limit"`) {
				body += `,"limit":10`
			}
			body += `}`
			response := browserRPCRequest(h, ContractRoutes["list_external_identity_providers"], body, consoleTestToken, cct)
			if response.Code != 400 {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if repository.calls != 0 {
				t.Fatalf("repository called: %d", repository.calls)
			}
		})
	}
}

func TestContractConventionsListRejectsDuplicateCursorKey(t *testing.T) {
	h, _, _, browser, cct := browserRPC(t)
	body := `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10,"cursor":"a","cursor":"a"}`
	response := browserRPCRequest(h, ContractRoutes["list_user_sessions"], body, gatewayTestToken, cct)
	if response.Code != 400 {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	if browser.calls != 0 {
		t.Fatalf("service called: %d", browser.calls)
	}
}
