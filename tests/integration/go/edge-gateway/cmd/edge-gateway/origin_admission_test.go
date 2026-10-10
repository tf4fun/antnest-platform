package main

import (
	"context"
	"crypto/rand"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
)

func TestRunEnforcesOriginAdmissionConfiguration(t *testing.T) {
	t.Setenv("OTEL_SDK_DISABLED", "true")
	previousPropagation := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(previousPropagation) })
	for _, setting := range []string{"", "false", "true"} {
		t.Run("originless="+setting, func(t *testing.T) {
			directory := t.TempDir()
			values := map[string]string{
				"ANTNEST_EDGE_PUBLIC_ORIGIN":                    "https://antnest.example",
				"ANTNEST_EDGE_TRUSTED_PROXIES":                  "127.0.0.1/32",
				"ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS":       setting,
				"ANTNEST_SERVICE_AUTH_MODE":                     "token",
				"ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
				"ANTNEST_SERVICE_AUTH_CALLERS_FILE":             filepath.Join(directory, "callers.json"),
				"ANTNEST_SERVICE_AUTH_TOKEN_DIR":                directory,
			}
			if err := os.WriteFile(values["ANTNEST_SERVICE_AUTH_CALLERS_FILE"], []byte("{}"), 0600); err != nil {
				t.Fatal(err)
			}
			for variable, service := range map[string]string{
				"ANTNEST_IDENTITY_SERVICE_URL": "identity-service", "ANTNEST_ADMIN_CONSOLE_URL": "admin-console",
				"ANTNEST_AGENT_UI_URL": "agent-ui", "ANTNEST_AGENT_CONTROLLER_URL": "agent-controller", "ANTNEST_AGENT_ACP_URL": "agent-acp-service",
			} {
				values[variable] = "http://" + service + ":8080"
				token := make([]byte, 32)
				if _, err := rand.Read(token); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(directory, service), []byte(fmt.Sprintf("%x", token)), 0600); err != nil {
					t.Fatal(err)
				}
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			values["ANTNEST_EDGE_LISTEN"] = listener.Addr().String()
			if err := listener.Close(); err != nil {
				t.Fatal(err)
			}
			logPath := filepath.Join(directory, "startup.log")
			logFile, err := os.Create(logPath)
			if err != nil {
				t.Fatal(err)
			}
			previousStdout := os.Stdout
			os.Stdout = logFile
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan struct{})
			var runErr error
			go func() {
				defer close(done)
				runErr = run(ctx, func(name string) (string, bool) { value, present := values[name]; return value, present })
			}()
			stop := func() {
				cancel()
				select {
				case <-done:
					if runErr != nil {
						t.Errorf("Gateway run: %v", runErr)
					}
				case <-time.After(5 * time.Second):
					t.Error("Gateway did not stop")
				}
			}
			t.Cleanup(func() { stop(); os.Stdout = previousStdout; _ = logFile.Close() })
			deadline := time.Now().Add(5 * time.Second)
			for {
				select {
				case <-done:
					t.Fatalf("Gateway stopped: %v", runErr)
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
			client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
			t.Cleanup(client.CloseIdleConnections)
			for _, evidence := range []struct {
				origin, metadata string
				admitted         bool
			}{
				{"", "", setting == "true"},
				{"https://antnest.example", "", true},
				{"", "same-origin", true},
				{"https://antnest.example", "cross-site", false},
				{"http://" + values["ANTNEST_EDGE_LISTEN"], "", false},
				{"null", "same-origin", false},
				{"", "none", false},
			} {
				request, err := http.NewRequest("POST", "http://"+values["ANTNEST_EDGE_LISTEN"]+"/api/session/login-methods", strings.NewReader(`{}`))
				if err != nil {
					t.Fatal(err)
				}
				request.Header.Set("Content-Type", "application/json")
				if evidence.origin != "" {
					request.Header.Set("Origin", evidence.origin)
				}
				if evidence.metadata != "" {
					request.Header.Set("Sec-Fetch-Site", evidence.metadata)
				}
				response, err := client.Do(request)
				if err != nil {
					t.Fatal(err)
				}
				body, readErr := io.ReadAll(response.Body)
				closeErr := response.Body.Close()
				if readErr != nil || closeErr != nil {
					t.Fatalf("response: read=%v close=%v", readErr, closeErr)
				}
				status, code := 403, "forbidden"
				if evidence.admitted {
					status, code = 400, "invalid_request"
				}
				if response.StatusCode != status || !strings.Contains(string(body), `"code":"`+code+`"`) {
					t.Errorf("Origin=%q metadata=%q: status=%d body=%s", evidence.origin, evidence.metadata, response.StatusCode, body)
				}
				if response.Header.Get("Strict-Transport-Security") != "max-age=31536000" || response.Header.Get("X-Content-Type-Options") != "nosniff" {
					t.Error("admission response lost security headers")
				}
			}
			stop()
			logs, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			warned := strings.Contains(string(logs), `"level":"WARN"`) && strings.Contains(string(logs), "ANTNEST_EDGE_ALLOW_ORIGINLESS_MUTATIONS")
			if warned != (setting == "true") {
				t.Errorf("originless startup warning=%v", warned)
			}
		})
	}
}
