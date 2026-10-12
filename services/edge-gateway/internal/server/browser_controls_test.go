package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

type browserRPCRecord struct {
	Path string
	Body map[string]any
}

type browserRPCFailure struct {
	status     int
	body       string
	retryAfter []string
}

type browserControlFixture struct {
	mu        sync.Mutex
	records   []browserRPCRecord
	status    map[string]int
	code      map[string]string
	replies   map[string]string
	failures  map[string]browserRPCFailure
	handler   http.Handler
	now       time.Time
	principal identity.Principal
}

func newBrowserControlFixture(t *testing.T) *browserControlFixture {
	t.Helper()
	f := &browserControlFixture{now: time.Now().UTC().Truncate(time.Second), status: map[string]int{}, code: map[string]string{}, replies: map[string]string{}, failures: map[string]browserRPCFailure{}}
	f.principal = ordinaryPrincipal()
	f.principal.ExpiresAt, f.principal.IdleExpiresAt = f.now.Add(12*time.Hour), f.now.Add(30*time.Minute)
	f.principal.ActivityIntervalMS = 30000
	claims, _ := json.Marshal(map[string]any{"iat": f.now.Unix(), "exp": f.now.Add(time.Minute).Unix(), "sid": "token-1"})
	f.principal.CallerContext = base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"EdDSA"}`)) + "." + base64.RawURLEncoding.EncodeToString(claims) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 64))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		path := strings.TrimPrefix(r.URL.Path, "/rpc/identity/")
		f.mu.Lock()
		f.records = append(f.records, browserRPCRecord{Path: path, Body: body})
		status, code := f.status[path], f.code[path]
		failure, failed := f.failures[path]
		f.mu.Unlock()
		if failed {
			for _, value := range failure.retryAfter {
				w.Header().Add("Retry-After", value)
			}
			w.Header().Set("Set-Cookie", "private-upstream-cookie=private-authority; Path=/")
			w.Header().Set("Cache-Control", "public, max-age=3600")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(failure.status)
			_, _ = w.Write([]byte(failure.body))
			return
		}
		if status != 0 {
			writeJSON(w, status, map[string]any{"code": code, "message": "private internal detail", "retryable": status >= 500})
			return
		}
		metadata := map[string]any{"expires_at": f.principal.ExpiresAt, "idle_expires_at": f.principal.IdleExpiresAt, "activity_interval_ms": 30000}
		switch path {
		case "resolve-access-token":
			if r.Header.Get(identity.CallerContextHeader) != "" || body["access_token"] != "old-private-token" || body["profile"] != "session" || body["agent_id"] != nil {
				t.Error("browser session route did not select trusted session-only resolution")
			}
			metadata["principal"], metadata["caller_context"] = f.principal, f.principal.CallerContext
		case "local-login":
			metadata["principal"], metadata["access_token"], metadata["token_id"] = f.principal, "old-private-token", "token-1"
		case "start-oidc-login":
			metadata = map[string]any{"authorization_url": "https://id.example.test/authorize?state=state-1", "expires_at": f.now.Add(time.Minute)}
		default:
			if r.Header.Get(identity.CallerContextHeader) != f.principal.CallerContext || body["actor_principal_id"] != f.principal.UserID {
				t.Error("browser control lost trusted actor or forwarded a browser-supplied CCT")
			}
			f.mu.Lock()
			reply, overridden := f.replies[path]
			f.mu.Unlock()
			if overridden {
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(reply))
				return
			}
			switch path {
			case "get-current-account":
				metadata = map[string]any{"account": map[string]any{"user_id": f.principal.UserID, "organization_id": f.principal.OrganizationID, "organization_slug": "engineering", "organization_name": "Engineering", "membership_id": f.principal.MembershipID, "email": "member@example.com", "display_name": "Member", "source": "local", "local_password_available": true}}
			case "touch-browser-session":
			case "change-local-password":
				metadata["status"], metadata["principal"], metadata["access_token"], metadata["token_id"] = "changed", f.principal, "new-private-token", "token-2"
			case "list-user-sessions":
				metadata = map[string]any{"sessions": []any{map[string]any{"id": "public-session", "organization_id": "org-1", "organization_slug": "engineering", "organization_name": "Engineering", "created_at": f.now, "last_active_at": f.now, "expires_at": f.principal.ExpiresAt, "idle_expires_at": f.principal.IdleExpiresAt, "user_agent_hint": "<script>plain text</script>", "current": true}}}
			case "revoke-user-sessions":
				metadata = map[string]any{"revoked_count": 1, "current_revoked": body["mode"] == "all"}
			case "list-external-identities", "unbind-external-identity", "acknowledge-external-identity-notices":
				metadata = externalIdentityControlReply(path, body, f.now)
				if path == "unbind-external-identity" && body["allow_lockout"] == true {
					f.mu.Lock()
					f.status["resolve-access-token"], f.code["resolve-access-token"] = 401, "unauthenticated"
					f.mu.Unlock()
				}
			default:
				t.Error("unexpected Identity call")
				w.WriteHeader(404)
				return
			}
		}
		writeJSON(w, 200, metadata)
	}))
	t.Cleanup(upstream.Close)
	client, err := identity.NewClient(upstream.URL, upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	f.handler = newTestHandler(t, client, http.NotFoundHandler(), f.now)
	return f
}

func (f *browserControlFixture) request(method, path, body string) *http.Request {
	r := newBrowserRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set(session.CSRFHeaderName, testCSRFToken)
	r.Header.Set(identity.CallerContextHeader, "forged-browser-cct")
	addSessionCookies(r, "old-private-token", testCSRFToken)
	return r
}

func (f *browserControlFixture) calls() []browserRPCRecord {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]browserRPCRecord(nil), f.records...)
}

func TestGatewayBrowserControlsUseOwningRPCAndPublicSchemas(t *testing.T) {
	for _, row := range []struct{ method, path, body, rpc, schema string }{
		{"GET", "/api/session", "", "resolve-access-token", "session"},
		{"GET", "/api/session/account", "", "get-current-account", "account"},
		{"POST", "/api/session/activity", "{}", "touch-browser-session", "activity"},
		{"POST", "/api/session/password", `{"current_password":"old-password","new_password":"new-password-123"}`, "change-local-password", "password_rotation"},
		{"GET", "/api/session/sessions?limit=50", "", "list-user-sessions", "session_list"},
		{"POST", "/api/session/sessions/revoke", `{"mode":"others"}`, "revoke-user-sessions", "session_revocation"},
		{"POST", "/api/session/sessions/revoke", `{"mode":"all"}`, "revoke-user-sessions", "session_revocation"},
	} {
		t.Run(row.path+row.body, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request(row.method, row.path, row.body))
			if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("control status=%d body=%s", w.Code, w.Body.String())
			}
			value, err := jsonschema.UnmarshalJSON(bytes.NewReader(w.Body.Bytes()))
			if err != nil {
				t.Fatal(err)
			}
			if err := compileOrganizationSchema(t, "edge-gateway/session-response.schema.json", row.schema).Validate(value); err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"old-private-token", "new-private-token", "token-1", "token-2", f.principal.CallerContext} {
				if strings.Contains(w.Body.String(), secret) {
					t.Fatal("browser response exposed private authority")
				}
			}
			calls := f.calls()
			if len(calls) == 0 || calls[len(calls)-1].Path != row.rpc {
				t.Fatal("control did not reach owning RPC")
			}
			for _, call := range calls {
				if call.Path == "touch-browser-session" && row.rpc != "touch-browser-session" {
					t.Fatal("ordinary request extended idle expiry")
				}
			}
			if row.rpc == "list-user-sessions" || row.rpc == "revoke-user-sessions" {
				body := calls[len(calls)-1].Body
				if body["scope"] != "self" || body["user_id"] != f.principal.UserID || body["organization_id"] != nil {
					t.Fatal("browser overrode trusted scope")
				}
			}
			cookies := w.Result().Cookies()
			if row.rpc == "change-local-password" {
				if len(cookies) != 2 {
					t.Fatal("successful rotation did not replace both cookies")
				}
				for _, c := range cookies {
					if !c.Expires.Equal(f.principal.ExpiresAt) {
						t.Fatal("cookie failed to inherit absolute deadline")
					}
				}
			} else if len(cookies) != 0 {
				t.Fatal("ordinary control wrote cookies")
			}
		})
	}
}

func TestGatewayBrowserControlsRejectAmbiguousInputWithoutEffects(t *testing.T) {
	for _, row := range []struct{ method, path, body string }{
		{"GET", "/api/session/account?user_id=other", ""}, {"GET", "/api/session/account", "{}"},
		{"POST", "/api/session/activity", `{"actor_principal_id":"other"}`}, {"POST", "/api/session/activity", "null"},
		{"POST", "/api/session/password", `{"current_password":"old","new_password":"new-password-123","user_id":"other"}`},
		{"POST", "/api/session/password", `{"current_password":"old","current_password":"other","new_password":"new-password-123"}`},
		{"POST", "/api/session/password", `{"current_password":"old","NEW_PASSWORD":"new-password-123"}`},
		{"POST", "/api/session/password", `{"current_password":"","new_password":"short"}`},
		{"POST", "/api/session/password", `{"current_password":"old","new_password":"` + strings.Repeat("x", 1025) + `"}`},
		{"POST", "/api/session/password", `{"current_password":"old","new_password":"` + strings.Repeat("字", 342) + `"}`},
		{"GET", "/api/session/sessions", ""}, {"GET", "/api/session/sessions?limit=1&limit=2", ""},
		{"GET", "/api/session/sessions?limit=101", ""}, {"GET", "/api/session/sessions?limit=1&after_id=", ""},
		{"GET", "/api/session/sessions?limit=1&scope=organization", ""}, {"GET", "/api/session/sessions?limit=1", "{}"},
		{"POST", "/api/session/sessions/revoke", `{"mode":"all","except_token_id":"other"}`},
		{"POST", "/api/session/sessions/revoke", `{"mode":"others","mode":"all"}`},
		{"POST", "/api/session/sessions/revoke", `{"mode":"organization"}`},
	} {
		t.Run(row.path+row.body, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request(row.method, row.path, row.body))
			if w.Code != 400 {
				t.Fatalf("ambiguous input status=%d", w.Code)
			}
			for _, call := range f.calls() {
				if call.Path != "resolve-access-token" {
					t.Fatal("invalid input reached control RPC")
				}
			}
			if len(w.Result().Cookies()) != 0 {
				t.Fatal("invalid input changed cookies")
			}
		})
	}
}

func TestGatewayBrowserMutationsRequireOriginAndBoundCSRF(t *testing.T) {
	for _, path := range []string{"/api/session/activity", "/api/session/password", "/api/session/sessions/revoke"} {
		for _, admission := range []string{"origin", "csrf"} {
			t.Run(path+admission, func(t *testing.T) {
				f := newBrowserControlFixture(t)
				r := f.request("POST", path, "{}")
				if admission == "origin" {
					r.Header.Set("Origin", "https://foreign.example")
				} else {
					r.Header.Set(session.CSRFHeaderName, "forged")
				}
				w := httptest.NewRecorder()
				f.handler.ServeHTTP(w, r)
				if w.Code != 403 {
					t.Fatalf("missing admission: status=%d", w.Code)
				}
				for _, call := range f.calls() {
					if call.Path != "resolve-access-token" {
						t.Fatal("rejected mutation reached Identity control")
					}
				}
				if admission == "origin" && len(f.calls()) != 0 {
					t.Fatal("foreign Origin reached Identity")
				}
				if len(w.Result().Cookies()) != 0 {
					t.Fatal("admission failure changed cookies")
				}
			})
		}
	}
}

func TestGatewayBrowserPasswordErrorsPreserveCookies(t *testing.T) {
	for _, row := range []struct {
		status     int
		code       string
		publicCode string
	}{{400, "invalid_current_password", "invalid_current_password"}, {400, "invalid_argument", "invalid_request"}, {400, "bad_request", "invalid_request"}, {401, "unauthenticated", "unauthenticated"}, {403, "forbidden", "forbidden"}, {500, "internal_error", "identity_unavailable"}} {
		t.Run(row.code, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			f.status["change-local-password"], f.code["change-local-password"] = row.status, row.code
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request("POST", "/api/session/password", `{"current_password":"wrong","new_password":"new-password-123"}`))
			want := row.status
			if want == 500 {
				want = 503
			}
			if w.Code != want || len(w.Result().Cookies()) != 0 {
				t.Fatalf("failed rotation status=%d cookies=%d", w.Code, len(w.Result().Cookies()))
			}
			if strings.Contains(w.Body.String(), "private internal detail") {
				t.Fatal("Identity internal detail exposed")
			}
			var failure struct {
				Code string `json:"code"`
			}
			if json.Unmarshal(w.Body.Bytes(), &failure) != nil || failure.Code != row.publicCode {
				t.Fatalf("password error misclassified: got=%s want=%s", failure.Code, row.publicCode)
			}
		})
	}
}

func TestBrowserLoginUserAgentIsHeaderDerivedAndUnicodeBounded(t *testing.T) {
	for _, row := range []struct{ path, body, rpc string }{{"/api/session/login", `{"organization_slug":"engineering","email":"member@example.com","password":"secret"}`, "local-login"}, {"/api/session/oidc/start", `{"organization_slug":"engineering","provider_name":"workforce"}`, "start-oidc-login"}} {
		t.Run(row.path, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			r := f.request("POST", row.path, row.body)
			r.Header.Set("User-Agent", strings.Repeat("界", 260))
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != 200 {
				t.Fatalf("login status=%d", w.Code)
			}
			calls := f.calls()
			if len(calls) != 1 || calls[0].Path != row.rpc || calls[0].Body["user_agent_hint"] != strings.Repeat("界", 256) {
				t.Fatal("login hint was not truncated from the browser header by Unicode characters")
			}
		})
	}
}
