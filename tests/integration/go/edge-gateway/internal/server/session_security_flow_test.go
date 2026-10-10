package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

// The fixture is the trusted issuer transport, not a browser-supplied JWS.
// Gateway checks framing; downstream services separately verify signatures.
func sessionFlowContext(sid string, issued int64, sequence int32) string {
	claims := map[string]any{"sid": sid, "iat": issued, "exp": issued + 60, "jti": "fresh-context-" + strconv.Itoa(int(sequence))}
	header, _ := json.Marshal(map[string]string{"alg": "EdDSA", "typ": "antnest-cct+jwt", "kid": "fixture"})
	body, _ := json.Marshal(claims)
	return base64.RawURLEncoding.EncodeToString(header) + "." + base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 64))
}

func TestSessionSecurityFlowThroughTrustedIssuer(t *testing.T) {
	for _, secure := range []bool{false, true} {
		t.Run("secure="+strconv.FormatBool(secure), func(t *testing.T) {
			var resolves, writes, revokes atomic.Int32
			var malformed atomic.Bool
			now := time.Now()
			issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				var input map[string]string
				if json.NewDecoder(r.Body).Decode(&input) != nil {
					t.Error("invalid issuer request")
					w.WriteHeader(400)
					return
				}
				switch r.URL.Path {
				case "/rpc/identity/local-login":
					suffix := "1"
					if input["email"] == "second@example.test" {
						suffix = "2"
					}
					_ = json.NewEncoder(w).Encode(identity.LoginResult{Principal: administratorPrincipal(), TokenID: "token-" + suffix, AccessToken: "private-token-" + suffix, ExpiresAt: now.Add(time.Hour)})
				case "/rpc/identity/resolve-access-token":
					sequence := resolves.Add(1)
					sid := strings.TrimPrefix(input["access_token"], "private-")
					if malformed.Load() {
						sid = ""
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"principal": administratorPrincipal(), "caller_context": sessionFlowContext(sid, now.Unix()+int64(sequence), sequence)})
				case "/rpc/identity/revoke-access-token":
					revokes.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
				default:
					t.Errorf("unexpected issuer route %s", r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer issuer.Close()
			issuerClient, err := identity.NewClient(issuer.URL, issuer.Client())
			if err != nil {
				t.Fatal(err)
			}
			h := newTestHandler(t, issuerClient, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				writes.Add(1)
				if r.Header.Get("Cookie") != "" || r.Header.Get(session.CSRFHeaderName) != "" || r.Header.Get("X-Antnest-Session-ID") != "" {
					t.Error("browser credential reached upstream")
				}
				w.WriteHeader(http.StatusAccepted)
			}), now).(*handler)
			h.sessions, err = session.NewManager(session.Config{Secure: secure, CSRFKey: []byte(testCSRFKey)})
			if err != nil {
				t.Fatal(err)
			}
			var edge *httptest.Server
			if secure {
				edge = httptest.NewTLSServer(h)
			} else {
				edge = httptest.NewServer(h)
			}
			defer edge.Close()
			client := edge.Client()
			client.Timeout = time.Second
			defer client.CloseIdleConnections()
			request := func(method, path, cookie, csrf, body string) (*http.Response, string) {
				t.Helper()
				r, err := http.NewRequest(method, edge.URL+path, strings.NewReader(body))
				if err != nil {
					t.Fatal(err)
				}
				r.Header.Set("Origin", edge.URL)
				r.Header.Set("Content-Type", "application/json")
				if cookie != "" {
					r.Header.Set("Cookie", cookie)
				}
				if csrf != "" {
					r.Header.Set(session.CSRFHeaderName, csrf)
				}
				r.Header.Set("X-Antnest-Session-ID", "token-1")
				res, err := client.Do(r)
				if err != nil {
					t.Fatal(err)
				}
				payload, err := io.ReadAll(res.Body)
				_ = res.Body.Close()
				if err != nil {
					t.Fatal(err)
				}
				if strings.Contains(string(payload), "private-token-") || strings.Contains(string(payload), "session_id") || strings.Contains(string(payload), "caller_context") || strings.Contains(string(payload), "token_id") {
					t.Fatal("private issuer data leaked to browser JSON")
				}
				return res, string(payload)
			}
			prefix := ""
			if secure {
				prefix = "__Host-"
			}
			var sessionCookies, csrfValues []string
			for _, email := range []string{"first@example.test", "second@example.test"} {
				res, body := request(http.MethodPost, "/api/session/login", "", "", `{"organization_slug":"engineering","email":"`+email+`","password":"synthetic"}`)
				if res.StatusCode != 200 {
					t.Fatalf("login %d %s", res.StatusCode, body)
				}
				cookies := res.Cookies()
				if len(cookies) != 2 {
					t.Fatalf("login cookie count=%d", len(cookies))
				}
				if cookies[0].Name != prefix+session.AccessTokenCookieName || cookies[1].Name != prefix+session.CSRFCookieName || cookies[0].Secure != secure || cookies[1].Secure != secure || !cookies[0].HttpOnly || cookies[1].HttpOnly {
					t.Fatal("wrong cookie mode")
				}
				sessionCookies = append(sessionCookies, cookies[0].Name+"="+cookies[0].Value)
				csrfValues = append(csrfValues, cookies[1].Value)
			}
			if csrfValues[0] != testCSRFToken || csrfValues[0] == csrfValues[1] {
				t.Fatal("login did not bind each session")
			}
			res, body := request(http.MethodGet, "/api/session", sessionCookies[1], "", "")
			if res.StatusCode != 200 {
				t.Fatalf("read without delivery cookie %d %s", res.StatusCode, body)
			}
			for _, path := range []string{"/api/admin/agents", "/api/app/workspace/v1/agents/agent-1/messages", "/api/app/agents/agent-1/v1/acp"} {
				before := writes.Load()
				for _, bad := range []string{"planted", csrfValues[0]} {
					res, body := request(http.MethodPost, path, sessionCookies[1]+"; "+prefix+session.CSRFCookieName+"="+bad, bad, `{}`)
					if res.StatusCode != 403 || !strings.Contains(body, `"code":"csrf_failed"`) || writes.Load() != before || len(res.Cookies()) != 0 {
						t.Fatalf("unbound mutation %d %s", res.StatusCode, body)
					}
				}
				res, body := request(http.MethodPost, path, sessionCookies[1], csrfValues[1], `{}`)
				if res.StatusCode != 202 || writes.Load() != before+1 {
					t.Fatalf("valid bound mutation %d %s", res.StatusCode, body)
				}
			}
			if secure {
				before := resolves.Load()
				res, _ := request(http.MethodGet, "/api/session", "antnest_session=private-token-2; antnest_csrf="+csrfValues[1], "", "")
				if res.StatusCode != 401 || resolves.Load() != before {
					t.Fatal("production accepted legacy cookie names")
				}
			}
			malformed.Store(true)
			res, body = request(http.MethodDelete, "/api/session", sessionCookies[1], csrfValues[1], "")
			if res.StatusCode != 503 || !strings.Contains(body, `"code":"identity_unavailable"`) || revokes.Load() != 0 || len(res.Cookies()) != 0 {
				t.Fatalf("malformed issuer logout %d %s", res.StatusCode, body)
			}
			malformed.Store(false)
			res, body = request(http.MethodDelete, "/api/session", sessionCookies[1], csrfValues[1], "")
			if res.StatusCode != 204 || revokes.Load() != 1 || len(res.Cookies()) != 2 {
				t.Fatalf("logout %d %s", res.StatusCode, body)
			}
			for _, c := range res.Cookies() {
				if !strings.HasPrefix(c.Name, prefix+"antnest_") || c.Value != "" || c.MaxAge != -1 {
					t.Fatal("logout cleared the wrong cookie mode")
				}
			}
		})
	}
}
