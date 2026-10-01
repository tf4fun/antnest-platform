package acpclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const maximumResponseBytes = 1 << 20

func (client *Client) exchange(ctx context.Context, method string, payload, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return ports.ErrInvalidExecutionConfiguration
	}
	endpoint := *client.baseURL
	endpoint.Path = "/rpc/agent-acp/" + method
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return failure("invalid_request", false, nil)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return failure("dependency_unavailable", true, err)
	}
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return failure("invalid_response", true, errors.Join(readErr, closeErr))
	}
	if response.StatusCode != http.StatusOK {
		return decodeFailure(method, response.StatusCode, responseBody)
	}
	mediaType, _, mediaErr := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if mediaErr != nil || mediaType != "application/json" {
		return failure("invalid_response", true, nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(responseBody))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(result); err != nil {
		return failure("invalid_response", true, nil)
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return failure("invalid_response", true, nil)
	}
	return nil
}

type responseFailure struct {
	status    int
	code      string
	retryable bool
}

var methodFailures = map[string][]responseFailure{
	"apply-execution-snapshot": {
		{400, "invalid_execution_configuration", false},
		{409, "configuration_conflict", false},
		{413, "configuration_too_large", false},
		{503, "configuration_unavailable", true},
	},
	"settle-agent": {
		{400, "invalid_agent_settlement", false},
		{409, "agent_operation_conflict", false},
		{503, "settlement_unavailable", true},
	},
}

func decodeFailure(method string, status int, body []byte) error {
	var response struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(body, &response) == nil {
		for _, expected := range methodFailures[method] {
			if status == expected.status && response.Code == expected.code {
				return failure(expected.code, expected.retryable, nil)
			}
		}
	}
	if status >= http.StatusInternalServerError {
		return failure("dependency_unavailable", true, nil)
	}
	return failure("invalid_response", true, nil)
}

func failure(code string, retryable bool, cause error) error {
	return &ports.DependencyError{Service: "agent-acp-service", Code: code, Retryable: retryable, Cause: safeCause(cause)}
}

// Temporal serializes unwrapped errors, not just the outer Error() message.
// Preserve cancellation classification without carrying transport input to history.
func safeCause(cause error) error {
	for _, sentinel := range []error{context.Canceled, context.DeadlineExceeded, io.ErrUnexpectedEOF, io.ErrClosedPipe} {
		if errors.Is(cause, sentinel) {
			return sentinel
		}
	}
	var network net.Error
	if errors.As(cause, &network) && network.Timeout() {
		return context.DeadlineExceeded
	}
	return nil
}
