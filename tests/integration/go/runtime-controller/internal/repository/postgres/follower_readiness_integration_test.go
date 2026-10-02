package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/control"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/observation"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform/monitor"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/rpc"
)

func TestRepositoryFollowerHTTPReadinessMirrorsLeaderWatchLease(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	leader, acquired, err := repository.TryAcquireObservationLeadership(ctx)
	if err != nil || !acquired {
		t.Fatalf("acquire fixture leader: acquired=%t err=%v", acquired, err)
	}
	t.Cleanup(func() { _ = leader.Release(context.Background()) })
	if err := leader.MarkObservationReady(ctx); err != nil {
		t.Fatal(err)
	}
	health := &observation.Health{}
	health.MarkJournal(true)
	health.MarkNotifications(true)
	service, err := control.NewService(repository, repository, health, followerReadinessPlatform{},
		followerReadinessVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	handler, err := rpc.NewHandler(service, observation.NewHub(), time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	runner, err := monitor.New(followerReadinessSource{}, &retryMonitorSink{repository: repository}, health,
		slog.New(slog.NewTextHandler(io.Discard, nil)), time.Second, time.Second, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	followerCtx, cancel := context.WithCancel(ctx)
	done := make(chan error, 1)
	go func() { done <- runner.RunCoordinated(followerCtx, repository, func() {}) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("follower shutdown: %v", err)
			}
		case <-time.After(time.Second):
			t.Error("follower goroutine did not stop")
		}
	})
	client := &http.Client{Timeout: time.Second}
	check := func(expected int) {
		t.Helper()
		// Allow several one-second polls and scheduling/HTTP overhead on slow CI.
		deadline := time.Now().Add(5 * time.Second)
		for {
			response, err := client.Get(server.URL + "/status")
			if err != nil {
				t.Fatal(err)
			}
			var body struct {
				Ready            bool `json:"ready"`
				MonitorReady     bool `json:"monitor_ready"`
				ObservationReady bool `json:"observation_ready"`
			}
			err = json.NewDecoder(response.Body).Decode(&body)
			_ = response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			wantReady := expected == http.StatusOK
			if response.StatusCode == expected && body.Ready == wantReady && body.MonitorReady == wantReady && body.ObservationReady {
				return
			}
			if time.Now().After(deadline) {
				t.Fatalf("follower did not reflect its leader before the readiness timeout: HTTP %d %+v", response.StatusCode, body)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}
	check(http.StatusOK)
	if err := leader.MarkObservationUnready(ctx); err != nil {
		t.Fatal(err)
	}
	check(http.StatusServiceUnavailable)
	if err := leader.MarkObservationReady(ctx); err != nil {
		t.Fatal(err)
	}
	check(http.StatusOK)
}

type followerReadinessPlatform struct{ platform.Lifecycle }
type followerReadinessVerifier struct{ control.RuntimeVerifier }
type followerReadinessSource struct{ platform.ObservationSource }

func (followerReadinessPlatform) Ready(context.Context) error { panic("status must not probe Docker") }
func (followerReadinessSource) List(context.Context) ([]deployment.Inspection, error) {
	return nil, &monitor.PermanentError{Err: errors.New("follower unexpectedly became inventory leader")}
}
