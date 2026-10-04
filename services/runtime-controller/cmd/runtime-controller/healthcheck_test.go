package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthcheckUsesLocalHealthPortWithoutApplicationCredentials(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.URL.Path != "/status" || r.Header.Get("Antnest-Service-Authorization") != "" {
			t.Error("healthcheck crossed application boundary")
		}
		w.WriteHeader(200)
	}))
	defer server.Close()
	env := map[string]string{"ANTNEST_RUNTIME_CONTROLLER_LISTEN": "127.0.0.1:1", "ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN": strings.TrimPrefix(server.URL, "http://"), "ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true"}
	if err := checkHealth(func(key string) (string, bool) { value, present := env[key]; return value, present }); err != nil || calls != 1 {
		t.Fatalf("local health failed: %v calls=%d", err, calls)
	}
	env["ANTNEST_RUNTIME_CONTROLLER_HEALTH_LISTEN"] = "198.51.100.1:8082"
	if err := checkHealth(func(key string) (string, bool) { value, present := env[key]; return value, present }); err == nil {
		t.Fatal("healthcheck accepted nonlocal destination")
	}
}
