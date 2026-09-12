package egressclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"

	"go.opentelemetry.io/otel/attribute"

	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

var policyDigestPattern = regexp.MustCompile(`^sha256:[a-f0-9]{64}$`)

func (client *Client) GetAgentPolicyAssignment(ctx context.Context, agentID string) (ports.NetworkPolicyAssignment, error) {
	var result ports.NetworkPolicyAssignment
	err := client.policyRequest(ctx, http.MethodGet, "/internal/agent-policy-assignments/"+url.PathEscape(agentID), "get_policy_assignment", agentID, nil, func(payload []byte) error {
		var err error
		result, err = decodePolicyAssignment(payload, agentID)
		return err
	})
	return result, err
}

func (client *Client) GetPolicyRevision(ctx context.Context, ref ports.NetworkPolicyReference) (ports.NetworkPolicyRevision, error) {
	if !ref.Valid() {
		return ports.NetworkPolicyRevision{}, dependencyFailure("invalid_request", false)
	}
	path := "/internal/policies/" + url.PathEscape(ref.PolicyID) + "/revisions/" + strconv.FormatUint(ref.Revision, 10)
	var revision ports.NetworkPolicyRevision
	err := client.policyRequest(ctx, http.MethodGet, path, "get_policy_revision", "", nil, func(payload []byte) error {
		if json.Unmarshal(payload, &revision) != nil || revision.NetworkPolicyReference != ref ||
			revision.Spec.SchemaVersion != 1 || (revision.Spec.Action != "allow_all" && revision.Spec.Action != "deny_all") ||
			!policyDigestPattern.MatchString(revision.Digest) {
			return dependencyFailure("invalid_response", true)
		}
		return nil
	})
	if err != nil {
		return ports.NetworkPolicyRevision{}, err
	}
	return revision, nil
}

func (client *Client) SetAgentPolicyAssignment(ctx context.Context, agentID string, input ports.SetNetworkPolicy) (ports.NetworkPolicyAssignment, error) {
	if !input.Valid() || input.ExpectedResourceVersion == 0 {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_request", false)
	}
	body, err := json.Marshal(input)
	if err != nil {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_request", false)
	}
	var assignment ports.NetworkPolicyAssignment
	err = client.policyRequest(ctx, http.MethodPut, "/internal/agent-policy-assignments/"+url.PathEscape(agentID), "set_policy_assignment", agentID, body, func(payload []byte) error {
		var decodeErr error
		assignment, decodeErr = decodePolicyAssignment(payload, agentID)
		if decodeErr != nil {
			return decodeErr
		}
		if assignment.NetworkPolicyReference != input.NetworkPolicyReference ||
			(assignment.ResourceVersion != input.ExpectedResourceVersion &&
				(input.ExpectedResourceVersion == math.MaxUint64 || assignment.ResourceVersion != input.ExpectedResourceVersion+1)) {
			return dependencyFailure("invalid_response", true)
		}
		return nil
	})
	if err != nil {
		return ports.NetworkPolicyAssignment{}, err
	}
	return assignment, nil
}

func decodePolicyAssignment(payload []byte, agentID string) (ports.NetworkPolicyAssignment, error) {
	var assignment ports.NetworkPolicyAssignment
	if json.Unmarshal(payload, &assignment) != nil || assignment.AgentID != agentID ||
		!assignment.Valid() || assignment.ResourceVersion == 0 {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_response", true)
	}
	return assignment, nil
}

func (client *Client) policyRequest(ctx context.Context, method, path, operation, agentID string, payload []byte, consume func([]byte) error) (resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, operation, []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()
	endpoint := *client.baseURL
	endpoint.RawPath = path
	var err error
	endpoint.Path, err = url.PathUnescape(path)
	if err != nil {
		return dependencyFailure("invalid_request", false)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), bytes.NewReader(payload))
	if err != nil {
		return dependencyFailure("invalid_request", false)
	}
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	// A policy command has one target and one CAS attempt, including on redirects.
	httpClient := *client.httpClient
	httpClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := httpClient.Do(request)
	if err != nil {
		return dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	body, readErr := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if readErr != nil && (ctx.Err() != nil || errors.Is(readErr, context.DeadlineExceeded) || errors.Is(readErr, context.Canceled)) {
		return dependencyFailure("control_plane_unavailable", true, readErr, closeErr)
	}
	if readErr != nil || closeErr != nil || len(body) > maximumResponseBytes {
		return dependencyFailure("invalid_response", true, readErr, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return decodePolicyFailure(body, response.StatusCode)
	}
	return consume(body)
}

func decodePolicyFailure(body []byte, status int) error {
	var payload struct {
		Code string `json:"code"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return dependencyFailure("invalid_response", true)
	}
	expectedStatus := 0
	switch payload.Code {
	case "invalid_request":
		expectedStatus = http.StatusBadRequest
	case "agent_network_not_found", "policy_revision_not_found":
		expectedStatus = http.StatusNotFound
	case "resource_version_conflict", "agent_network_unavailable":
		expectedStatus = http.StatusConflict
	case "cleanup_failed", "operation_failed", "control_plane_unavailable":
		expectedStatus = http.StatusServiceUnavailable
	}
	if expectedStatus == 0 || status != expectedStatus {
		return dependencyFailure("invalid_response", true)
	}
	return dependencyFailure(payload.Code, status == http.StatusServiceUnavailable)
}

var _ ports.NetworkPolicyClient = (*Client)(nil)
