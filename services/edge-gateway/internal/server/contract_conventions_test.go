package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestContractConventionsCursorRoutes(t *testing.T) {
	for _, test := range []struct {
		name, route, reply, url string
		wantCursor              any
	}{
		{name: "sessions_canonical", route: "list-user-sessions", reply: `{"items":[],"next_cursor":null}`,
			url: "/api/session/sessions?limit=2&cursor=public-before", wantCursor: "public-before"},
		{name: "sessions_legacy", route: "list-user-sessions", reply: `{"items":[],"next_cursor":null}`,
			url: "/api/session/sessions?limit=2&after_id=public-before", wantCursor: "public-before"},
		{name: "identities_canonical", route: "list-external-identities", reply: `{"items":[],"notices":[],"next_cursor":null}`,
			url: "/api/session/external-identities?limit=2&cursor=public-before&notice_after_id=notice-before", wantCursor: "public-before"},
		{name: "identities_legacy", route: "list-external-identities", reply: `{"items":[],"notices":[],"next_cursor":null}`,
			url: "/api/session/external-identities?limit=2&after_id=public-before&notice_after_id=notice-before", wantCursor: "public-before"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			f.replies[test.route] = test.reply
			recorder := httptest.NewRecorder()
			f.handler.ServeHTTP(recorder, f.request("GET", test.url, ""))
			if recorder.Code != 200 {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			var document map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &document); err != nil {
				t.Fatal(err)
			}
			if _, ok := document["items"]; !ok {
				t.Fatalf("missing items: %s", recorder.Body.String())
			}
			if cursor, ok := document["next_cursor"]; !ok || cursor != nil {
				t.Fatalf("next_cursor=%v: %s", cursor, recorder.Body.String())
			}
			for _, banned := range []string{"sessions", "bindings", "next_after_id"} {
				if _, ok := document[banned]; ok {
					t.Fatalf("legacy field %s emitted: %s", banned, recorder.Body.String())
				}
			}
			if strings.Contains(test.name, "identities") {
				if _, ok := document["notices"]; !ok {
					t.Fatalf("notices missing: %s", recorder.Body.String())
				}
			}
			found := false
			for _, call := range f.calls() {
				if call.Path == test.route {
					found = true
					if call.Body["actor_principal_id"] != f.principal.UserID {
						t.Fatalf("actor=%v", call.Body["actor_principal_id"])
					}
					if call.Body["scope"] != "self" {
						t.Fatalf("scope=%v", call.Body["scope"])
					}
					if test.route == "list-user-sessions" && call.Body["user_id"] != f.principal.UserID {
						t.Fatalf("user_id=%v", call.Body["user_id"])
					}
					if call.Body["cursor"] != test.wantCursor {
						t.Fatalf("upstream cursor=%v body=%v", call.Body["cursor"], call.Body)
					}
					if _, present := call.Body["after_id"]; present {
						t.Fatalf("legacy key forwarded: %v", call.Body)
					}
					if strings.Contains(test.name, "identities") && call.Body["notice_after_id"] != "notice-before" {
						t.Fatalf("notice cursor=%v", call.Body)
					}
				}
			}
			if !found {
				t.Fatalf("no %s call recorded", test.route)
			}
		})
	}
}

func TestContractConventionsCursorRejections(t *testing.T) {
	for _, test := range []struct {
		name, url string
	}{
		{name: "both_equal", url: "/api/session/sessions?limit=2&cursor=a&after_id=a"},
		{name: "both_differ", url: "/api/session/sessions?limit=2&cursor=a&after_id=b"},
		{name: "empty", url: "/api/session/sessions?limit=2&cursor="},
		{name: "duplicate", url: "/api/session/sessions?limit=2&cursor=a&cursor=b"},
		{name: "overlong", url: "/api/session/sessions?limit=2&cursor=" + strings.Repeat("a", 4097)},
		{name: "unknown", url: "/api/session/sessions?limit=2&cursor=a&unknown=1"},
		{name: "limit_zero", url: "/api/session/sessions?limit=0&cursor=a"},
		{name: "identities_both", url: "/api/session/external-identities?limit=2&cursor=a&after_id=a"},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			recorder := httptest.NewRecorder()
			f.handler.ServeHTTP(recorder, f.request("GET", test.url, ""))
			if recorder.Code != 400 {
				t.Fatalf("status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			for _, call := range f.calls() {
				if call.Path == "list-user-sessions" || call.Path == "list-external-identities" {
					t.Fatalf("rejected request reached %s", call.Path)
				}
			}
		})
	}
}
