package main

import (
	"errors"
	"net"
	"net/http"
	"testing"
)

func TestServiceFailureClassIsStableAndBounded(t *testing.T) {
	secretBearingCause := errors.New("connect postgres://user:secret@example.test/identity")
	err := classifyFailure("database_migration", secretBearingCause)
	if got := serviceFailureClass(err); got != "database_migration" {
		t.Fatalf("service failure class = %q", got)
	}
	if got := serviceFailureClass(errors.Join(errors.New("other"), err)); got != "database_migration" {
		t.Fatalf("joined service failure class = %q", got)
	}
	if got := serviceFailureClass(secretBearingCause); got != "service_failure" {
		t.Fatalf("unclassified service failure class = %q", got)
	}
}

func TestHealthcheckUsesConfiguredPort(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/status" {
			http.NotFound(response, request)
			return
		}
		response.WriteHeader(http.StatusOK)
	})}
	done := make(chan struct{})
	go func() {
		_ = server.Serve(listener)
		close(done)
	}()
	t.Cleanup(func() {
		_ = server.Close()
		<-done
	})
	if err := checkHealth(func(key string) (string, bool) {
		if key == "ANTNEST_IDENTITY_LISTEN" {
			return listener.Addr().String(), true
		}
		if key == "ANTNEST_SERVICE_AUTH_MODE" {
			return "token", true
		}
		if key == "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT" {
			return "true", true
		}
		return "", false
	}); err != nil {
		t.Fatalf("healthcheck: %v", err)
	}
}
