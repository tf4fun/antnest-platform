package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"
)

func browserCaller(t *testing.T) Principal {
	t.Helper()
	return Principal{UserID: "user-1", OrganizationID: "org-1", MembershipID: "member-1", Active: true,
		SystemRole: "user", OrganizationRole: "member", CallerContext: testIssuerContext(t), SessionID: "old-private-sid",
		ExpiresAt: time.Date(2026, 10, 12, 13, 0, 0, 0, time.UTC), IdleExpiresAt: time.Date(2026, 10, 12, 1, 30, 0, 0, time.UTC), ActivityIntervalMS: 30000}
}

func browserControlReply(t *testing.T, route string) map[string]any {
	t.Helper()
	switch route {
	case "get-current-account":
		return map[string]any{"account": map[string]any{"user_id": "user-1", "organization_id": "org-1", "organization_slug": "engineering", "organization_name": "Engineering", "membership_id": "member-1", "email": "member@example.com", "display_name": "Member", "source": "local", "local_password_available": true}}
	case "touch-browser-session":
		return map[string]any{"expires_at": "2026-10-12T13:00:00Z", "idle_expires_at": "2026-10-12T01:30:00Z", "activity_interval_ms": 30000}
	case "change-local-password":
		payload := browserSessionResponse(t)
		payload["status"] = "changed"
		delete(payload, "caller_context")
		return payload
	case "list-user-sessions":
		return map[string]any{"sessions": []any{map[string]any{"id": "public-session", "organization_id": "org-1", "organization_slug": "engineering", "organization_name": "Engineering", "created_at": "2026-10-12T01:00:00Z", "last_active_at": "2026-10-12T01:00:00Z", "idle_expires_at": "2026-10-12T01:30:00Z", "expires_at": "2026-10-12T13:00:00Z", "user_agent_hint": "plain <script>", "current": true}}, "next_after_id": "public-session"}
	case "revoke-user-sessions":
		return map[string]any{"revoked_count": 2, "current_revoked": false}
	case "list-session-revocations":
		return map[string]any{"events": []any{map[string]any{"sequence": 8, "token_id": "old-private-sid", "user_id": "user-1", "organization_id": "org-1", "reason": "session_revoked", "occurred_at": "2026-10-12T01:00:00Z"}}, "next_sequence": 8}
	default:
		t.Fatal("unknown control fixture")
		return nil
	}
}

func callBrowserControl(ctx context.Context, client *Client, route string) (any, error) {
	switch route {
	case "get-current-account":
		return client.CurrentAccount(ctx)
	case "touch-browser-session":
		return client.TouchSession(ctx)
	case "change-local-password":
		return client.ChangePassword(ctx, PasswordInput{RequestID: "request-1", CurrentPassword: "old-secret", NewPassword: "new-secret-password"})
	case "list-user-sessions":
		return client.ListSessions(ctx, SessionListInput{Limit: 50, AfterID: "public-before"})
	case "revoke-user-sessions":
		return client.RevokeSessions(ctx, SessionRevokeInput{RequestID: "request-1", Mode: "others"})
	case "list-session-revocations":
		return client.ListSessionRevocations(ctx, 7, 50)
	}
	panic("unknown control")
}

func TestBrowserControlClientBindsAuthorityAndKeepsFeedWorkloadOnly(t *testing.T) {
	for _, route := range []string{"get-current-account", "touch-browser-session", "change-local-password", "list-user-sessions", "revoke-user-sessions", "list-session-revocations"} {
		t.Run(route, func(t *testing.T) {
			principal := browserCaller(t)
			client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Method != http.MethodPost || request.URL.Path != "/rpc/identity/"+route {
					t.Fatal("wrong owning RPC")
				}
				var input map[string]any
				if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
					t.Fatal(err)
				}
				if route == "list-session-revocations" {
					if request.Header.Get(CallerContextHeader) != "" || input["after_sequence"] != float64(7) || input["limit"] != float64(50) || len(input) != 2 {
						t.Fatal("feed inherited browser authority or lost its bounded cursor")
					}
				} else {
					if request.Header.Get(CallerContextHeader) != principal.CallerContext || input["actor_principal_id"] != principal.UserID {
						t.Fatal("control omitted trusted browser authority")
					}
					if route == "get-current-account" && input["organization_id"] != principal.OrganizationID {
						t.Fatal("account changed current organization")
					}
					if strings.Contains(route, "user-sessions") && (input["scope"] != "self" || input["user_id"] != principal.UserID || input["organization_id"] != nil || input["except_token_id"] != nil) {
						t.Fatal("self control accepted caller-controlled scope")
					}
					if route == "change-local-password" && (input["user_id"] != principal.UserID || input["current_password"] != "old-secret" || input["new_password"] != "new-secret-password" || input["request_id"] != "request-1") {
						t.Fatal("password rotation lost expected current-user input")
					}
				}
				payload, _ := json.Marshal(browserControlReply(t, route))
				return jsonResponse(200, string(payload)), nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			result, err := callBrowserControl(WithPrincipal(t.Context(), principal), client, route)
			if err != nil {
				t.Fatalf("control response rejected: %v", err)
			}
			if route != "change-local-password" && route != "list-session-revocations" {
				data, _ := json.Marshal(result)
				for _, secret := range []string{"old-private-sid", principal.CallerContext, "organization_name\":\"Engineering"} {
					if secret == "organization_name\":\"Engineering" && route != "get-current-account" {
						continue
					}
					if strings.Contains(string(data), secret) {
						t.Fatal("control projection exposed private or out-of-contract fields")
					}
				}
			}
		})
	}
}

func TestBrowserControlClientRequiresVerifiedPrincipalContext(t *testing.T) {
	client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("missing browser authority reached Identity")
		return nil, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	for _, route := range []string{"get-current-account", "touch-browser-session", "change-local-password", "list-user-sessions", "revoke-user-sessions"} {
		for _, ctx := range []context.Context{t.Context(), WithPrincipal(t.Context(), Principal{}), WithPrincipal(t.Context(), Principal{CallerContext: "unscoped"})} {
			if _, err := callBrowserControl(ctx, client, route); err == nil {
				t.Fatal("missing browser authority accepted")
			}
		}
	}
}

func TestBrowserControlClientRejectsMalformedResponses(t *testing.T) {
	for _, route := range []string{"get-current-account", "touch-browser-session", "change-local-password", "list-user-sessions", "revoke-user-sessions", "list-session-revocations"} {
		t.Run(route, func(t *testing.T) {
			for _, payload := range []string{`{}`, `null`, `{"sessions":null}`, `{"events":null,"next_sequence":7}`, `{"revoked_count":-1,"current_revoked":false}`} {
				client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return jsonResponse(200, payload), nil })})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := callBrowserControl(WithPrincipal(t.Context(), browserCaller(t)), client, route); err == nil || IsCode(err, "unauthenticated") {
					t.Fatal("malformed control response admitted as authority")
				}
			}
		})
	}
}

func TestBrowserSessionInventoryAcceptsAdvancingCursorPastFreshlyExpiredRows(t *testing.T) {
	for _, empty := range []bool{false, true} {
		for _, cursor := range []string{"public-z", "public-before", "public-a", "bad cursor"} {
			t.Run(cursor+map[bool]string{true: "/empty", false: "/visible"}[empty], func(t *testing.T) {
				payload := browserControlReply(t, "list-user-sessions")
				payload["next_after_id"] = cursor
				if empty {
					payload["sessions"] = []any{}
				}
				data, _ := json.Marshal(payload)
				client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return jsonResponse(200, string(data)), nil })})
				if err != nil {
					t.Fatal(err)
				}
				page, err := client.ListSessions(WithPrincipal(t.Context(), browserCaller(t)), SessionListInput{Limit: 50, AfterID: "public-before"})
				if cursor == "public-z" {
					if err != nil || page.NextAfterID != cursor {
						t.Fatalf("producer cursor past expired scan rows was rejected: %v", err)
					}
				} else if err == nil {
					t.Fatal("invalid or non-advancing cursor accepted")
				}
			})
		}
	}
}

func TestBrowserSessionPublicIDsFollowTheirClosedASCIISchema(t *testing.T) {
	for _, invalid := range []string{"public/z", "public:z", "公开", "_public", strings.Repeat("z", 201)} {
		for _, field := range []string{"id", "next_after_id", "after_id"} {
			t.Run(field+"/"+invalid, func(t *testing.T) {
				payload := browserControlReply(t, "list-user-sessions")
				query := SessionListInput{Limit: 50, AfterID: "public-before"}
				switch field {
				case "id":
					payload["sessions"].([]any)[0].(map[string]any)["id"] = invalid
					delete(payload, "next_after_id")
				case "next_after_id":
					payload["sessions"], payload["next_after_id"] = []any{}, invalid
				case "after_id":
					query.AfterID = invalid
					payload = map[string]any{"sessions": []any{}}
				}
				data, _ := json.Marshal(payload)
				calls := 0
				client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { calls++; return jsonResponse(200, string(data)), nil })})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := client.ListSessions(WithPrincipal(t.Context(), browserCaller(t)), query); err == nil {
					t.Fatal("public identifier violated the browser schema")
				}
				if field == "after_id" && calls != 0 {
					t.Fatal("invalid public cursor reached Identity")
				}
			})
		}
	}
}

func TestBrowserCurrentAccountIDsRequirePublicSchemaEvenWhenTheyMatchCaller(t *testing.T) {
	for _, field := range []string{"user_id", "organization_id", "membership_id"} {
		t.Run(field, func(t *testing.T) {
			principal := browserCaller(t)
			payload := browserControlReply(t, "get-current-account")
			payload["account"].(map[string]any)[field] = "public/invalid"
			switch field {
			case "user_id":
				principal.UserID = "public/invalid"
			case "organization_id":
				principal.OrganizationID = "public/invalid"
			case "membership_id":
				principal.MembershipID = "public/invalid"
			}
			data, _ := json.Marshal(payload)
			client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return jsonResponse(200, string(data)), nil })})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := client.CurrentAccount(WithPrincipal(t.Context(), principal)); err == nil {
				t.Fatal("matching internal IDs escaped the public account schema")
			}
		})
	}
}
