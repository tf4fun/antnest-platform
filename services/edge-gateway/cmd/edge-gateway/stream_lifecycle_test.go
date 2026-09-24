package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWebSocketStopWaitsForHandlerButPreservesHTTPDrain(t *testing.T) {
	for _, failListener := range []bool{false, true} {
		t.Run(map[bool]string{false: "signal", true: "serve_error"}[failListener], func(t *testing.T) {
			testWebSocketShutdown(t, failListener)
		})
	}
}

func testWebSocketShutdown(t *testing.T, failListener bool) {
	t.Helper()
	started := make(chan context.Context, 2)
	release := make(chan struct{})
	handlersDone := make(chan struct{}, 2)
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		started <- request.Context()
		<-release
		handlersDone <- struct{}{}
	}), nil)
	httpRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	wsRequest := httpRequest.Clone(context.Background())
	wsRequest.Header.Set("Connection", "Upgrade")
	wsRequest.Header.Set("Upgrade", "websocket")
	go lifecycle.ServeHTTP(httptest.NewRecorder(), httpRequest)
	httpContext := <-started
	go lifecycle.ServeHTTP(httptest.NewRecorder(), wsRequest)
	wsContext := <-started
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		close(release)
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	server := &http.Server{Handler: lifecycle, ReadHeaderTimeout: time.Second}
	finished := make(chan error, 1)
	go func() { finished <- serveHTTP(ctx, server, listener, lifecycle, 3*time.Second) }()
	if failListener {
		_ = listener.Close()
	} else {
		cancel()
	}
	select {
	case <-wsContext.Done():
	case <-time.After(time.Second):
		close(release)
		t.Fatal("WebSocket context was not cancelled")
	}
	if httpContext.Err() != nil {
		t.Error("ordinary HTTP drain was cancelled")
	}
	select {
	case <-finished:
		t.Error("server returned before hijacked handler and its telemetry completed")
	default:
	}
	rejected := httptest.NewRecorder()
	lifecycle.ServeHTTP(rejected, wsRequest)
	if rejected.Code != http.StatusServiceUnavailable {
		t.Errorf("new upgrade during shutdown: %d", rejected.Code)
	}
	close(release)
	<-handlersDone
	<-handlersDone
	select {
	case err := <-finished:
		if (err != nil) != failListener {
			t.Errorf("serve result=%v; listener failure=%v", err, failListener)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("server did not finish after handlers returned")
	}
}

func TestWebSocketDrainDeadlineAndRepeatedStop(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(started)
		<-release
	}), nil)
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	go lifecycle.ServeHTTP(httptest.NewRecorder(), request)
	<-started
	lifecycle.stop()
	lifecycle.stop()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lifecycle.wait(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("drain result=%v", err)
	}
	close(release)
	deadline, done := context.WithTimeout(context.Background(), time.Second)
	defer done()
	if err := lifecycle.wait(deadline); err != nil {
		t.Fatal(err)
	}
}

func TestManagedReceiveRoutes(t *testing.T) {
	for _, path := range []string{
		"/api/app/agents/agent-1/state/watch",
		"/api/app/agents/agent%2F1/state/watch",
		"/%61pi/app/agents/agent%2F1/state/watch",
		"/api/app/agents/agent%2F1/v1/acp",
		"/api/app/agents/agent-1/v1/acp",
		"/api/app/agents/agent-1/acp",
		"/api/admin/agents/agent-1/events/watch",
		"/api/app/workspace/v1/agents/agent-1/events",
		"/api/app/workspace/v1/agents/agent%2F1/events",
	} {
		t.Run(path, func(t *testing.T) {
			for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete, http.MethodHead} {
				request := httptest.NewRequest(method, path, nil)
				if managedStream(request) != (method == http.MethodGet) {
					t.Errorf("incorrect stream ownership for %s %s", method, path)
				}
			}
		})
	}
	for _, path := range []string{
		"/", "/status", "/api/admin/overview", "/api/app/agents/agent-1/state",
		"/api/app/agents/agent-1/v2/acp", "/api/app/agents/agent-1/v3/acp",
		"/api/admin/agents/agent-1/events", "/api/app/agents/agent-1/v1/acp/extra",
		"/api/app/workspace/v1/agents/agent-1/events/extra",
	} {
		if managedStream(httptest.NewRequest(http.MethodGet, path, nil)) {
			t.Errorf("ordinary HTTP must retain graceful drain: %s", path)
		}
	}
}
