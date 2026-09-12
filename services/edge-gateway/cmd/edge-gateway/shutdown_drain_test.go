package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"soft/antnest-platform/services/edge-gateway/internal/telemetry"
)

func awaitGatewaySignal(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Gateway request lifecycle did not settle")
	}
}

func TestShutdownWaitsForTelemetryAfterDeadline(t *testing.T) {
	for _, path := range []string{"/api/admin/overview", "/api/app/agents/agent-1/v1/acp"} {
		t.Run(path, func(t *testing.T) { testGatewayTraceDrain(t, path) })
	}
}

func testGatewayTraceDrain(t *testing.T, path string) {
	t.Helper()
	exporter := &gatewayDrainExporter{started: make(chan struct{}), release: make(chan struct{})}
	release := sync.OnceFunc(func() { close(exporter.release) })
	provider := sdktrace.NewTracerProvider(sdktrace.WithSyncer(exporter))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		release()
		if err := provider.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
		otel.SetTracerProvider(previous)
	})
	started := make(chan struct{})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	handler := telemetry.HTTPHandler(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}), logger)
	lifecycle := newStreamLifecycle(handler, logger)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: lifecycle, ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	defer release()
	done := make(chan error, 1)
	go func() { done <- serveHTTP(ctx, server, listener, lifecycle, 100*time.Millisecond) }()
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		client := &http.Client{Timeout: 3 * time.Second}
		response, requestErr := client.Get("http://" + listener.Addr().String() + path)
		if requestErr == nil {
			if closeErr := response.Body.Close(); closeErr != nil {
				t.Error(closeErr)
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		release()
		if closeErr := server.Close(); closeErr != nil {
			t.Error(closeErr)
		}
		awaitGatewaySignal(t, clientDone)
	})
	awaitGatewaySignal(t, started)
	cancel()
	awaitGatewaySignal(t, exporter.started)
	select {
	case err := <-done:
		t.Fatalf("Gateway returned before request trace completion: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	release()
	select {
	case err := <-done:
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("forced-close drain lost original timeout: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Gateway did not finish after trace exporter released")
	}
}

type gatewayDrainExporter struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (e *gatewayDrainExporter) ExportSpans(context.Context, []sdktrace.ReadOnlySpan) error {
	e.once.Do(func() { close(e.started) })
	<-e.release
	return nil
}

func (*gatewayDrainExporter) Shutdown(context.Context) error { return nil }

func TestACPHTTPCommandsKeepGracefulDrain(t *testing.T) {
	for _, path := range []string{"/api/app/agents/agent-1/v1/acp", "/api/app/agents/agent-1/acp"} {
		for _, method := range []string{http.MethodPost, http.MethodDelete} {
			t.Run(method+path, func(t *testing.T) { testGatewayCommandDrain(t, method, path) })
		}
	}
}

func testGatewayCommandDrain(t *testing.T, method, path string) {
	t.Helper()
	started := make(chan context.Context, 1)
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	defer releaseOnce()
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		started <- r.Context()
		<-release
		w.WriteHeader(http.StatusAccepted)
	}), nil)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: lifecycle, ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveHTTP(ctx, server, listener, lifecycle, time.Second) }()
	responses := make(chan int, 1)
	clientDone := make(chan struct{})
	go func() {
		defer close(clientDone)
		defer close(responses)
		r, requestErr := http.NewRequest(method, "http://"+listener.Addr().String()+path, nil)
		if requestErr != nil {
			t.Error(requestErr)
			return
		}
		response, requestErr := (&http.Client{Timeout: 3 * time.Second}).Do(r)
		if requestErr != nil {
			t.Error(requestErr)
			return
		}
		responses <- response.StatusCode
		if closeErr := response.Body.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	}()
	t.Cleanup(func() {
		cancel()
		releaseOnce()
		if err := server.Close(); err != nil {
			t.Error(err)
		}
		awaitGatewaySignal(t, clientDone)
	})
	var requestContext context.Context
	select {
	case requestContext = <-started:
	case <-time.After(2 * time.Second):
		t.Fatal("ACP command did not begin")
	}
	cancel()
	select {
	case <-requestContext.Done():
		t.Fatal("stop cancelled an ordinary ACP HTTP command")
	case <-time.After(50 * time.Millisecond):
	}
	releaseOnce()
	awaitGatewaySignal(t, clientDone)
	if status := <-responses; status != http.StatusAccepted {
		t.Fatalf("command did not finish: %d", status)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ordinary command did not drain")
	}
}

func TestReceiveShutdownUnblocksSlowReader(t *testing.T) {
	for _, path := range []string{
		"/api/app/agents/agent-1/state/watch", "/api/app/agents/agent-1/v1/acp",
		"/api/app/agents/agent-1/acp", "/api/admin/agents/agent-1/events/watch",
	} {
		t.Run(path, func(t *testing.T) { testGatewaySlowReader(t, path) })
	}
}

func testGatewaySlowReader(t *testing.T, path string) {
	t.Helper()
	written := make(chan struct{})
	writeErrors := make(chan error, 1)
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		defer close(written)
		w.Header().Set("Content-Type", "text/event-stream")
		_, err := w.Write(bytes.Repeat([]byte("x"), 32<<20))
		writeErrors <- err
	}), nil)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: lifecycle, ReadHeaderTimeout: time.Second}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- serveHTTP(ctx, server, listener, lifecycle, time.Second) }()
	connection, err := net.DialTCP("tcp", nil, listener.Addr().(*net.TCPAddr))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cancel()
		if err := connection.Close(); err != nil {
			t.Error(err)
		}
		if err := server.Close(); err != nil {
			t.Error(err)
		}
		awaitGatewaySignal(t, written)
	})
	if err := connection.SetReadBuffer(1024); err != nil {
		t.Fatal(err)
	}
	if err := connection.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(connection, "GET "+path+" HTTP/1.1\r\nHost: localhost\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	response, err := http.ReadResponse(bufio.NewReader(connection), nil)
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != http.StatusOK {
		t.Fatalf("stream status %d", response.StatusCode)
	}
	select {
	case <-written:
		t.Fatal("fixture did not block downstream writing")
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("slow reader exhausted shutdown grace: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("slow-reader shutdown did not settle")
	}
	awaitGatewaySignal(t, written)
	if err := <-writeErrors; err == nil {
		t.Fatal("blocked write was not interrupted")
	}
}
