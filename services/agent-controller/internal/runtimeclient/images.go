package runtimeclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (client *Client) ResolveImage(ctx context.Context, reference string) (result ports.ResolvedImage, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := tracer.Start(ctx, "agent_controller.runtime.resolve_image",
		trace.WithSpanKind(trace.SpanKindClient), trace.WithAttributes(
			attribute.String("server.address", client.baseURL.Hostname()),
			attribute.String("rpc.system", "http_json"),
		))
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, dependencyCode(resultErr))
		}
		span.End()
	}()
	endpoint := *client.baseURL
	endpoint.Path = "/internal/runtime-images/resolve"
	endpoint.RawQuery = url.Values{"reference": {reference}}.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return result, dependencyFailure("invalid_request", false)
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		return result, dependencyFailure("control_plane_unavailable", true)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(body) > maximumResponseBytes {
		return result, dependencyFailure("invalid_response", true)
	}
	if response.StatusCode != http.StatusOK {
		return result, decodeFailure(body, response.StatusCode)
	}
	var payload struct {
		Reference string `json:"reference"`
		ImageRef  string `json:"image_ref"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || !domain.IsImmutableImageReference(payload.ImageRef) ||
		strings.TrimSpace(payload.Reference) == "" || len(payload.Reference) > 512 {
		return result, dependencyFailure("invalid_response", true)
	}
	return ports.ResolvedImage{Reference: payload.Reference, ImageRef: payload.ImageRef}, nil
}

var _ ports.ImageResolver = (*Client)(nil)
