package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
)

const oidcAdmissionBody = `{"organization_slug":"engineering","provider_name":"workforce"}`

func loginAdmissionRequest(handler http.Handler, path, source, body string) *httptest.ResponseRecorder {
	request := newBrowserRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.RemoteAddr = source
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func assertLoginAdmissionRefusal(t *testing.T, response *httptest.ResponseRecorder, retryAfter string) {
	t.Helper()
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusTooManyRequests ||
		!reflect.DeepEqual(body, map[string]any{"code": "login_rate_limited", "message": "Too many login attempts"}) ||
		response.Header().Get("Cache-Control") != "no-store" ||
		!reflect.DeepEqual(response.Header().Values("Retry-After"), []string{retryAfter}) ||
		len(response.Header().Values("Set-Cookie")) != 0 {
		t.Fatalf("admission refusal status=%d headers=%v body=%v", response.Code, response.Header(), body)
	}
}

func newOIDCAdmissionStub() *identityServiceStub {
	return &identityServiceStub{startOIDCResult: identity.StartOIDCLoginResult{
		AuthorizationURL: "https://id.example.test/authorize?state=opaque-state",
		ExpiresAt:        time.Now().Add(time.Minute),
	}}
}

func TestLoginFlowsDoNotConsumeEachOthersBudgets(t *testing.T) {
	for _, fixture := range []struct {
		name, email           string
		sourceMax, accountMax int
	}{
		{"source isolation", "alice@example.com", 1, 100},
		{"account namespace", "oidc:workforce", 100, 1},
	} {
		for _, passwordFirst := range []bool{true, false} {
			name := fixture.name + "/oidc first"
			if passwordFirst {
				name = fixture.name + "/password first"
			}
			t.Run(name, func(t *testing.T) {
				stub := newOIDCAdmissionStub()
				handler := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{
					LoginSourceMax: fixture.sourceMax, LoginAccountMax: fixture.accountMax,
				})
				passwordBody := `{"organization_slug":"engineering","email":"` + fixture.email + `","password":"wrong"}`
				for _, password := range []bool{passwordFirst, !passwordFirst} {
					path, body, want := "/api/session/oidc/start", oidcAdmissionBody, http.StatusOK
					if password {
						path, body, want = "/api/session/login", passwordBody, http.StatusUnauthorized
					}
					response := loginAdmissionRequest(handler, path, "192.0.2.20:1234", body)
					if response.Code != want {
						t.Errorf("%s status=%d want=%d", path, response.Code, want)
					}
				}
				if stub.loginCalls != 1 || stub.startOIDCCalls != 1 {
					t.Fatalf("Identity password/OIDC calls=%d/%d want=1/1", stub.loginCalls, stub.startOIDCCalls)
				}
			})
		}
	}
}

func TestOIDCSourceLimitDoesNotBlockAnotherSource(t *testing.T) {
	stub := newOIDCAdmissionStub()
	handler := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{LoginWindow: time.Minute})
	for attempt := 1; attempt <= 31; attempt++ {
		response := loginAdmissionRequest(handler, "/api/session/oidc/start", "192.0.2.20:1234", oidcAdmissionBody)
		if attempt <= 30 {
			if response.Code != http.StatusOK {
				t.Errorf("OIDC start %d status=%d want=200", attempt, response.Code)
			}
		} else {
			assertLoginAdmissionRefusal(t, response, "60")
		}
	}
	response := loginAdmissionRequest(handler, "/api/session/oidc/start", "192.0.2.21:1234", oidcAdmissionBody)
	if response.Code != http.StatusOK || stub.startOIDCCalls != 31 {
		t.Fatalf("source B status=%d Identity OIDC calls=%d want=200/31", response.Code, stub.startOIDCCalls)
	}
}

func TestLoginAdmissionRetryAfterCoversTheWholeWindow(t *testing.T) {
	for _, window := range []time.Duration{time.Nanosecond, 100 * time.Millisecond, time.Second + time.Nanosecond} {
		t.Run(window.String(), func(t *testing.T) {
			stub := &identityServiceStub{}
			handler := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{
				LoginWindow: window, LoginSourceMax: 1, LoginAccountMax: 1,
			})
			body := `{"organization_slug":"engineering","email":"alice@example.com","password":"wrong"}`
			if response := loginAdmissionRequest(handler, "/api/session/login", "192.0.2.20:1234", body); response.Code != http.StatusUnauthorized {
				t.Fatalf("first login status=%d", response.Code)
			}
			want := "1"
			if window > time.Second {
				want = "2"
			}
			assertLoginAdmissionRefusal(t, loginAdmissionRequest(handler, "/api/session/login", "192.0.2.20:1234", body), want)
			if stub.loginCalls != 1 {
				t.Fatalf("Identity password calls=%d want=1", stub.loginCalls)
			}
		})
	}
}

func TestLoginAdmissionHandlerUsesConfiguredCapacityAndOIDCBudget(t *testing.T) {
	stub := newOIDCAdmissionStub()
	handler := newTestHandlerWithConfig(t, stub, http.NotFoundHandler(), time.Now(), Config{
		LoginWindow: time.Minute, LoginSourceMax: 1, LoginAccountMax: 1,
		LoginMaxKeys: 1, OIDCStartSourceMax: 2,
	})
	for _, body := range []string{
		`{"organization_slug":"engineering","email":"one@example.com","password":"wrong"}`,
		`{"organization_slug":"engineering","email":"two@example.com","password":"wrong"}`,
	} {
		source := "192.0.2.1:1234"
		if strings.Contains(body, "two@example.com") {
			source = "192.0.2.2:1234"
		}
		response := loginAdmissionRequest(handler, "/api/session/login", source, body)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("capacity must evict and admit new password key: status=%d", response.Code)
		}
	}
	if response := loginAdmissionRequest(handler, "/api/session/login", "192.0.2.1:1234", `{"organization_slug":"engineering","email":"one@example.com","password":"wrong"}`); response.Code != http.StatusUnauthorized {
		t.Fatalf("configured capacity did not evict oldest key: status=%d", response.Code)
	}
	for attempt := 1; attempt <= 3; attempt++ {
		response := loginAdmissionRequest(handler, "/api/session/oidc/start", "192.0.2.1:1234", oidcAdmissionBody)
		if attempt <= 2 {
			if response.Code != http.StatusOK {
				t.Fatalf("OIDC start %d status=%d", attempt, response.Code)
			}
		} else {
			assertLoginAdmissionRefusal(t, response, "60")
		}
	}
	if stub.loginCalls != 3 || stub.startOIDCCalls != 2 {
		t.Fatalf("configured calls password/OIDC=%d/%d want=3/2", stub.loginCalls, stub.startOIDCCalls)
	}
}

func TestLoginAdmissionConstructorZeroSelectsDefaults(t *testing.T) {
	h := newTestHandlerWithConfig(t, newOIDCAdmissionStub(), http.NotFoundHandler(), time.Now(), Config{})
	admission := h.(*handler).loginAdmission
	if admission.maxKeys != 65536 || admission.oidcSourceLimit != 30 {
		t.Fatalf("constructor defaults keys/OIDC=%d/%d", admission.maxKeys, admission.oidcSourceLimit)
	}
}
