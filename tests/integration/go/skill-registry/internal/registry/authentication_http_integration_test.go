package registry

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

func TestRealHTTPAuthenticationRejectsDuplicatesScopeAndRedirectBypasses(t *testing.T) {
	store := &memoryStore{}
	h := newTestHandler(t, NewService(store))
	server := httptest.NewServer(h)
	defer server.Close()
	client := server.Client()
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	defer client.CloseIdleConnections()
	for _, tc := range []struct {
		name, path string
		headers    http.Header
		status     int
		code       string
	}{
		{"missing", "/internal/skills", nil, 401, "service_unauthenticated"},
		{"legacy", "/internal/skills", http.Header{"Authorization": {"Bearer " + testToken}}, 401, "service_unauthenticated"},
		{"duplicate", "/internal/skills", http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"], "Bearer " + h.tokens["admin-console"]}}, 401, "service_unauthenticated"},
		{"mixed name", "/internal/skills", http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"]}, "antnest-service-authorization": {"Bearer " + h.tokens["admin-console"]}}, 401, "service_unauthenticated"},
		{"comma", "/internal/skills", http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"] + ", Bearer " + h.tokens["admin-console"]}}, 401, "service_unauthenticated"},
		{"wrong caller", "/internal/skills", http.Header{serviceauth.Header: {"Bearer " + h.tokens["runtime-controller"]}}, 403, "caller_not_allowed"},
		{"no CCT", "/internal/skills", http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"]}}, 401, "caller_context_required"},
		{"duplicate CCT", "/internal/skills", http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"]}, callercontext.Header: {h.contextToken(nil), h.contextToken(nil)}}, 401, "caller_context_invalid"},
		{"wrong org", "/internal/skills?organization_id=" + testOther, http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"]}, callercontext.Header: {h.contextToken(nil)}}, 403, "organization_mismatch"},
		{"repeated query", "/internal/skills?organization_id=" + testOrg + "&organization_id=" + testOther, http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"]}, callercontext.Header: {h.contextToken(nil)}}, 400, "invalid_request"},
		{"malformed query", "/internal/skills?organization_id=%XX", http.Header{serviceauth.Header: {"Bearer " + h.tokens["admin-console"]}, callercontext.Header: {h.contextToken(nil)}}, 400, "invalid_request"},
		{"clean path redirect", "/internal/../internal/skills", nil, 401, "service_unauthenticated"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req, err := http.NewRequestWithContext(t.Context(), "GET", server.URL+tc.path, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = tc.headers
			response, err := client.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			body, err := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if response.StatusCode != tc.status || !bytes.Contains(body, []byte(tc.code)) {
				t.Fatalf("unexpected boundary: %d %s", response.StatusCode, body)
			}
			if tc.code == "service_unauthenticated" && response.Header.Get("WWW-Authenticate") != `Bearer realm="antnest-service"` {
				t.Fatal("missing exact workload challenge")
			}
			if tc.code != "service_unauthenticated" && response.Header.Get("WWW-Authenticate") != "" {
				t.Fatal("scope/role rejection emitted workload challenge")
			}
		})
	}
	if len(store.receipts) != 0 || len(store.items) != 0 {
		t.Fatal("denials created business state")
	}
	for _, path := range []string{"/status", "/internal/skills?organization_id=" + testOrg} {
		req, _ := http.NewRequestWithContext(t.Context(), "GET", server.URL+path, nil)
		if path != "/status" {
			h.Authorize(req, "admin-console")
		}
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		if response.StatusCode != 200 {
			t.Fatal("valid readiness/list failed")
		}
	}

	for _, entries := range [][]string{{"application/json", "application/json"}, {"application/json, application/json"}, {"application/json; charset=utf-8"}} {
		req, _ := http.NewRequestWithContext(t.Context(), "POST", server.URL+"/internal/skill-versions/resolve", strings.NewReader(`{"organization_id":"`+testOrg+`","refs":[]}`))
		h.Authorize(req, "agent-controller")
		req.Header["Content-Type"] = entries
		response, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = response.Body.Close()
		want := 415
		if len(entries) == 1 && entries[0] == "application/json; charset=utf-8" {
			want = 200
		}
		if response.StatusCode != want {
			t.Fatalf("real media handling=%d want=%d", response.StatusCode, want)
		}
	}
}
