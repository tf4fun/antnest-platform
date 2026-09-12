package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

func TestCancelledStreamClampsLaterWriteDeadlines(t *testing.T) {
	base := &streamDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), cancelled: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer, finish := cancelHTTPStreamWrites(ctx, base, nil)
	cancel()
	awaitGatewaySignal(t, base.cancelled)
	controller := http.NewResponseController(writer)
	for _, deadline := range []time.Time{time.Now().Add(time.Hour), {}} {
		if err := controller.SetWriteDeadline(deadline); err != nil {
			t.Fatal(err)
		}
		if got := base.current(); got.IsZero() || got.After(time.Now()) {
			t.Fatalf("cancelled writer accepted a renewed deadline: %v", got)
		}
	}
	finish()
	if !base.current().IsZero() {
		t.Fatal("finished handler left an expired connection deadline")
	}
}

func TestCompletedStreamDoesNotWriteAfterHandlerReturns(t *testing.T) {
	base := &streamDeadlineRecorder{ResponseRecorder: httptest.NewRecorder(), cancelled: make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	_, finish := cancelHTTPStreamWrites(ctx, base, nil)
	finish()
	cancel()
	if !base.current().IsZero() {
		t.Fatal("completed handler deadline changed")
	}
}

type streamDeadlineRecorder struct {
	*httptest.ResponseRecorder
	mu        sync.Mutex
	deadline  time.Time
	cancelled chan struct{}
	once      sync.Once
}

func (writer *streamDeadlineRecorder) SetWriteDeadline(deadline time.Time) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.deadline = deadline
	if !deadline.IsZero() && !deadline.After(time.Now()) {
		writer.once.Do(func() { close(writer.cancelled) })
	}
	return nil
}

func (writer *streamDeadlineRecorder) current() time.Time {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	return writer.deadline
}
