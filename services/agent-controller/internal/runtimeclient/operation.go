package runtimeclient

import (
	"context"
	"io"
	"net/http"
	"net/url"

	"go.opentelemetry.io/otel/attribute"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

// Only operation-bearing errors are reconciled; conflicts must never adopt a
// different command's journal. The original request deadline bounds this read.
func (client *Client) readOperationJournal(ctx context.Context, requestID, agentID string, original error) (body []byte, resultErr error) {
	ctx, span := telemetry.StartHTTPCall(ctx, "operation", []attribute.KeyValue{attribute.String("antnest.agent.id", agentID), attribute.String("antnest.operation.request_id", requestID)})
	defer func() { span.Finish(resultErr) }()
	endpoint := *client.baseURL
	endpoint.Path = "/internal/runtime-operations/" + url.PathEscape(requestID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, dependencyFailure("invalid_request", false)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	body, err = io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(body) > maximumResponseBytes {
		return nil, dependencyFailure("invalid_response", true, err, closeErr)
	}
	if response.StatusCode == http.StatusNotFound && dependencyCode(decodeFailure(body, response.StatusCode)) == "operation_not_found" {
		return nil, original
	}
	if response.StatusCode != http.StatusOK {
		return nil, dependencyFailure("operation_unverified", true)
	}
	return body, nil
}
