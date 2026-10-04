package runtimeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
	"go.opentelemetry.io/otel/attribute"
)

const maximumConnectionResponseBytes = 8192

var _ ports.RuntimeConnectionResolver = (*Client)(nil)

func (client *Client) ResolveRuntimeConnection(ctx context.Context, agentID, revision, executionID string) (result ports.RuntimeConnection, resultErr error) {
	if err := ctx.Err(); err != nil {
		return result, err
	}
	if ports.ValidateRuntimeConnectionRequest(agentID, revision, executionID) != nil {
		return result, connectionFailure("invalid_request", false, nil)
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, "resolve_runtime_connection", []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()
	payload := struct {
		RuntimeRevision     string `json:"runtime_revision"`
		ExpectedExecutionID string `json:"expected_execution_id"`
	}{revision, executionID}
	body, err := json.Marshal(payload)
	if err != nil {
		return result, connectionFailure("invalid_request", false, nil)
	}
	endpoint := *client.baseURL
	endpoint.Path = "/internal/runtimes/" + url.PathEscape(agentID) + "/connection"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return result, connectionFailure("invalid_request", false, nil)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Accept-Encoding", "identity")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return result, connectionFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, maximumConnectionResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(raw) > maximumConnectionResponseBytes {
		return result, connectionFailure("invalid_response", true, errors.Join(readErr, closeErr))
	}
	if response.StatusCode != http.StatusOK {
		return result, connectionResponseFailure(response.StatusCode, raw)
	}
	cache := response.Header.Values("Cache-Control")
	if !connectionJSONMedia(response.Header.Values("Content-Type")) ||
		len(cache) != 1 || cache[0] != "no-store" || len(response.Header.Values("Content-Encoding")) != 0 ||
		serviceauth.DecodeObject(raw, &result) != nil ||
		!result.Valid() || result.AgentID != agentID || result.RuntimeRevision != revision || result.RuntimeExecutionID != executionID {
		return ports.RuntimeConnection{}, connectionFailure("invalid_response", true, nil)
	}
	return result, nil
}

func connectionJSONMedia(values []string) bool {
	if len(values) != 1 || len(strings.Split(values[0], ";")) > 2 {
		return false
	}
	media, params, err := mime.ParseMediaType(values[0])
	return err == nil && media == "application/json" &&
		(len(params) == 0 || len(params) == 1 && strings.EqualFold(params["charset"], "utf-8"))
}

func connectionResponseFailure(status int, raw []byte) error {
	var response struct {
		Code      string `json:"code"`
		Message   string `json:"message"`
		Retryable bool   `json:"retryable"`
	}
	if serviceauth.DecodeObject(raw, &response) == nil {
		for _, expected := range []struct {
			status    int
			code      string
			retryable bool
		}{
			{400, "invalid_request", false},
			{401, "service_unauthenticated", false},
			{403, "caller_not_allowed", false},
			{404, "runtime_not_found", false},
			{409, "runtime_connection_stale", false},
			{503, "runtime_connection_unavailable", true},
		} {
			if expected.status == status && expected.code == response.Code && expected.retryable == response.Retryable {
				return connectionFailure(expected.code, expected.retryable, nil)
			}
		}
	}
	return connectionFailure("invalid_response", true, nil)
}

func connectionFailure(code string, retryable bool, cause error) error {
	var safe error
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded, io.ErrUnexpectedEOF, io.ErrClosedPipe} {
		if errors.Is(cause, sentinel) {
			safe = sentinel
			break
		}
	}
	var network net.Error
	if safe == nil && errors.As(cause, &network) && network.Timeout() {
		safe = context.DeadlineExceeded
	}
	return &ports.DependencyError{Service: "runtime-controller", Code: code, Retryable: retryable, Cause: safe}
}
