package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestBridgeStopWaitsForStreamCleanupAndCommandDrain(t *testing.T) {
	for _, failListener := range []bool{false, true} {
		t.Run(map[bool]string{false: "signal", true: "serve_error"}[failListener], func(t *testing.T) {
			testBridgeShutdown(t, failListener)
		})
	}
}

func testBridgeShutdown(t *testing.T, failListener bool) {
	t.Helper()
	started := make(chan context.Context, 2)
	streamRelease, commandRelease := make(chan struct{}), make(chan struct{})
	var releaseStream, releaseCommand sync.Once
	handlersDone := make(chan struct{}, 2)
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		started <- request.Context()
		if request.Method == http.MethodGet {
			<-streamRelease
		} else {
			<-commandRelease
		}
		handlersDone <- struct{}{}
	}), nil)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()
	commandRequest := httptest.NewRequest(http.MethodPost, "/api/app/workspace/v1/agents/agent-1/commands", nil)
	streamRequest := httptest.NewRequest(http.MethodGet, "/api/app/workspace/v1/agents/agent-1/events", nil)
	var handlers sync.WaitGroup
	start := func(request *http.Request) {
		handlers.Add(1)
		go func() { defer handlers.Done(); lifecycle.ServeHTTP(httptest.NewRecorder(), request) }()
	}
	start(commandRequest)
	commandContext := <-started
	start(streamRequest)
	streamContext := <-started
	ctx, cancel := context.WithCancel(context.Background())
	server := &http.Server{Handler: lifecycle, ReadHeaderTimeout: time.Second}
	finished := make(chan error, 1)
	serverDone := make(chan struct{})
	go func() {
		defer close(serverDone)
		finished <- serveHTTP(ctx, server, listener, lifecycle, 3*time.Second)
	}()
	defer func() {
		cancel()
		releaseStream.Do(func() { close(streamRelease) })
		releaseCommand.Do(func() { close(commandRelease) })
		_ = server.Close()
		handlers.Wait()
		<-serverDone
	}()
	if failListener {
		_ = listener.Close()
	} else {
		cancel()
	}
	select {
	case <-streamContext.Done():
	case <-time.After(time.Second):
		t.Fatal("Bridge stream context was not cancelled")
	}
	if commandContext.Err() != nil {
		t.Error("accepted Bridge command drain was cancelled")
	}
	select {
	case <-finished:
		t.Error("server returned before stream cleanup and telemetry completed")
	default:
	}
	for _, request := range []*http.Request{streamRequest, commandRequest} {
		rejected := httptest.NewRecorder()
		lifecycle.ServeHTTP(rejected, request)
		if rejected.Code != http.StatusServiceUnavailable {
			t.Errorf("new %s during shutdown: %d", request.Method, rejected.Code)
		}
	}
	releaseStream.Do(func() { close(streamRelease) })
	<-handlersDone
	select {
	case <-finished:
		t.Error("server returned while an accepted command remained held")
	default:
	}
	if commandContext.Err() != nil {
		t.Error("stream cleanup cancelled an accepted Bridge command")
	}
	releaseCommand.Do(func() { close(commandRelease) })
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

func TestBridgeDrainDeadlineAndRepeatedStop(t *testing.T) {
	started, release := make(chan struct{}), make(chan struct{})
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		close(started)
		<-release
	}), nil)
	request := httptest.NewRequest(http.MethodGet, "/api/app/workspace/v1/agents/agent-1/events", nil)
	done := make(chan struct{})
	go func() { defer close(done); lifecycle.ServeHTTP(httptest.NewRecorder(), request) }()
	<-started
	lifecycle.stop()
	lifecycle.stop()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := lifecycle.wait(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("drain result=%v", err)
	}
	close(release)
	defer func() { <-done }()
	deadline, cancelDeadline := context.WithTimeout(context.Background(), time.Second)
	defer cancelDeadline()
	if err := lifecycle.wait(deadline); err != nil {
		t.Fatal(err)
	}
}

func TestRetiredRoutesAreNotManagedReceiveStreams(t *testing.T) {
	for _, path := range []string{
		"/api/app/bootstrap", "/api/app/agents/agent-1/state", "/api/app/agents/agent-1/state/watch",
		"/api/app/agents/agent-1/acp", "/api/app/agents/agent-1/v1/acp", "/api/app/agents/agent-1/v2/acp",
	} {
		for _, upgrade := range []bool{false, true} {
			request := httptest.NewRequest(http.MethodGet, path, nil)
			if upgrade {
				request.Header.Set("Connection", "Upgrade")
				request.Header.Set("Upgrade", "websocket")
			}
			if managedStream(request) {
				t.Errorf("retired route still owns a stream: %s upgrade=%t", path, upgrade)
			}
		}
	}
}

func TestManagedReceiveRoutes(t *testing.T) {
	for _, path := range []string{
		"/api/admin/agents/agent-1/events/watch",
		"/%61pi/admin/agents/agent%2F1/events/watch",
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
		"/api/app/agents/agent-1/state/watch", "/api/app/agents/agent-1/v1/acp", "/api/app/agents/agent-1/acp",
		"/api/app/agents/agent-1/v2/acp", "/api/app/agents/agent-1/v3/acp",
		"/api/admin/agents/agent-1/events", "/api/app/agents/agent-1/v1/acp/extra",
		"/api/app/workspace/v1/agents/agent-1/events/extra",
	} {
		if managedStream(httptest.NewRequest(http.MethodGet, path, nil)) {
			t.Errorf("ordinary HTTP must retain graceful drain: %s", path)
		}
	}
}
