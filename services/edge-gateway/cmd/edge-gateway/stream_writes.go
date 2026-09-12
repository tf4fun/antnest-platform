package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

type streamResponseWriter struct {
	http.ResponseWriter
	mu        sync.Mutex
	cancelled bool
}

func (writer *streamResponseWriter) Unwrap() http.ResponseWriter { return writer.ResponseWriter }

// Per-frame deadlines cannot undo the stop deadline while a handler unwinds.
func (writer *streamResponseWriter) SetWriteDeadline(deadline time.Time) error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.cancelled {
		deadline = time.Now()
	}
	return http.NewResponseController(writer.ResponseWriter).SetWriteDeadline(deadline)
}

func (writer *streamResponseWriter) cancelWrites() error {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	writer.cancelled = true
	return http.NewResponseController(writer.ResponseWriter).SetWriteDeadline(time.Now())
}

func cancelHTTPStreamWrites(ctx context.Context, response http.ResponseWriter, logger *slog.Logger) (*streamResponseWriter, func()) {
	if logger == nil {
		logger = slog.Default()
	}
	writer := &streamResponseWriter{ResponseWriter: response}
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(done)
		reportStreamDeadline(ctx, logger, writer.cancelWrites())
	})
	return writer, func() {
		if !stop() {
			<-done
			// The handler is finished; allow net/http to terminate chunked output.
			reportStreamDeadline(ctx, logger, http.NewResponseController(response).SetWriteDeadline(time.Time{}))
		}
	}
}

func reportStreamDeadline(ctx context.Context, logger *slog.Logger, err error) {
	if err != nil && !errors.Is(err, http.ErrNotSupported) {
		logger.WarnContext(ctx, "Gateway could not set stream write deadline", "error_class", "stream_shutdown_failed")
	}
}
