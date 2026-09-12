package server

import (
	"context"
	"errors"
	"net/http"
	"time"
)

func (h *handler) cancelStreamWrites(ctx context.Context, response http.ResponseWriter) func() {
	controller := http.NewResponseController(response)
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(done)
		h.streamWriteDeadline(ctx, controller, time.Now())
	})
	return func() {
		if !stop() {
			<-done
			// Allow net/http to finish an otherwise healthy chunked response.
			h.streamWriteDeadline(ctx, controller, time.Time{})
		}
	}
}

func (h *handler) streamWriteDeadline(ctx context.Context, response *http.ResponseController, deadline time.Time) {
	if err := response.SetWriteDeadline(deadline); err != nil && !errors.Is(err, http.ErrNotSupported) {
		h.logger.WarnContext(ctx, "Admin Console could not set stream write deadline",
			"error_class", "stream_shutdown_failed")
	}
}
