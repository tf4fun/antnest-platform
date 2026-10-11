package main

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/streamio"
)

func cancelHTTPStreamWrites(ctx context.Context, response http.ResponseWriter, logger *slog.Logger) (*streamio.Writer, func()) {
	return streamio.CancelHTTPWrites(ctx, response, logger)
}
