package server

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
)

func TestContractConventionsCatalogListQuery(t *testing.T) {
	for _, form := range []struct {
		name, query string
	}{
		{name: "canonical", query: "cursor=page-2"},
		{name: "legacy", query: "after_id=page-2"},
	} {
		t.Run(form.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/admin/model-profiles?"+form.query+"&limit=20", nil)
			query, ok := catalogListQuery(recorder, request, "org-1")
			if !ok {
				t.Fatalf("rejected: %d", recorder.Code)
			}
			if !strings.Contains(query, "cursor=page-2") || strings.Contains(query, "after_id") {
				t.Fatalf("upstream query=%q", query)
			}
			if !strings.Contains(query, "organization_id=org-1") {
				t.Fatalf("organization scope lost: %q", query)
			}
		})
	}
	for _, test := range []struct{ name, query string }{
		{name: "both", query: "cursor=a&after_id=a"},
		{name: "both_differ", query: "cursor=a&after_id=b"},
		{name: "empty", query: "cursor="},
		{name: "duplicate", query: "cursor=a&cursor=b"},
		{name: "unknown", query: "cursor=a&unknown=1"},
		{name: "overlong", query: "cursor=" + strings.Repeat("a", 4097)},
		{name: "limit_zero", query: "limit=0"},
	} {
		t.Run("rejects/"+test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodGet, "/api/admin/model-profiles?"+test.query, nil)
			if _, ok := catalogListQuery(recorder, request, "org-1"); ok {
				t.Fatalf("accepted %s", test.query)
			}
		})
	}
}

func TestContractConventionsSkillListPages(t *testing.T) {
	for _, test := range []struct {
		name, stubBody, query, want string
	}{
		{name: "canonical_next", stubBody: `{"items":[],"next_cursor":"skill_cursor"}`, query: "cursor=page-1", want: `"next_cursor":"skill_cursor"`},
		{name: "legacy_next", stubBody: `{"items":[],"next_after_id":"skill_cursor"}`, query: "cursor=page-1", want: `"next_cursor":"skill_cursor"`},
		{name: "legacy_request", stubBody: `{"items":[],"next_cursor":"skill_cursor"}`, query: "after_id=page-1", want: `"next_cursor":"skill_cursor"`},
		{name: "end_of_page", stubBody: `{"items":[]}`, query: "", want: `"next_cursor":null`},
	} {
		t.Run("skills/"+test.name, func(t *testing.T) {
			stub := &skillStub{body: test.stubBody}
			handler := skillHandler(t, stub)
			target := "/api/admin/skills"
			if test.query != "" {
				target += "?" + test.query
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, skillRequest(http.MethodGet, target, nil, "", ""))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), test.want) || strings.Contains(recorder.Body.String(), "next_after_id") || strings.Contains(recorder.Body.String(), "next_after_version") {
				t.Fatalf("page=%s", recorder.Body.String())
			}
			if len(stub.calls) != 1 {
				t.Fatalf("upstream calls=%d", len(stub.calls))
			}
			query, err := url.ParseQuery(stub.calls[0].query)
			if err != nil {
				t.Fatal(err)
			}
			if test.query != "" {
				if got := query.Get("cursor"); got == "" {
					t.Fatalf("upstream cursor missing: %s", stub.calls[0].query)
				}
			}
			if query.Has("after_id") || query.Has("after_version") {
				t.Fatalf("legacy key forwarded: %s", stub.calls[0].query)
			}
			if query.Get("organization_id") != "org-1" {
				t.Fatalf("organization scope lost: %s", stub.calls[0].query)
			}
		})
	}
	for _, test := range []struct {
		name, stubBody, want string
	}{
		{name: "canonical", stubBody: `{"items":[],"next_cursor":"2"}`, want: `"next_cursor":"2"`},
		{name: "legacy", stubBody: `{"items":[],"next_after_version":2}`, want: `"next_cursor":"2"`},
	} {
		t.Run("versions/"+test.name, func(t *testing.T) {
			stub := &skillStub{body: test.stubBody}
			handler := skillHandler(t, stub)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, skillRequest(http.MethodGet,
				"/api/admin/skills/skill_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/versions?cursor=1", nil, "", ""))
			if recorder.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if !strings.Contains(recorder.Body.String(), test.want) || strings.Contains(recorder.Body.String(), "next_after") {
				t.Fatalf("page=%s", recorder.Body.String())
			}
			if len(stub.calls) != 1 {
				t.Fatalf("upstream calls=%d", len(stub.calls))
			}
			query, err := url.ParseQuery(stub.calls[0].query)
			if err != nil {
				t.Fatal(err)
			}
			if got := query.Get("cursor"); got != "1" {
				t.Fatalf("upstream cursor=%q raw=%s", got, stub.calls[0].query)
			}
			if query.Has("after_version") || query.Has("after_id") {
				t.Fatalf("legacy key forwarded: %s", stub.calls[0].query)
			}
			if query.Get("organization_id") != "org-1" {
				t.Fatalf("organization scope lost: %s", stub.calls[0].query)
			}
		})
	}
}

func TestContractConventionsBrowserAndExternalProjections(t *testing.T) {
	actor := principal.Principal{OrganizationID: "org-1", UserID: "user-admin"}
	out, err := projectBrowserSessions([]byte(`{"items":[],"next_cursor":null}`), actor, "user-admin", "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"next_cursor":null`) || strings.Contains(string(out), "next_after_id") {
		t.Fatalf("browser sessions projection=%s", out)
	}
	out, err = projectExternalIdentityProviders([]byte(`{"items":[],"next_cursor":null}`), "", 10)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(out), `"next_cursor":null`) || strings.Contains(string(out), "next_after_id") {
		t.Fatalf("providers projection=%s", out)
	}
}

func TestContractConventionsProjectionPages(t *testing.T) {
	for _, test := range []struct {
		name, body, want string
	}{
		{name: "model_canonical", body: `{"items":[],"next_cursor":"m-2"}`, want: `"next_cursor":"m-2"`},
		{name: "model_legacy", body: `{"items":[],"next_after_id":"m-2"}`, want: `"next_cursor":"m-2"`},
		{name: "model_end", body: `{"items":[]}`, want: `"next_cursor":null`},
	} {
		t.Run(test.name, func(t *testing.T) {
			out, err := projectModelProfileList([]byte(test.body))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(out), test.want) || strings.Contains(string(out), "next_after_id") {
				t.Fatalf("projection=%s", out)
			}
		})
	}
}

func TestContractConventionsProjectionRequiresItems(t *testing.T) {
	for _, project := range []func([]byte) ([]byte, error){projectModelProfileList, projectTemplateList} {
		for _, body := range []string{`{}`, `{"items":null}`} {
			if _, err := project([]byte(body)); err == nil {
				t.Fatalf("invalid page admitted: %s", body)
			}
		}
	}
}

func TestContractConventionsModelCallPolicyPreconditions(t *testing.T) {
	for _, form := range []struct {
		name string
		body func() string
		head string
	}{
		{name: "canonical", body: func() string {
			return strings.Replace(modelCallPolicyBody, `"expected_revision":0`, `"expected_version":"0"`, 1)
		}},
		{name: "legacy", body: func() string { return modelCallPolicyBody }},
		{name: "if_match", body: func() string {
			return strings.Replace(modelCallPolicyBody, `"expected_revision":0,`, ``, 1)
		}, head: `"0"`},
	} {
		t.Run(form.name, func(t *testing.T) {
			backend := newBackendStub()
			backend.enqueue(http.StatusOK, modelCallPolicyUpstreamPolicy("org-1", 1))
			request := modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, form.body(), "org-1")
			if form.head != "" {
				request.Header.Set("If-Match", form.head)
			}
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(backend.calls) != 1 {
				t.Fatalf("backend calls=%d", len(backend.calls))
			}
			var sent map[string]any
			decodeBytes(t, backend.calls[0].Body, &sent)
			if sent["expected_version"] != "0" {
				t.Fatalf("outbound expected_version=%v", sent["expected_version"])
			}
			if _, present := sent["expected_revision"]; present {
				t.Fatalf("legacy name emitted: %v", sent)
			}
		})
	}
	for _, test := range []struct {
		name string
		body string
		head []string
	}{
		{name: "body_and_header", body: strings.Replace(modelCallPolicyBody, `"expected_revision":0`, `"expected_version":"0"`, 1), head: []string{`"0"`}},
		{name: "weak", body: modelCallPolicyBody, head: []string{`W/"0"`}},
		{name: "wildcard", body: modelCallPolicyBody, head: []string{`*`}},
		{name: "repeated", body: modelCallPolicyBody, head: []string{`"0"`, `"0"`}},
		{name: "null", body: strings.Replace(modelCallPolicyBody, `"expected_revision":0`, `"expected_version":null`, 1)},
		{name: "overflow", body: strings.Replace(modelCallPolicyBody, `"expected_revision":0`, `"expected_version":"99999999999999999999"`, 1)},
	} {
		t.Run("rejects/"+test.name, func(t *testing.T) {
			backend := newBackendStub()
			request := modelCallPolicyRequest(http.MethodPut, modelCallPolicyPath, test.body, "org-1")
			for _, tag := range test.head {
				request.Header.Add("If-Match", tag)
			}
			response := httptest.NewRecorder()
			newTestHandler(t, backend).ServeHTTP(response, request)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
			}
			if len(backend.calls) != 0 {
				t.Fatalf("backend called %d times", len(backend.calls))
			}
		})
	}
}

func TestContractConventionsCommandRequestID(t *testing.T) {
	build := func(value string, extra string) *http.Request {
		request := httptest.NewRequest(http.MethodPost, "/api/admin/model-profiles", nil)
		request.Header.Set("Idempotency-Key", value)
		if extra != "" {
			request.Header.Add("Idempotency-Key", extra)
		}
		return request
	}
	first := httptest.NewRecorder()
	id1, ok := commandRequestID(first, build("contract-conventions-key-1", ""), "org-1", "conventions")
	if !ok {
		t.Fatalf("rejected original key: %d", first.Code)
	}
	second := httptest.NewRecorder()
	id2, ok := commandRequestID(second, build("contract-conventions-key-1", ""), "org-1", "conventions")
	if !ok || id1 != id2 {
		t.Fatalf("request id unstable: %q vs %q", id1, id2)
	}
	for _, test := range []struct{ name, value, extra string }{
		{name: "duplicate", value: "contract-conventions-key-1", extra: "contract-conventions-key-1"},
		{name: "surrounding_whitespace", value: " contract-conventions-key-1 ", extra: ""},
	} {
		recorder := httptest.NewRecorder()
		if _, ok := commandRequestID(recorder, build(test.value, test.extra), "org-1", "conventions"); ok {
			t.Fatalf("%s accepted", test.name)
		}
	}
}
