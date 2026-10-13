package main

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"go.opentelemetry.io/otel"
)

func TestRunAppliesConfiguredLoginTableAndOIDCSourceLimits(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	previousPropagation := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(previousPropagation) })
	var passwordCalls, oidcCalls atomic.Int32
	identity := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/rpc/identity/local-login":
			passwordCalls.Add(1)
			response.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(response, `{"code":"unauthenticated","message":"Invalid credentials"}`)
		case "/rpc/identity/start-oidc-login":
			oidcCalls.Add(1)
			_ = json.NewEncoder(response).Encode(map[string]any{
				"authorization_url": "https://provider.example/authorize?state=opaque",
				"expires_at":        time.Now().Add(time.Minute),
			})
		default:
			// This fixture owns only login RPCs, not Identity's background feed.
			response.WriteHeader(http.StatusServiceUnavailable)
			_, _ = io.WriteString(response, `{"code":"unavailable","message":"Fixture does not serve this route"}`)
		}
	}))
	t.Cleanup(identity.Close)
	directory := t.TempDir()
	values := map[string]string{
		"ANTNEST_EDGE_CSRF_KEY_FILE":                    filepath.Join(directory, "csrf.key"),
		"ANTNEST_EDGE_PUBLIC_ORIGIN":                    "https://antnest.example",
		"ANTNEST_EDGE_TRUSTED_PROXIES":                  "127.0.0.1/32",
		"ANTNEST_EDGE_LOGIN_WINDOW":                     "17s",
		"ANTNEST_EDGE_LOGIN_SOURCE_MAX":                 "1",
		"ANTNEST_EDGE_LOGIN_ACCOUNT_MAX":                "1",
		"ANTNEST_EDGE_LOGIN_MAX_KEYS":                   "1",
		"ANTNEST_EDGE_OIDC_START_SOURCE_MAX":            "2",
		"ANTNEST_EDGE_RESOLVE_CACHE_TTL":                "0",
		"ANTNEST_SERVICE_AUTH_MODE":                     "token",
		"ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_CALLERS_FILE":             filepath.Join(directory, "callers.json"),
		"ANTNEST_SERVICE_AUTH_TOKEN_DIR":                directory,
	}
	for name, contents := range map[string]string{
		"csrf.key": "0123456789abcdef0123456789abcdef", "callers.json": "{}",
	} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for variable, service := range map[string]string{
		"ANTNEST_IDENTITY_SERVICE_URL": "identity-service",
		"ANTNEST_ADMIN_CONSOLE_URL":    "admin-console",
		"ANTNEST_AGENT_UI_URL":         "agent-ui",
		"ANTNEST_AGENT_CONTROLLER_URL": "agent-controller",
		"ANTNEST_AGENT_ACP_URL":        "agent-acp-service",
	} {
		values[variable] = "http://" + service + ":8080"
		if service == "identity-service" {
			values[variable] = identity.URL
		}
		if err := os.WriteFile(filepath.Join(directory, service), []byte(strings.Repeat("a", 64)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	reservation, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	values["ANTNEST_EDGE_LISTEN"] = reservation.Addr().String()
	if err := reservation.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	var runErr error
	go func() {
		defer close(done)
		runErr = run(ctx, func(name string) (string, bool) { value, present := values[name]; return value, present })
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("Gateway did not stop")
			identity.CloseClientConnections()
			// Preserve the timeout failure, but join run before t.TempDir
			// removes credentials or the dependency fixture is closed.
			<-done
		}
		if runErr != nil {
			t.Errorf("Gateway run failed: %v", runErr)
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for {
		select {
		case <-done:
			t.Fatalf("Gateway stopped before readiness: %v", runErr)
		default:
		}
		if err := checkHealth(func(name string) string { return values[name] }); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("Gateway did not become healthy")
		}
		time.Sleep(time.Millisecond)
	}
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil}}
	t.Cleanup(client.CloseIdleConnections)
	send := func(path, source, body string, status int) {
		t.Helper()
		request, err := http.NewRequest(http.MethodPost, "http://"+values["ANTNEST_EDGE_LISTEN"]+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Origin", "https://antnest.example")
		request.Header.Set("X-Forwarded-For", source)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		payload, readErr := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if readErr != nil || closeErr != nil {
			t.Fatalf("response read=%v close=%v", readErr, closeErr)
		}
		if response.StatusCode != status || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("status=%d want=%d, or cache boundary changed", response.StatusCode, status)
		}
		if status == http.StatusOK {
			cookies := response.Cookies()
			if len(response.Header.Values("Set-Cookie")) != 1 || len(cookies) != 1 {
				t.Fatal("OIDC start must write exactly its browser binding Cookie")
			}
			cookie := cookies[0]
			if cookie.Name != "__Host-"+session.OIDCCookieName || cookie.Value == "" ||
				!cookie.Secure || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode ||
				cookie.Path != "/" || cookie.Domain != "" || !cookie.Expires.After(time.Now()) {
				t.Fatal("OIDC start lost its secure browser binding Cookie")
			}
		} else if len(response.Header.Values("Set-Cookie")) != 0 {
			t.Fatal("password or admission refusal wrote a Cookie")
		}
		if status == http.StatusTooManyRequests {
			retry := response.Header.Values("Retry-After")
			if len(retry) != 1 || retry[0] != "17" ||
				strings.TrimSpace(string(payload)) != `{"code":"login_rate_limited","message":"Too many login attempts"}` {
				t.Fatal("configured window did not produce the canonical edge refusal")
			}
		}
	}
	// With capacity one, A/B/A must reopen A. An unwired capacity default
	// would retain A and reject its third request at the source limit.
	for _, source := range []string{"192.0.2.1", "192.0.2.2", "192.0.2.1"} {
		send("/api/session/login", source,
			`{"organization_slug":"engineering","email":"`+source+`","password":"wrong"}`, http.StatusUnauthorized)
	}
	oidcBody := `{"organization_slug":"engineering","provider_name":"workforce"}`
	send("/api/session/oidc/start", "192.0.2.1", oidcBody, http.StatusOK)
	send("/api/session/oidc/start", "192.0.2.1", oidcBody, http.StatusOK)
	send("/api/session/oidc/start", "192.0.2.1", oidcBody, http.StatusTooManyRequests)
	send("/api/session/oidc/start", "192.0.2.2", oidcBody, http.StatusOK)
	if passwordCalls.Load() != 3 || oidcCalls.Load() != 3 {
		t.Fatalf("Identity password/OIDC calls=%d/%d want=3/3", passwordCalls.Load(), oidcCalls.Load())
	}
}
