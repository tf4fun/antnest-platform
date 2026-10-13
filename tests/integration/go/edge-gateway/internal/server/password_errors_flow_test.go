package server

import (
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

// This component uses a real Gateway HTTP/TLS listener and Identity client.
// The trusted Identity double isolates consumer behavior; actual Identity
// attempt accounting and cross-service HTTPS remain the integration batch.
func TestPasswordAdmissionFlowPreservesBrowserSession(t *testing.T) {
	for _, secure := range []bool{false, true} {
		for _, route := range []struct{ path, rpc, body string }{
			{"/api/session/login", "local-login", `{"organization_slug":"engineering","email":"member@example.com","password":"private-password-canary"}`},
			{"/api/session/password", "change-local-password", `{"current_password":"private-password-canary","new_password":"new-password-123"}`},
		} {
			t.Run(strconv.FormatBool(secure)+"/"+route.rpc, func(t *testing.T) {
				f := newBrowserControlFixture(t)
				h := f.handler.(*handler)
				var err error
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
				client.Timeout = 5 * time.Second
				defer client.CloseIdleConnections()
				client.Jar, err = cookiejar.New(nil)
				if err != nil {
					t.Fatal(err)
				}
				edgeURL, err := url.Parse(edge.URL)
				if err != nil {
					t.Fatal(err)
				}
				cookies := func() map[string]string {
					result := map[string]string{}
					for _, cookie := range client.Jar.Cookies(edgeURL) {
						result[cookie.Name] = cookie.Value
					}
					return result
				}
				request := func(method, path, body string) (*http.Response, string) {
					t.Helper()
					r, err := http.NewRequestWithContext(t.Context(), method, edge.URL+path, strings.NewReader(body))
					if err != nil {
						t.Fatal(err)
					}
					r.Header.Set("Origin", edge.URL)
					r.Header.Set("Content-Type", "application/json")
					for name, value := range cookies() {
						if name == session.CSRFCookieName || name == "__Host-"+session.CSRFCookieName {
							r.Header.Set(session.CSRFHeaderName, value)
						}
					}
					res, err := client.Do(r)
					if err != nil {
						t.Fatal(err)
					}
					payload, err := io.ReadAll(res.Body)
					_ = res.Body.Close()
					if err != nil {
						t.Fatal(err)
					}
					for _, secret := range []string{"private-password-canary", "private-authority", "private-token", f.principal.CallerContext} {
						if strings.Contains(string(payload), secret) {
							t.Fatal("browser received private upstream data")
						}
					}
					return res, string(payload)
				}
				res, _ := request("POST", "/api/session/login", `{"organization_slug":"engineering","email":"member@example.com","password":"initial-password"}`)
				if res.StatusCode != 200 || len(res.Cookies()) != 2 {
					t.Fatal("initial login failed")
				}
				originalCookies := cookies()
				if len(originalCookies) != 2 {
					t.Fatal("cookie jar lost initial session")
				}
				for _, cookie := range res.Cookies() {
					if cookie.Secure != secure || secure && !strings.HasPrefix(cookie.Name, "__Host-") {
						t.Fatal("wrong cookie security mode")
					}
				}
				for _, row := range []struct {
					name        string
					failure     browserRPCFailure
					status      int
					retry, code string
				}{
					{"busy", browserRPCFailure{503, passwordBusyJSON, []string{"1"}}, 503, "1", "credential_busy"},
					{"rate-first", browserRPCFailure{429, passwordRateJSON, []string{"1"}}, 429, "1", "credential_rate_limited"},
					{"rate-max", browserRPCFailure{429, passwordRateJSON, []string{"900"}}, 429, "900", "credential_rate_limited"},
					{"duplicate-header", browserRPCFailure{429, passwordRateJSON, []string{"1", "1"}}, 503, "", "identity_unavailable"},
					{"missing-header", browserRPCFailure{503, passwordBusyJSON, nil}, 503, "", "identity_unavailable"},
					{"wrong-status", browserRPCFailure{401, passwordBusyJSON, []string{"1"}}, 503, "", "identity_unavailable"},
					{"duplicate-code", browserRPCFailure{401, strings.TrimSuffix(passwordBusyJSON, "}") + `,"code":"unauthenticated"}`, []string{"1"}}, 503, "", "identity_unavailable"},
					{"private-extra", browserRPCFailure{503, strings.TrimSuffix(passwordBusyJSON, "}") + `,"token":"private-authority"}`, []string{"1"}}, 503, "", "identity_unavailable"},
				} {
					t.Run(row.name, func(t *testing.T) {
						f.mu.Lock()
						f.failures[route.rpc] = row.failure
						f.mu.Unlock()
						before := len(f.calls())
						res, body := request("POST", route.path, route.body)
						if res.StatusCode != row.status || !strings.Contains(body, `"code":"`+row.code+`"`) || res.Header.Get("Cache-Control") != "no-store" || len(res.Header.Values("Set-Cookie")) != 0 {
							t.Fatal("invalid browser failure projection")
						}
						values := res.Header.Values("Retry-After")
						if row.retry == "" && len(values) != 0 || row.retry != "" && (len(values) != 1 || values[0] != row.retry) {
							t.Fatal("invalid browser retry metadata")
						}
						owningCalls := 0
						for _, call := range f.calls()[before:] {
							if call.Path == route.rpc {
								owningCalls++
							} else if call.Path != "resolve-access-token" {
								t.Fatal("failed password request performed another mutation")
							}
						}
						if owningCalls != 1 {
							t.Fatal("password request was replayed")
						}
						if !reflect.DeepEqual(cookies(), originalCookies) {
							t.Fatal("failure changed the cookie jar")
						}
						res, _ = request("GET", "/api/session", "")
						if res.StatusCode != 200 || len(res.Cookies()) != 0 {
							t.Fatal("existing session no longer works")
						}
					})
				}
				f.mu.Lock()
				delete(f.failures, route.rpc)
				f.mu.Unlock()
				// Use a different account key for login recovery so this component
				// does not trip the independent per-account edge prefilter.
				body := strings.Replace(route.body, "member@example.com", "recovered@example.com", 1)
				res, _ = request("POST", route.path, body)
				if res.StatusCode != 200 || len(res.Cookies()) != 2 {
					t.Fatal("password operation did not recover")
				}
			})
		}
	}
}
