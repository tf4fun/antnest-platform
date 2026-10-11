package scim

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func pairingHTTP(t *testing.T, tokenProvider, memberProvider *string) (*HTTPHandler, *scimRepositoryStub) {
	t.Helper()
	r := &scimRepositoryStub{authorization: Authorization{TokenID: "token-1", OrganizationID: "org-1", OIDCProviderID: tokenProvider, Scopes: []string{"scim:read", "scim:write"}}, user: UserResource{
		User: domain.User{ID: "user-1", Active: true},
		Membership: domain.OrganizationMembership{ID: "member-1", UserID: "user-1", OrganizationID: "org-1", Source: domain.SourceSCIM, Active: true,
			SCIMOIDCProviderID: memberProvider, SCIMExternalID: " original subject ", SCIMUserName: "member@example.com", Email: "member@example.com", DisplayName: "Member", UpdatedAt: time.Date(2026, 10, 11, 0, 0, 0, 0, time.UTC)},
	}}
	h, err := NewHTTPHandler(newSCIMTestService(t, r), "https://identity.example.com")
	if err != nil {
		t.Fatal(err)
	}
	return h, r
}

func rawPairingRequest(t *testing.T, h http.Handler, method, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer synthetic-scim-token")
	r.Header.Set("Content-Type", "application/scim+json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func pairingUserBody(fields string) string {
	return `{"schemas":["` + userSchema + `"],"userName":"member@example.com","displayName":"Changed"` + fields + `}`
}

func TestSCIMPairingCreateValidatesOriginalOpaqueSubjectBeforeStorage(t *testing.T) {
	p := "provider-A"
	quote := func(s string) string { b, _ := json.Marshal(s); return string(b) }
	for _, tc := range []struct {
		name, fields, expected string
		valid                  bool
	}{
		{name: "missing"},
		{name: "null", fields: `,"externalId":null`},
		{name: "empty", fields: `,"externalId":""`},
		{name: "number", fields: `,"externalId":1`},
		{name: "nul", fields: `,"externalId":"a\u0000b"`},
		{name: "high_surrogate", fields: `,"externalId":"\ud800"`},
		{name: "low_surrogate", fields: `,"externalId":"\udfff"`},
		{name: "invalid_utf8", fields: ",\"externalId\":\"" + string([]byte{0xff}) + "\""},
		{name: "256_points", fields: `,"externalId":` + quote(strings.Repeat("界", 256))},
		{name: "duplicate", fields: `,"externalId":"wrong","externalId":"right"`},
		{name: "duplicate_alias", fields: `,"externalId":"wrong","EXTERNALID":"right"`},
		{name: "whitespace", fields: `,"externalId":"   "`, expected: "   ", valid: true},
		{name: "opaque", fields: `,"externalId":" Member-Subject "`, expected: " Member-Subject ", valid: true},
		{name: "255_points", fields: `,"externalId":` + quote(strings.Repeat("界", 255)), expected: strings.Repeat("界", 255), valid: true},
		{name: "255_non_bmp", fields: `,"externalId":` + quote(strings.Repeat("😀", 255)), expected: strings.Repeat("😀", 255), valid: true},
		{name: "surrogate_pair", fields: `,"externalId":"\ud83d\ude00"`, expected: "😀", valid: true},
		{name: "replacement_character", fields: `,"externalId":"\ufffd"`, expected: "�", valid: true},
		{name: "case_compatible", fields: `,"EXTERNALID":" exact "`, expected: " exact ", valid: true},
		{name: "distinct_unicode_attribute", fields: `,"externalId":" exact ","externalİd":"extension value"`, expected: " exact ", valid: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, r := pairingHTTP(t, &p, nil)
			w := rawPairingRequest(t, h, http.MethodPost, "/scim/v2/Users", pairingUserBody(tc.fields))
			want := http.StatusBadRequest
			if tc.valid {
				want = http.StatusCreated
			}
			if w.Code != want {
				t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String())
			}
			if !tc.valid {
				if r.createdUser.User.ID != "" || !strings.Contains(w.Body.String(), `"scimType":"invalidValue"`) {
					t.Fatal("invalid subject reached storage or wrong error")
				}
				return
			}
			m := r.createdUser.Membership
			if m.SCIMExternalID != tc.expected || m.SCIMOIDCProviderID == nil || *m.SCIMOIDCProviderID != p {
				t.Fatalf("lost pairing/exact subject: %+v", m)
			}
		})
	}
}

func TestSCIMPairingUpdatesUseTargetMembershipAuthorization(t *testing.T) {
	p, other := "provider-A", "provider-B"
	for _, token := range []struct {
		name     string
		provider *string
	}{{"same", &p}, {"other", &other}, {"unpaired", nil}} {
		t.Run(token.name, func(t *testing.T) {
			for _, tc := range []struct {
				name, method, body string
				valid              bool
			}{
				{"put_omitted", http.MethodPut, pairingUserBody(""), true},
				{"put_same", http.MethodPut, pairingUserBody(`,"externalId":" original subject "`), true},
				{"put_changed", http.MethodPut, pairingUserBody(`,"externalId":"different"`), false},
				{"put_trimmed", http.MethodPut, pairingUserBody(`,"externalId":"original subject"`), false},
				{"put_empty", http.MethodPut, pairingUserBody(`,"externalId":""`), false},
				{"put_null", http.MethodPut, pairingUserBody(`,"externalId":null`), false},
				{"patch_directory", http.MethodPatch, `{"op":"replace","path":"displayName","value":"Changed"}`, true},
				{"patch_same", http.MethodPatch, `{"op":"replace","path":"ExTeRnAlId","value":" original subject "}`, true},
				{"patch_changed", http.MethodPatch, `{"op":"replace","path":"externalId","value":"different"}`, false},
				{"patch_empty", http.MethodPatch, `{"op":"replace","path":"externalId","value":""}`, false},
				{"patch_null", http.MethodPatch, `{"op":"replace","path":"externalId","value":null}`, false},
				{"patch_remove", http.MethodPatch, `{"op":"remove","path":"externalId"}`, false},
				{"patch_object_same", http.MethodPatch, `{"op":"replace","value":{"EXTERNALID":" original subject ","displayName":"Changed"}}`, true},
				{"patch_object_null", http.MethodPatch, `{"op":"replace","value":{"externalId":null}}`, false},
				{"patch_object_duplicate", http.MethodPatch, `{"op":"replace","value":{"externalId":"other","EXTERNALID":" original subject "}}`, false},
				{"patch_restore_after_remove", http.MethodPatch, `{"op":"remove","path":"externalId"},{"op":"replace","path":"externalId","value":" original subject "}`, false},
			} {
				t.Run(tc.name, func(t *testing.T) {
					h, r := pairingHTTP(t, token.provider, &p)
					body := tc.body
					if tc.method == http.MethodPatch {
						body = `{"schemas":["` + patchSchema + `"],"Operations":[` + body + `]}`
					}
					w := rawPairingRequest(t, h, tc.method, "/scim/v2/Users/member-1", body)
					want := http.StatusBadRequest
					if tc.valid {
						want = http.StatusOK
					}
					if w.Code != want {
						t.Fatalf("status=%d want=%d body=%s", w.Code, want, w.Body.String())
					}
					if !tc.valid {
						if r.replacedUser.Membership.ID != "" || !strings.Contains(w.Body.String(), `"scimType":"invalidValue"`) {
							t.Fatal("invalid mutation reached storage or wrong error")
						}
						return
					}
					m := r.replacedUser.Membership
					if m.SCIMExternalID != " original subject " || m.SCIMOIDCProviderID == nil || *m.SCIMOIDCProviderID != p {
						t.Fatalf("changed subject or target pairing: %+v", m)
					}
				})
			}
		})
	}
}

func TestSCIMPairingLegacyCreateRetainsOptionalDirectoryExternalID(t *testing.T) {
	for _, fields := range []string{"", `,"externalId":null`, `,"externalId":""`, `,"externalId":"  directory value  "`} {
		h, r := pairingHTTP(t, nil, nil)
		w := rawPairingRequest(t, h, http.MethodPost, "/scim/v2/Users", pairingUserBody(fields))
		if w.Code != http.StatusCreated || r.createdUser.Membership.SCIMOIDCProviderID != nil {
			t.Fatalf("legacy directory behavior changed: %d %s", w.Code, w.Body.String())
		}
		want := ""
		if strings.Contains(fields, "directory value") {
			want = "directory value"
		}
		if r.createdUser.Membership.SCIMExternalID != want {
			t.Fatal("legacy directory normalization changed")
		}
	}
}

func TestSCIMPairingPatchRejectsOverwrittenOperationsAndValues(t *testing.T) {
	p := "provider-A"
	valid := `[{"op":"replace","path":"displayName","value":"Changed"}]`
	remove := `[{"op":"remove","path":"externalId"}]`
	for _, fields := range []string{
		`"Operations":` + remove + `,"Operations":` + valid,
		`"Operations":` + remove + `,"operations":` + valid,
		`"Operations":` + remove + `,"operationſ":` + valid,
		`"Operations":[{"op":"remove","op":"replace","path":"externalId","value":" original subject "}]`,
		`"Operations":[{"op":"remove","OP":"replace","path":"externalId","value":" original subject "}]`,
		`"Operations":[{"op":"replace","path":"externalId","PATH":"displayName","value":"Changed"}]`,
		`"Operations":[{"op":"replace","path":"externalId","value":"other","value":" original subject "}]`,
		`"Operations":[{"op":"replace","path":"externalId","value":"\ud800","VALUE":" original subject "}]`,
		`"Operations":[{"op":"replace","path":"displayName","value":"` + string([]byte{0xff}) + `"}]`,
	} {
		h, r := pairingHTTP(t, &p, &p)
		w := rawPairingRequest(t, h, http.MethodPatch, "/scim/v2/Users/member-1", `{"schemas":["`+patchSchema+`"],`+fields+`}`)
		if w.Code != http.StatusBadRequest || r.replacedUser.Membership.ID != "" || !strings.Contains(w.Body.String(), `"scimType":"invalidValue"`) {
			t.Fatalf("ambiguous PATCH reached storage: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestSCIMPairingRejectsRepairedSubjectMatchingStoredReplacementCharacter(t *testing.T) {
	p := "provider-A"
	for _, method := range []string{http.MethodPut, http.MethodPatch} {
		for _, raw := range []string{`"\ud800"`, `"\udfff"`, `"` + string([]byte{0xff}) + `"`, `"\ufffd"`} {
			h, r := pairingHTTP(t, nil, &p)
			r.user.Membership.SCIMExternalID = "�"
			body := pairingUserBody(`,"externalId":` + raw)
			if method == http.MethodPatch {
				body = `{"schemas":["` + patchSchema + `"],"Operations":[{"op":"replace","path":"externalId","value":` + raw + `}]}`
			}
			w := rawPairingRequest(t, h, method, "/scim/v2/Users/member-1", body)
			want := http.StatusBadRequest
			if raw == `"\ufffd"` {
				want = http.StatusOK
			}
			if w.Code != want || want == http.StatusBadRequest && r.replacedUser.Membership.ID != "" {
				t.Fatalf("repaired raw subject matched real U+FFFD: %d %s", w.Code, w.Body.String())
			}
		}
	}
}

func TestSCIMPairingLegacyUpdatesRetainDirectorySemantics(t *testing.T) {
	for _, tc := range []struct{ method, body, want string }{
		{http.MethodPut, pairingUserBody(""), ""},
		{http.MethodPut, pairingUserBody(`,"externalId":null`), ""},
		{http.MethodPut, pairingUserBody(`,"externalId":" value "`), "value"},
		{http.MethodPatch, `{"op":"replace","path":"displayName","value":"Changed"}`, "original subject"},
		{http.MethodPatch, `{"op":"replace","path":"externalId","value":null}`, "original subject"},
		{http.MethodPatch, `{"op":"remove","path":"externalId"}`, ""},
		{http.MethodPatch, `{"op":"replace","path":"externalId","value":" value "}`, "value"},
	} {
		h, r := pairingHTTP(t, nil, nil)
		body := tc.body
		if tc.method == http.MethodPatch {
			body = `{"schemas":["` + patchSchema + `"],"Operations":[` + body + `]}`
		}
		w := rawPairingRequest(t, h, tc.method, "/scim/v2/Users/member-1", body)
		if w.Code != http.StatusOK || r.replacedUser.Membership.SCIMExternalID != tc.want || r.replacedUser.Membership.SCIMOIDCProviderID != nil {
			t.Fatalf("legacy update changed: %d %s", w.Code, w.Body.String())
		}
	}
}
