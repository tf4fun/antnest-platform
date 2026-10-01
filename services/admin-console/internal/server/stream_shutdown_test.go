package server

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestWatchRejectsNewSubscriptionsDuringShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	backend := newBackendStub()
	h := newStoppingHandler(t, backend, ctx, io.Discard)
	response := requestAdmin(t, h, http.MethodGet, "/api/admin/agents/agent-1/events/watch", "")
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"service_stopping"`) {
		t.Fatalf("unexpected response: %d %s", response.Code, response.Body.String())
	}
	if len(backend.calls) != 0 {
		t.Fatal("shutdown Watch reached the upstream")
	}
	ordinary := requestAdmin(t, h, http.MethodGet, "/api/admin/template-defaults", "")
	if ordinary.Code != http.StatusOK {
		t.Fatalf("stream shutdown also rejected ordinary request: %d", ordinary.Code)
	}
}

func TestWatchCancellationClosesBodyWithoutInvalidResponseWarning(t *testing.T) {
	for _, source := range []string{"client", "service"} {
		t.Run(source, func(t *testing.T) {
			serviceCtx, stopService := context.WithCancel(context.Background())
			defer stopService()
			clientCtx, stopClient := context.WithCancel(context.Background())
			defer stopClient()
			backend := &quietWatchBackend{started: make(chan struct{}), closed: make(chan struct{})}
			var logs bytes.Buffer
			h := newStoppingHandler(t, backend, serviceCtx, &logs)
			done := make(chan struct{})
			go func() {
				defer close(done)
				r := httptest.NewRequest(http.MethodGet, "/", nil).WithContext(clientCtx)
				h.streamProjected(httptest.NewRecorder(), r, upstream.AgentController,
					http.MethodGet, "/events/watch", "", nil, func(body []byte) ([]byte, error) { return body, nil })
			}()
			t.Cleanup(func() {
				stopService()
				stopClient()
				waitWatchSignal(t, done)
			})
			waitWatchSignal(t, backend.started)
			if source == "client" {
				stopClient()
			} else {
				stopService()
			}
			waitWatchSignal(t, done)
			waitWatchSignal(t, backend.closed)
			if logs.Len() != 0 {
				t.Fatalf("expected cancellation logged as failure: %s", logs.String())
			}
			if source == "client" && serviceCtx.Err() != nil {
				t.Fatal("one client cancelled the shared service lifecycle")
			}
		})
	}
}

func TestWatchShutdownReleasesBlockedDownstreamWrite(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	backend := newBackendStub()
	backend.enqueue(http.StatusOK, ": heartbeat\n\n")
	h := newStoppingHandler(t, backend, ctx, io.Discard)
	w := &blockedStreamWriter{header: make(http.Header), started: make(chan struct{}), expired: make(chan struct{})}
	done := make(chan struct{})
	go func() {
		defer close(done)
		h.streamProjected(w, httptest.NewRequest(http.MethodGet, "/", nil), upstream.AgentController,
			http.MethodGet, "/events/watch", "", nil, func(body []byte) ([]byte, error) { return body, nil })
	}()
	t.Cleanup(func() {
		w.unblock()
		waitWatchSignal(t, done)
	})
	waitWatchSignal(t, w.started)
	cancel()
	waitWatchSignal(t, done)
}

type blockedStreamWriter struct {
	header  http.Header
	started chan struct{}
	expired chan struct{}
	once    sync.Once
}

func (w *blockedStreamWriter) Header() http.Header { return w.header }
func (*blockedStreamWriter) WriteHeader(int)       {}
func (*blockedStreamWriter) Flush()                {}

func (w *blockedStreamWriter) Write([]byte) (int, error) {
	close(w.started)
	<-w.expired
	return 0, os.ErrDeadlineExceeded
}

func (w *blockedStreamWriter) SetWriteDeadline(deadline time.Time) error {
	if !deadline.After(time.Now()) {
		w.unblock()
	}
	return nil
}

func (w *blockedStreamWriter) unblock() { w.once.Do(func() { close(w.expired) }) }

func newStoppingHandler(t *testing.T, backend Backend, ctx context.Context, output io.Writer) *handler {
	t.Helper()
	h, err := NewHandler(Config{}, Dependencies{
		Backend: backend, Assets: fstest.MapFS{"index.html": &fstest.MapFile{}},
		StreamContext: ctx, Logger: slog.New(slog.NewTextHandler(output, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	result, ok := h.(*handler)
	if !ok {
		t.Fatal("unexpected handler implementation")
	}
	return result
}

type quietWatchBackend struct {
	started chan struct{}
	closed  chan struct{}
}

func (b *quietWatchBackend) Do(ctx context.Context, _ upstream.Target, _, _, _ string, _ []byte) (*http.Response, error) {
	close(b.started)
	return &http.Response{StatusCode: http.StatusOK,
		Header: http.Header{"Content-Type": []string{"text/event-stream"}},
		Body:   &cancelledWatchBody{ctx: ctx, closed: b.closed}}, nil
}

func (*quietWatchBackend) Ready(context.Context, upstream.Target) error { return nil }

type cancelledWatchBody struct {
	ctx    context.Context
	closed chan struct{}
}

func (b *cancelledWatchBody) Read([]byte) (int, error) {
	<-b.ctx.Done()
	return 0, b.ctx.Err()
}

func (b *cancelledWatchBody) Close() error {
	close(b.closed)
	return nil
}

func waitWatchSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal("Watch lifecycle did not settle")
	}
}
