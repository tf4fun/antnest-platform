package identityclient

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestResolveOwnerAuthorization(t *testing.T) {
	for _, test := range []struct {
		name  string
		body  string
		valid bool
	}{
		{"active", `{"authorization":{"user_id":"user-a","organization_id":"org-a","membership_id":"member-a","active":true,"last_revocation_sequence":7}}`, true},
		{"missing_watermark", `{"authorization":{"user_id":"user-a","organization_id":"org-a","membership_id":"member-a","active":true}}`, false},
		{"negative_watermark", `{"authorization":{"user_id":"user-a","organization_id":"org-a","membership_id":"member-a","active":true,"last_revocation_sequence":-1}}`, false},
		{"wrong_owner", `{"authorization":{"user_id":"user-b","organization_id":"org-a","membership_id":"member-a","active":true,"last_revocation_sequence":7}}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/rpc/identity/resolve-owner-authorization" {
					t.Errorf("path=%s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			result, err := client.ResolveOwnerAuthorization(context.Background(), "org-a", "user-a")
			if (err == nil) != test.valid {
				t.Fatalf("result=%+v err=%v", result, err)
			}
			if test.valid && (!result.Active || result.LastRevocationSequence != 7) {
				t.Fatalf("result=%+v", result)
			}
		})
	}
}

func TestListPrincipalRevocationsValidatesWholePage(t *testing.T) {
	const event = `{"sequence":5,"user_id":"user-a","organization_id":"org-a","reason":"membership_deactivated","occurred_at":"2026-09-08T01:00:00Z"}`
	for _, test := range []struct {
		name, body string
		valid      bool
	}{
		{"ordered_gap", `{"events":[` + event + `],"next_sequence":5}`, true},
		{"duplicate", `{"events":[` + event + `,` + event + `],"next_sequence":5}`, false},
		{"cursor_skip", `{"events":[` + event + `],"next_sequence":6}`, false},
		{"empty_skip", `{"events":[],"next_sequence":6}`, false},
		{"missing_page", `{}`, false},
		{"global_wrong_scope", `{"events":[{"sequence":5,"user_id":"user-a","organization_id":"org-a","reason":"user_deactivated","occurred_at":"2026-09-08T01:00:00Z"}],"next_sequence":5}`, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/rpc/identity/list-principal-revocations" {
					t.Errorf("path=%s", r.URL.Path)
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = fmt.Fprint(w, test.body)
			}))
			defer server.Close()
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatal(err)
			}
			result, err := client.ListPrincipalRevocations(context.Background(), 2, 100)
			if (err == nil) != test.valid {
				t.Fatalf("page=%+v err=%v", result, err)
			}
		})
	}
}
