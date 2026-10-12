package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

const passwordBusyJSON = `{"code":"credential_busy","message":"Password verification is busy","retryable":true}`
const passwordRateJSON = `{"code":"credential_rate_limited","message":"Too many password attempts","retryable":true}`

func TestGatewayPasswordAdmissionFailureProjectionAndRecovery(t *testing.T) {
	for _, route := range []struct{ path, body, rpc string }{
		{"/api/session/login", `{"organization_slug":"engineering","email":"member@example.com","password":"private-password-canary"}`, "local-login"},
		{"/api/session/password", `{"current_password":"private-password-canary","new_password":"new-password-123"}`, "change-local-password"},
	} {
		for _, row := range []struct {
			name        string
			failure     browserRPCFailure
			status      int
			body, retry string
		}{
			{"busy", browserRPCFailure{503, passwordBusyJSON, []string{"1"}}, 503, passwordBusyJSON, "1"},
			{"rate-first", browserRPCFailure{429, passwordRateJSON, []string{"1"}}, 429, passwordRateJSON, "1"},
			{"rate-max", browserRPCFailure{429, passwordRateJSON, []string{"900"}}, 429, passwordRateJSON, "900"},
			{"missing-header", browserRPCFailure{429, passwordRateJSON, nil}, 503, "", ""},
			{"duplicate-header", browserRPCFailure{429, passwordRateJSON, []string{"1", "1"}}, 503, "", ""},
			{"wrong-delay", browserRPCFailure{503, passwordBusyJSON, []string{"2"}}, 503, "", ""},
			{"wrong-status", browserRPCFailure{401, passwordBusyJSON, []string{"1"}}, 503, "", ""},
			{"wrong-code", browserRPCFailure{429, passwordBusyJSON, []string{"1"}}, 503, "", ""},
			{"private-message", browserRPCFailure{503, strings.Replace(passwordBusyJSON, "Password verification is busy", "private-password-canary", 1), []string{"1"}}, 503, "", ""},
			{"duplicate-code", browserRPCFailure{401, strings.TrimSuffix(passwordBusyJSON, "}") + `,"code":"unauthenticated"}`, []string{"1"}}, 503, "", ""},
			{"unknown-member", browserRPCFailure{503, strings.TrimSuffix(passwordBusyJSON, "}") + `,"token":"private-authority"}`, []string{"1"}}, 503, "", ""},
			{"trailing-body", browserRPCFailure{503, passwordBusyJSON + "{}", []string{"1"}}, 503, "", ""},
		} {
			t.Run(route.rpc+"/"+row.name, func(t *testing.T) {
				f := newBrowserControlFixture(t)
				f.mu.Lock()
				f.failures[route.rpc] = row.failure
				f.mu.Unlock()
				w := httptest.NewRecorder()
				f.handler.ServeHTTP(w, f.request(http.MethodPost, route.path, route.body))
				if w.Code != row.status || w.Header().Get("Cache-Control") != "no-store" || len(w.Header().Values("Set-Cookie")) != 0 {
					t.Fatalf("password failure status=%d cache=%q cookies=%d; want status=%d, no-store and no cookies", w.Code, w.Header().Get("Cache-Control"), len(w.Header().Values("Set-Cookie")), row.status)
				}
				retries := w.Header().Values("Retry-After")
				if row.retry == "" && len(retries) != 0 || row.retry != "" && (len(retries) != 1 || retries[0] != row.retry) {
					t.Fatal("retry header was dropped, duplicated or accepted without validation")
				}
				want := row.body
				if want == "" {
					want = `{"code":"identity_unavailable","message":"Identity Service is unavailable"}`
				}
				var gotBody, wantBody map[string]any
				if json.Unmarshal(w.Body.Bytes(), &gotBody) != nil || json.Unmarshal([]byte(want), &wantBody) != nil || len(gotBody) != len(wantBody) {
					t.Fatal("password failure changed public body shape")
				}
				for key, value := range wantBody {
					if gotBody[key] != value {
						t.Fatal("password failure changed public fields")
					}
				}
				calls := 0
				for _, call := range f.calls() {
					if call.Path == route.rpc {
						calls++
					}
					if call.Path != route.rpc && call.Path != "resolve-access-token" {
						t.Fatal("failure performed an unrelated mutation")
					}
				}
				if calls != 1 {
					t.Fatal("Gateway replayed password request")
				}
				w = httptest.NewRecorder()
				f.handler.ServeHTTP(w, f.request(http.MethodGet, "/api/session", ""))
				if w.Code != 200 || len(w.Header().Values("Set-Cookie")) != 0 {
					t.Fatal("existing browser session was lost")
				}
				f.mu.Lock()
				delete(f.failures, route.rpc)
				f.mu.Unlock()
				w = httptest.NewRecorder()
				f.handler.ServeHTTP(w, f.request(http.MethodPost, route.path, route.body))
				if w.Code != 200 || len(w.Header().Values("Set-Cookie")) != 2 {
					t.Fatal("password operation failed to recover")
				}
			})
		}
	}
}

func TestGatewayPasswordAdmissionPreservesRequestGuards(t *testing.T) {
	for _, path := range []string{"/api/session/login", "/api/session/password"} {
		t.Run(path+"/origin", func(t *testing.T) {
			f := newBrowserControlFixture(t)
			r := f.request(http.MethodPost, path, `{"organization_slug":"engineering","email":"member@example.com","password":"password","current_password":"password","new_password":"new-password-123"}`)
			r.Header.Set("Origin", "https://attacker.example")
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, r)
			if w.Code != 403 || len(f.calls()) != 0 {
				t.Fatal("untrusted origin reached Identity")
			}
		})
	}
	f := newBrowserControlFixture(t)
	r := f.request(http.MethodPost, "/api/session/password", `{"current_password":"password","new_password":"new-password-123"}`)
	r.Header.Del(session.CSRFHeaderName)
	w := httptest.NewRecorder()
	f.handler.ServeHTTP(w, r)
	if w.Code != 403 {
		t.Fatal("missing CSRF was accepted")
	}
	for _, call := range f.calls() {
		if call.Path != "resolve-access-token" {
			t.Fatal("missing CSRF reached password mutation")
		}
	}
}

func TestGatewayPasswordAdmissionRejectsMixedSuccess(t *testing.T) {
	for _, route := range []struct{ path, rpc, body string }{
		{"/api/session/login", "local-login", `{"organization_slug":"engineering","email":"member@example.com","password":"private-password-canary"}`},
		{"/api/session/password", "change-local-password", `{"current_password":"private-password-canary","new_password":"new-password-123"}`},
	} {
		t.Run(route.rpc, func(t *testing.T) {
			f := newBrowserControlFixture(t)
			payload, err := json.Marshal(map[string]any{
				"status": "changed", "principal": f.principal, "access_token": "new-private-token", "token_id": "token-2",
				"expires_at": f.principal.ExpiresAt, "idle_expires_at": f.principal.IdleExpiresAt, "activity_interval_ms": 30000,
				"code": "credential_busy", "message": "Password verification is busy", "retryable": true,
			})
			if err != nil {
				t.Fatal(err)
			}
			f.mu.Lock()
			f.failures[route.rpc] = browserRPCFailure{200, string(payload), []string{"1"}}
			f.mu.Unlock()
			w := httptest.NewRecorder()
			f.handler.ServeHTTP(w, f.request(http.MethodPost, route.path, route.body))
			if w.Code != 503 || w.Header().Get("Retry-After") != "" || w.Header().Get("Cache-Control") != "no-store" || len(w.Header().Values("Set-Cookie")) != 0 || strings.Contains(w.Body.String(), "new-private-token") {
				t.Fatal("mixed success returned credentials or retry metadata")
			}
		})
	}
}
