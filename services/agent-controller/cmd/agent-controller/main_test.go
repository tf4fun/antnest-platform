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
	if err := checkHealthWithClient(func(key string) string {
		if key == "ANTNEST_AGENT_CONTROLLER_LISTEN" {
			return ":18080"
		}
		return ""
	}, client); err != nil {
		t.Fatalf("healthcheck: %v", err)
	}
	if requestedURL != "http://127.0.0.1:18080/status" {
		t.Fatalf("healthcheck URL = %q", requestedURL)
	}
}

func TestLifecycleRecoveryWorkerIDIsReplicaLocalAndStable(t *testing.T) {
	t.Parallel()

	workerID, err := lifecycleRecoveryWorkerID(" agent-controller-a ", 17)
	if err != nil {
		t.Fatalf("worker ID: %v", err)
	}
	if workerID != "agent-controller-a:17" {
		t.Fatalf("worker ID = %q", workerID)
	}
	for _, input := range []struct {
		hostname string
		pid      int
	}{
		{hostname: "", pid: 17},
		{hostname: "agent-controller-a", pid: 0},
	} {
		if _, err := lifecycleRecoveryWorkerID(input.hostname, input.pid); err == nil {
			t.Fatalf("invalid worker identity was accepted: %+v", input)
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}
