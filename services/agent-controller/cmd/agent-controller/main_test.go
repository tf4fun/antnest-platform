package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
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

func TestShutdownHTTPAndRecoveryStartsHTTPShutdownBeforeRecoveryStops(t *testing.T) {
	t.Parallel()

	httpServer := &http.Server{}
	httpShutdownStarted := make(chan struct{})
	httpServer.RegisterOnShutdown(func() { close(httpShutdownStarted) })
	recoveryErrors := make(chan error, 1)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- shutdownHTTPAndRecovery(ctx, httpServer, recoveryErrors, false)
	}()

	select {
	case <-httpShutdownStarted:
	case <-time.After(250 * time.Millisecond):
		t.Fatal("HTTP shutdown waited for lifecycle recovery to stop")
	}
	select {
	case err := <-result:
		t.Fatalf("shutdown returned before lifecycle recovery stopped: %v", err)
	default:
	}
	recoveryErrors <- nil
	if err := <-result; err != nil {
		t.Fatalf("shutdown HTTP and recovery: %v", err)
	}
}

func TestShutdownHTTPAndRecoveryWaitsForHTTPAfterRecoveryStops(t *testing.T) {
	t.Parallel()

	handlerStarted := make(chan struct{})
	releaseHandler := make(chan struct{})
	httpServer := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		close(handlerStarted)
		<-releaseHandler
		response.WriteHeader(http.StatusNoContent)
	})}
	serverConnection, clientConnection := net.Pipe()
	listener := &singleConnectionListener{
		connection: serverConnection,
		closed:     make(chan struct{}),
	}
	serveDone := make(chan error, 1)
	go func() { serveDone <- httpServer.Serve(listener) }()
	release := func() {
		select {
		case <-releaseHandler:
		default:
			close(releaseHandler)
		}
	}
	t.Cleanup(func() {
		release()
		_ = clientConnection.Close()
		_ = listener.Close()
	})
	requestDone := make(chan error, 1)
	go func() {
		if _, err := io.WriteString(clientConnection, "GET / HTTP/1.1\r\nHost: controller.test\r\n\r\n"); err != nil {
			requestDone <- err
			return
		}
		response, err := http.ReadResponse(bufio.NewReader(clientConnection), &http.Request{Method: http.MethodGet})
		if err == nil {
			err = response.Body.Close()
		}
		requestDone <- err
	}()
	select {
	case <-handlerStarted:
	case <-time.After(time.Second):
		t.Fatal("HTTP request did not reach handler")
	}

	recoveryErrors := make(chan error, 1)
	recoveryErrors <- nil
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	result := make(chan error, 1)
	go func() {
		result <- shutdownHTTPAndRecovery(ctx, httpServer, recoveryErrors, false)
	}()
	select {
	case err := <-result:
		t.Fatalf("shutdown returned before HTTP request drained: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	release()
	if err := <-requestDone; err != nil {
		t.Fatalf("drain HTTP request: %v", err)
	}
	if err := <-result; err != nil {
		t.Fatalf("shutdown HTTP and recovery: %v", err)
	}
	if err := <-serveDone; err != nil && !errors.Is(err, http.ErrServerClosed) {
		t.Fatalf("serve HTTP: %v", err)
	}
}

func TestShutdownHTTPAndRecoveryReportsRecoveryFailureAndDeadline(t *testing.T) {
	t.Parallel()

	t.Run("recovery failure", func(t *testing.T) {
		recoveryErrors := make(chan error, 1)
		recoveryErrors <- errors.New("worker failed")
		err := shutdownHTTPAndRecovery(context.Background(), &http.Server{}, recoveryErrors, false)
		if err == nil || serviceFailureClass(err) != "lifecycle_recovery_shutdown" {
			t.Fatalf("recovery shutdown error = %v", err)
		}
	})
	t.Run("recovery already stopped", func(t *testing.T) {
		if err := shutdownHTTPAndRecovery(context.Background(), &http.Server{}, nil, true); err != nil {
			t.Fatalf("already stopped recovery: %v", err)
		}
	})
	t.Run("deadline", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
		defer cancel()
		err := shutdownHTTPAndRecovery(ctx, &http.Server{}, make(chan error), false)
		if err == nil || serviceFailureClass(err) != "lifecycle_recovery_shutdown" {
			t.Fatalf("deadline error = %v", err)
		}
	})
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

type singleConnectionListener struct {
	mutex      sync.Mutex
	connection net.Conn
	closed     chan struct{}
	closeOnce  sync.Once
}

func (listener *singleConnectionListener) Accept() (net.Conn, error) {
	listener.mutex.Lock()
	if listener.connection != nil {
		connection := listener.connection
		listener.connection = nil
		listener.mutex.Unlock()
		return connection, nil
	}
	listener.mutex.Unlock()
	<-listener.closed
	return nil, net.ErrClosed
}

func (listener *singleConnectionListener) Close() error {
	listener.closeOnce.Do(func() { close(listener.closed) })
	return nil
}

func (listener *singleConnectionListener) Addr() net.Addr { return pipeAddress("controller.test") }

type pipeAddress string

func (address pipeAddress) Network() string { return "pipe" }

func (address pipeAddress) String() string { return string(address) }
