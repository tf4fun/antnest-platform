package runtimeclient

import (
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func (client *Client) ListRuntimeObservations(
	ctx context.Context, after uint64, limit int,
) (page ports.RuntimeObservationPage, resultErr error) {
	ctx, call := telemetry.StartHTTPCall(ctx, "list_runtime_observations", nil)
	defer func() { call.Finish(resultErr) }()
	if limit < 1 || limit > 500 {
		return ports.RuntimeObservationPage{}, dependencyFailure("invalid_request", false)
	}
	query := url.Values{
		"after_sequence": []string{strconv.FormatUint(after, 10)},
		"limit":          []string{strconv.Itoa(limit)},
	}
	payload, status, err := client.get(ctx, "/internal/runtime-observations", query)
	if err != nil {
		return ports.RuntimeObservationPage{}, err
	}
	if status == http.StatusGone {
		var failure struct {
			Code          string  `json:"code"`
			ResetSequence *uint64 `json:"reset_sequence"`
		}
		if json.Unmarshal(payload, &failure) != nil ||
			failure.Code != "observation_cursor_expired" || failure.ResetSequence == nil {
			return ports.RuntimeObservationPage{}, dependencyFailure("invalid_response", true)
		}
		return ports.RuntimeObservationPage{}, &ports.RuntimeObservationCursorExpiredError{
			ResetSequence: *failure.ResetSequence,
		}
	}
	if status != http.StatusOK {
		return ports.RuntimeObservationPage{}, decodeFailure(payload, status)
	}
	var response runtimeObservationsDTO
	if json.Unmarshal(payload, &response) != nil || response.NextSequence > math.MaxInt64 {
		return ports.RuntimeObservationPage{}, dependencyFailure("invalid_response", true)
	}
	result := ports.RuntimeObservationPage{
		Observations: make([]ports.RuntimeObservation, 0, len(response.Observations)),
		NextSequence: response.NextSequence,
	}
	previous := after
	for _, observation := range response.Observations {
		if observation.Sequence <= previous || observation.Sequence > math.MaxInt64 || observation.ObservedAt.IsZero() ||
			strings.TrimSpace(observation.Kind) == "" {
			return ports.RuntimeObservationPage{}, dependencyFailure("invalid_response", true)
		}
		if observation.AgentID != "" && !runtimeRevisionPattern.MatchString(observation.RuntimeRevision) {
			return ports.RuntimeObservationPage{}, dependencyFailure("invalid_response", true)
		}
		result.Observations = append(result.Observations, ports.RuntimeObservation{
			Sequence: observation.Sequence, AgentID: observation.AgentID,
			RuntimeRevision:    observation.RuntimeRevision,
			RuntimeExecutionID: observation.RuntimeExecutionID,
			Kind:               observation.Kind, ObservedAt: observation.ObservedAt,
		})
		previous = observation.Sequence
	}
	if response.NextSequence != previous {
		return ports.RuntimeObservationPage{}, dependencyFailure("invalid_response", true)
	}
	return result, nil
}

func (client *Client) ListRuntimes(
	ctx context.Context,
) (snapshots []ports.RuntimeEnvironmentSnapshot, resultErr error) {
	ctx, call := telemetry.StartHTTPCall(ctx, "list_runtimes", nil)
	defer func() { call.Finish(resultErr) }()
	payload, status, err := client.get(ctx, "/internal/runtimes", nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, decodeFailure(payload, status)
	}
	var response runtimeListDTO
	if json.Unmarshal(payload, &response) != nil {
		return nil, dependencyFailure("invalid_response", true)
	}
	result := make([]ports.RuntimeEnvironmentSnapshot, 0, len(response.Runtimes))
	for _, runtime := range response.Runtimes {
		if !validRuntimeInspection(runtime) {
			return nil, dependencyFailure("invalid_response", true)
		}
		result = append(result, ports.RuntimeEnvironmentSnapshot{
			Phase: runtime.Phase, Reason: runtime.Reason, DiagnosticSummary: runtime.DiagnosticSummary, ObservedAt: runtime.ObservedAt,
			AgentID: runtime.AgentID, RuntimeRevision: runtime.RuntimeRevision,
			RuntimeExecutionID: runtime.RuntimeExecutionID,
			LifecycleState:     runtime.LifecycleState, Health: runtime.Health,
		})
	}
	return result, nil
}

func (client *Client) get(
	ctx context.Context, path string, query url.Values,
) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	endpoint := *client.baseURL
	endpoint.Path = path
	if query != nil {
		endpoint.RawQuery = query.Encode()
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, 0, dependencyFailure("invalid_request", false)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, 0, dependencyFailure("control_plane_unavailable", true, err)
	}
	if response == nil || response.Body == nil {
		return nil, 0, dependencyFailure("invalid_response", true)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(payload) > maximumResponseBytes {
		return nil, 0, dependencyFailure("invalid_response", true, err, closeErr)
	}
	return payload, response.StatusCode, nil
}

type runtimeObservationDTO struct {
	Sequence           uint64    `json:"sequence"`
	AgentID            string    `json:"agent_id"`
	RuntimeRevision    string    `json:"runtime_revision"`
	RuntimeExecutionID string    `json:"runtime_execution_id"`
	Kind               string    `json:"kind"`
	ObservedAt         time.Time `json:"observed_at"`
}

type runtimeObservationsDTO struct {
	Observations []runtimeObservationDTO `json:"observations"`
	NextSequence uint64                  `json:"next_sequence"`
}

type runtimeListDTO struct {
	Runtimes []runtimeInspectionDTO `json:"runtimes"`
}

var _ ports.RuntimeObservationSource = (*Client)(nil)
