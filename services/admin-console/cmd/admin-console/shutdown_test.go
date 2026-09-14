package main

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"

	"soft/antnest-platform/services/admin-console/internal/principal"
)

func TestRunStopsActiveWatchCleanly(t *testing.T) {
	upstreamStopped := make(chan struct{})
	backend := newShutdownBackend(t, func(w http.ResponseWriter, r *http.Request) {
		defer close(upstreamStopped)
		w.Header().Set("Content-Type", "text/event-stream")
		if err := http.NewResponseController(w).Flush(); err != nil {
			return
		}
		<-r.Context().Done()
	})
	console := startConsole(t, backend.URL, time.Second)
	response := consoleRequest(t, console.url+"/api/admin/agents/agent-1/events/watch")
	defer closeResponse(t, response)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("watch status = %d", response.StatusCode)
	}

	console.stop()
	if err := awaitConsoleStop(t, console); err != nil {
		t.Fatalf("active Watch caused unclean shutdown: %v", err)
	}
	awaitSignal(t, upstreamStopped, "upstream Watch cancellation")
	if _, err := io.ReadAll(response.Body); err != nil {
		t.Fatalf("Watch did not finish cleanly: %v", err)
	}
}

func TestRunDrainsOrdinaryRequestsWhileStoppingWatch(t *testing.T) {
	watchStopped := make(chan struct{})
	ordinaryStarted := make(chan struct{})
	ordinaryCancelled := make(chan struct{})
	release := make(chan struct{})
	releaseOnce := sync.OnceFunc(func() { close(release) })
	backend := newShutdownBackend(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rpc/identity/get-current-account" {
			close(ordinaryStarted)
			select {
			case <-r.Context().Done():
				close(ordinaryCancelled)
			case <-release:
				if _, err := io.WriteString(w, `{"account":{"email":"admin@example.com","display_name":"Administrator"}}`); err != nil {
					t.Error(err)
				}
			}
			return
		}
		defer close(watchStopped)
		w.Header().Set("Content-Type", "text/event-stream")
		if err := http.NewResponseController(w).Flush(); err != nil {
			return
		}
		<-r.Context().Done()
	})
	defer releaseOnce()
	console := startConsole(t, backend.URL, 2*time.Second)
	watch := consoleRequest(t, console.url+"/api/admin/agents/agent-1/events/watch")
	defer closeResponse(t, watch)
	ordinary := make(chan error, 1)
	go func() {
		response, err := adminRequest(console.url + "/api/admin/account")
		if err == nil {
			_, readErr := io.Copy(io.Discard, response.Body)
			err = errors.Join(readErr, response.Body.Close())
			if response.StatusCode != http.StatusOK {
				err = errors.Join(err, errors.New("ordinary request did not complete successfully"))
			}
		}
		ordinary <- err
	}()
	awaitSignal(t, ordinaryStarted, "ordinary request start")
	console.stop()
	awaitSignal(t, watchStopped, "Watch stop before ordinary request drain")
	select {
	case <-ordinaryCancelled:
		t.Fatal("shutdown cancelled an ordinary request")
	case <-console.stopped:
		t.Fatal("shutdown did not wait for the ordinary request")
	default:
	}
	releaseOnce()
	select {
	case err := <-ordinary:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("ordinary request did not finish")
	}
	if err := awaitConsoleStop(t, console); err != nil {
		t.Fatal(err)
	}
}

func TestRunRetainsShutdownDeadlineFailure(t *testing.T) {
	started := make(chan struct{})
	upstreamStopped := make(chan struct{})
	backend := newShutdownBackend(t, func(_ http.ResponseWriter, r *http.Request) {
		defer close(upstreamStopped)
		close(started)
		<-r.Context().Done()
	})
	console := startConsole(t, backend.URL, 100*time.Millisecond)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		response, err := adminRequest(console.url + "/api/admin/account")
		if err == nil {
			closeResponse(t, response)
		}
	}()
	awaitSignal(t, started, "ordinary request start")
	console.stop()
	if err := awaitConsoleStop(t, console); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("shutdown must retain the real deadline failure, got %v", err)
	}
	awaitSignal(t, upstreamStopped, "forced-close upstream cancellation")
	awaitSignal(t, finished, "forced-close client completion")
}

func TestRunWaitsForRequestTraceAfterForcedClose(t *testing.T) {
	exporter := &blockedRequestExporter{started: make(chan struct{}), release: make(chan struct{})}
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
	backend := newShutdownBackend(t, func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	})
	console := startConsole(t, backend.URL, 100*time.Millisecond)
	defer release()
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		response, err := adminRequest(console.url + "/api/admin/account")
		if err == nil {
			closeResponse(t, response)
		}
	}()
	awaitSignal(t, started, "ordinary request start")
	console.stop()
	awaitSignal(t, exporter.started, "request trace completion after forced close")
	select {
	case <-console.stopped:
		t.Fatal("Console returned before the request trace completed")
	case <-time.After(50 * time.Millisecond):
	}
	release()
	if err := awaitConsoleStop(t, console); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("forced-close trace drain erased the deadline failure: %v", err)
	}
	awaitSignal(t, finished, "client completion")
}

type blockedRequestExporter struct {
	started chan struct{}
	release chan struct{}
}

func (e *blockedRequestExporter) ExportSpans(_ context.Context, spans []sdktrace.ReadOnlySpan) error {
	for _, span := range spans {
		if span.Name() == "HTTP GET /api/admin/account" {
			close(e.started)
			<-e.release
		}
	}
	return nil
}

func (*blockedRequestExporter) Shutdown(context.Context) error { return nil }

type runningConsole struct {
	url     string
	stop    context.CancelFunc
	result  <-chan error
	stopped <-chan struct{}
}

func newShutdownBackend(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	backend := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := io.Copy(io.Discard, r.Body); err != nil {
			return
		}
		handler(w, r)
	}))
	backend.Config.BaseContext = func(net.Listener) context.Context { return ctx }
	backend.Start()
	t.Cleanup(func() {
		cancel()
		backend.Close()
	})
	return backend
}

func startConsole(t *testing.T, upstreamURL string, budget time.Duration) runningConsole {
	t.Helper()
	t.Setenv("OTEL_SDK_DISABLED", "true")
	propagator := otel.GetTextMapPropagator()
	t.Cleanup(func() { otel.SetTextMapPropagator(propagator) })
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	if err := listener.Close(); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		"ANTNEST_ADMIN_CONSOLE_LISTEN":   address,
		"ANTNEST_IDENTITY_SERVICE_URL":   upstreamURL,
		"ANTNEST_AGENT_CONTROLLER_URL":   upstreamURL,
		"ANTNEST_AGENT_ACP_SERVICE_URL":  upstreamURL,
		"ANTNEST_ADMIN_SHUTDOWN_TIMEOUT": budget.String(),
	}
	ctx, cancel := context.WithCancel(context.Background())
	done, stopped := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(stopped)
		done <- run(ctx, func(key string) string { return values[key] })
	}()
	console := runningConsole{url: "http://" + address, stop: cancel, result: done, stopped: stopped}
	t.Cleanup(func() {
		cancel()
		awaitSignal(t, stopped, "Console cleanup")
	})
	waitForConsole(t, console)
	return console
}

func waitForConsole(t *testing.T, console runningConsole) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for {
		response, err := adminRequest(console.url + "/api/admin/template-defaults")
		if err == nil {
			if _, err := io.Copy(io.Discard, response.Body); err != nil {
				closeResponse(t, response)
				t.Fatal(err)
			}
			closeResponse(t, response)
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		select {
		case <-console.stopped:
			t.Fatalf("Console stopped before listening: %v", <-console.result)
		case <-deadline.C:
			t.Fatal("Console did not start")
		case <-ticker.C:
		}
	}
}

func adminRequest(url string) (*http.Response, error) {
	r, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	r.Header.Set(principal.HeaderUserID, "user-admin")
	r.Header.Set(principal.HeaderOrganizationID, "org-1")
	r.Header.Set(principal.HeaderMembershipID, "member-1")
	r.Header.Set(principal.HeaderSystemRole, "admin")
	r.Header.Set(principal.HeaderOrganizationRole, "admin")
	return (&http.Client{Timeout: 4 * time.Second}).Do(r)
}

func consoleRequest(t *testing.T, url string) *http.Response {
	t.Helper()
	response, err := adminRequest(url)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func closeResponse(t *testing.T, response *http.Response) {
	t.Helper()
	if err := response.Body.Close(); err != nil {
		t.Error(err)
	}
}

func awaitSignal(t *testing.T, signal <-chan struct{}, description string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(3 * time.Second):
		t.Fatalf("timed out waiting for %s", description)
	}
}

func awaitConsoleStop(t *testing.T, console runningConsole) error {
	t.Helper()
	awaitSignal(t, console.stopped, "Console shutdown")
	return <-console.result
}
