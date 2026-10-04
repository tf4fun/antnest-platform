package main

import (
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestServiceFailureClassIsStableAndBounded(t *testing.T) {
	t.Parallel()

	cause := errors.New("connect postgres://user:secret@example.test/controller")
	err := classifyFailure("database_migration", cause)
	if got := serviceFailureClass(err); got != "database_migration" {
		t.Fatalf("service failure class = %q", got)
	}
	if got := serviceFailureClass(cause); got != "service_failure" {
		t.Fatalf("unclassified failure class = %q", got)
	}
	if detail := serviceFailureDetail(err); detail != "" {
		t.Fatalf("database failure leaked detail %q", detail)
	}
	telemetryErr := classifyFailure("telemetry_startup", errors.New("unsupported OTLP protocol"))
	if detail := serviceFailureDetail(telemetryErr); detail != "unsupported OTLP protocol" {
		t.Fatalf("telemetry failure detail = %q", detail)
	}
}

func TestHealthcheckUsesConfiguredPort(t *testing.T) {
	t.Parallel()

	var requestedURL string
	client := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requestedURL = request.URL.String()
		return &http.Response{
			StatusCode: http.StatusOK, Status: "200 OK",
			Body: io.NopCloser(strings.NewReader("ready")), Header: make(http.Header),
		}, nil
	})}
	if err := checkHealthWithClient(func(key string) (string, bool) {
		if key == "ANTNEST_AGENT_CONTROLLER_LISTEN" {
			return ":18080", true
		}
		return "", false
	}, client); err != nil {
		t.Fatalf("healthcheck: %v", err)
	}
	if requestedURL != "http://127.0.0.1:18080/status" {
		t.Fatalf("healthcheck URL = %q", requestedURL)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestHealthProbeAddress(t *testing.T) {
	for _, fixture := range []struct{ input, expected string }{
		{"", "127.0.0.1:8080"},
		{":8123", "127.0.0.1:8123"},
		{"0.0.0.0:8123", "127.0.0.1:8123"},
		{"[::]:8123", "127.0.0.1:8123"},
		{" 127.0.0.2:8123 ", "127.0.0.2:8123"},
		{"10.241.255.50:8080", "10.241.255.50:8080"},
		{"[::1]:8123", "[::1]:8123"},
		{"[fd00::5]:8123", "[fd00::5]:8123"},
		{"agent-controller:8080", "agent-controller:8080"},
	} {
		t.Run(fixture.input, func(t *testing.T) {
			actual, err := healthProbeAddress(fixture.input)
			if err != nil || actual != fixture.expected {
				t.Fatalf("address = %q, error = %v; want %q", actual, err, fixture.expected)
			}
		})
	}
	for _, input := range []string{"127.0.0.1", "::1:8080", "[::1]"} {
		if _, err := healthProbeAddress(input); err == nil {
			t.Fatalf("malformed address %q was accepted", input)
		}
	}
}
