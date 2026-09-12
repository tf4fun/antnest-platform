package telemetry

import (
	"context"
	"net/http"
	"net/url"

	"github.com/gorilla/websocket"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
)

func DialWebSocket(ctx context.Context, dialer *websocket.Dialer, target string, headers http.Header) (*websocket.Conn, *http.Response, error) {
	parsed, err := url.Parse(target)
	if err != nil {
		return nil, nil, err
	}
	ctx, span := startClient(ctx, http.MethodGet, parsed)
	defer span.End()
	forwarded := headers.Clone()
	if forwarded == nil {
		forwarded = make(http.Header)
	}
	forwarded.Del("Baggage")
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(forwarded))
	connection, response, err := dialer.DialContext(ctx, target, forwarded)
	if response != nil {
		span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	}
	if err != nil {
		recordFailure(span, "websocket_handshake", err)
	}
	return connection, response, err
}
