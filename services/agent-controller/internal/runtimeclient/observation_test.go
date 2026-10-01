package runtimeclient

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestListRuntimeObservationsProjectsOrderedControllerJournal(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/internal/runtime-observations" ||
			request.URL.Query().Get("after_sequence") != "4" || request.URL.Query().Get("limit") != "500" {
			t.Fatalf("request=%s", request.URL.String())
		}
		_, _ = response.Write([]byte(`{
			"observations":[{"sequence":5,"agent_id":"agent-1",
			"runtime_revision":"rtv_11111111111111111111111111111111",
			"kind":"restarted","observed_at":"2026-09-02T00:00:00Z"}],
			"oldest_sequence":1,"latest_sequence":5,"next_sequence":5}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	page, err := client.ListRuntimeObservations(context.Background(), 4, 500)
	if err != nil {
		t.Fatalf("ListRuntimeObservations: %v", err)
	}
	if page.NextSequence != 5 || len(page.Observations) != 1 ||
		page.Observations[0].Kind != ports.RuntimeObservationRestarted {
		t.Fatalf("page=%#v", page)
	}
}

func TestListRuntimeObservationsReturnsTypedExpiredCursor(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusGone)
		_, _ = response.Write([]byte(`{"code":"observation_cursor_expired","retryable":false,"reset_sequence":42}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	_, err = client.ListRuntimeObservations(context.Background(), 3, 500)
	var expired *ports.RuntimeObservationCursorExpiredError
	if !errors.As(err, &expired) || expired.ResetSequence != 42 {
		t.Fatalf("error=%#v", err)
	}
}

func TestListRuntimesRejectsInvalidRuntimeProjection(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte(`{"runtimes":[{
			"agent_id":"agent-1","runtime_revision":"not-a-revision",
			"lifecycle_state":"provisioned","health":"healthy",
			"runtime_execution_id":"execution-1","mcp_endpoint":"http://runtime:8091/mcp"
		}]}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, err := client.ListRuntimes(context.Background()); err == nil {
		t.Fatal("invalid Runtime projection was accepted")
	}
}
