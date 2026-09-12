package runtimeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

const maximumResponseBytes = 1 << 20

var runtimeRevisionPattern = regexp.MustCompile(`^rtv_[0-9a-f]{32}$`)

type completionKind string

const (
	completionReady    completionKind = "ready"
	completionDisabled completionKind = "disabled"
	completionDeleted  completionKind = "deleted"
)

type Client struct {
	baseURL    *url.URL
	httpClient *http.Client
	timeout    time.Duration
}

func New(baseURL string, timeout time.Duration, httpClient *http.Client) (*Client, error) {
	endpoint, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || endpoint.Host == "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") ||
		endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" ||
		(endpoint.Path != "" && endpoint.Path != "/") {
		return nil, fmt.Errorf("runtime controller URL must be an HTTP origin")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("runtime controller timeout must be positive")
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &Client{baseURL: endpoint, httpClient: telemetry.HTTPClient(httpClient, "runtime-controller"), timeout: timeout}, nil
}

func (client *Client) InitializeRuntime(
	ctx context.Context,
	requestID string,
	agentID string,
	configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	payload := struct {
		Configuration runtimeConfigurationDTO `json:"configuration"`
	}{Configuration: runtimeConfigurationPayload(configuration)}
	return client.callRuntimeOperation(
		ctx, requestID, agentID, "initialize", "initialize_runtime", payload, completionReady,
	)
}

func (client *Client) UpdateRuntime(
	ctx context.Context,
	requestID string,
	agentID string,
	expectedRevision string,
	configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	if !runtimeRevisionPattern.MatchString(expectedRevision) {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	payload := struct {
		ExpectedRevision string                  `json:"expected_revision"`
		Configuration    runtimeConfigurationDTO `json:"configuration"`
	}{
		ExpectedRevision: expectedRevision,
		Configuration:    runtimeConfigurationPayload(configuration),
	}
	return client.callRuntimeOperation(
		ctx, requestID, agentID, "update", "update_runtime", payload, completionReady,
	)
}

func (client *Client) DisableRuntime(
	ctx context.Context, requestID string, agentID string, expectedRevision string,
) (ports.RuntimeOperation, error) {
	if !runtimeRevisionPattern.MatchString(expectedRevision) {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	payload := struct {
		ExpectedRevision string `json:"expected_revision"`
	}{ExpectedRevision: expectedRevision}
	return client.callRuntimeOperation(
		ctx, requestID, agentID, "disable", "disable_runtime", payload, completionDisabled,
	)
}

func (client *Client) EnableRuntime(
	ctx context.Context,
	requestID string,
	agentID string,
	expectedRevision string,
	configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	if !runtimeRevisionPattern.MatchString(expectedRevision) {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	payload := struct {
		ExpectedRevision string                  `json:"expected_revision"`
		Configuration    runtimeConfigurationDTO `json:"configuration"`
	}{
		ExpectedRevision: expectedRevision,
		Configuration:    runtimeConfigurationPayload(configuration),
	}
	return client.callRuntimeOperation(
		ctx, requestID, agentID, "enable", "enable_runtime", payload, completionReady,
	)
}

func (client *Client) DeleteRuntime(
	ctx context.Context, requestID string, agentID string, expectedRevision string,
) (ports.RuntimeOperation, error) {
	if !runtimeRevisionPattern.MatchString(expectedRevision) {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	payload := struct {
		ExpectedRevision string `json:"expected_revision"`
	}{ExpectedRevision: expectedRevision}
	return client.callRuntimeOperation(
		ctx, requestID, agentID, "delete", "delete_runtime", payload, completionDeleted,
	)
}

func (client *Client) InspectRuntime(
	ctx context.Context, agentID string,
) (result ports.RuntimeInspection, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, "inspect", []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()

	endpoint := *client.baseURL
	endpoint.Path = "/internal/runtimes/" + url.PathEscape(agentID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return ports.RuntimeInspection{}, dependencyFailure("invalid_request", false)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.RuntimeInspection{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return ports.RuntimeInspection{}, dependencyFailure("invalid_response", true, err, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return ports.RuntimeInspection{}, decodeFailure(responseBody, response.StatusCode)
	}
	var inspection runtimeInspectionDTO
	if err := json.Unmarshal(responseBody, &inspection); err != nil ||
		inspection.AgentID != agentID || !validRuntimeInspection(inspection) {
		return ports.RuntimeInspection{}, dependencyFailure("invalid_response", true)
	}
	return ports.RuntimeInspection{
		AgentID: inspection.AgentID, RuntimeRevision: inspection.RuntimeRevision,
		RuntimeExecutionID: inspection.RuntimeExecutionID,
		MCPEndpoint:        inspection.MCPEndpoint,
		LifecycleState:     inspection.LifecycleState, Health: inspection.Health,
	}, nil
}

func (client *Client) callRuntimeOperation(
	ctx context.Context,
	requestID string,
	agentID string,
	action string,
	kind string,
	payload any,
	completion completionKind,
) (result ports.RuntimeOperation, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, action, []attribute.KeyValue{
		attribute.String("antnest.agent.id", agentID), attribute.String("antnest.operation.request_id", requestID), attribute.String("antnest.request.id", requestID),
	})
	defer func() {
		observedErr := resultErr
		if observedErr == nil && result.State == "failed" {
			observedErr = dependencyFailure(result.ErrorCode, false)
		}
		span.Finish(observedErr)
	}()

	body, err := json.Marshal(payload)
	if err != nil {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	endpoint := *client.baseURL
	endpoint.Path = "/internal/runtimes/" + url.PathEscape(agentID) + "/" + action
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", requestID)
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.RuntimeOperation{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_response", true, err, closeErr)
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusAccepted {
		failure := decodeFailure(responseBody, response.StatusCode)
		if !oneOf(dependencyCode(failure), "runtime_not_ready", "platform_unavailable", "operation_failed") {
			return ports.RuntimeOperation{}, failure
		}
		responseBody, err = client.readOperationJournal(ctx, requestID, agentID, failure)
		if err != nil {
			return ports.RuntimeOperation{}, err
		}
	}
	result, resultErr = decodeRuntimeOperation(responseBody, requestID, agentID, kind, completion)
	return result, resultErr
}

func decodeRuntimeOperation(responseBody []byte, requestID, agentID, kind string, completion completionKind) (ports.RuntimeOperation, error) {
	var operation runtimeOperationDTO
	if err := json.Unmarshal(responseBody, &operation); err != nil ||
		operation.RequestID != requestID || operation.AgentID != agentID ||
		operation.Kind != kind || !validRuntimeOperation(operation, completion) {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_response", true)
	}
	result := ports.RuntimeOperation{
		State: operation.State, Effect: operation.Effect,
		RuntimeRevision: operation.TargetRevision,
		ErrorCode:       operation.ErrorCode, ErrorDetail: operation.ErrorDetail,
	}
	if operation.Inspection != nil {
		if operation.Inspection.AgentID != agentID ||
			operation.Inspection.RuntimeRevision != operation.TargetRevision {
			return ports.RuntimeOperation{}, dependencyFailure("invalid_response", true)
		}
		result.RuntimeRevision = operation.Inspection.RuntimeRevision
		result.RuntimeExecutionID = operation.Inspection.RuntimeExecutionID
		result.MCPEndpoint = operation.Inspection.MCPEndpoint
		result.LifecycleState = operation.Inspection.LifecycleState
		result.Health = operation.Inspection.Health
	}
	return result, nil
}

func validRuntimeOperation(operation runtimeOperationDTO, completion completionKind) bool {
	if !runtimeRevisionPattern.MatchString(operation.TargetRevision) ||
		!oneOf(operation.State, "running", "completed", "failed", "unknown") ||
		!oneOf(operation.Effect, "completed", "not_started", "unknown") {
		return false
	}
	if operation.Inspection != nil && (operation.Inspection.AgentID != operation.AgentID ||
		operation.Inspection.RuntimeRevision != operation.TargetRevision) {
		return false
	}
	switch operation.State {
	case "running":
		return operation.Effect == "unknown"
	case "unknown":
		return operation.Effect == "unknown" || validUnreadyRuntimeOperation(operation, "unknown")
	case "failed":
		return operation.Effect == "not_started" || (operation.Kind == "initialize_runtime" && validUnreadyRuntimeOperation(operation, "failed"))
	case "completed":
	default:
		return false
	}
	if operation.Effect != "completed" || operation.Inspection == nil {
		return false
	}
	switch completion {
	case completionReady:
		return operation.Inspection.LifecycleState == "ready" &&
			operation.Inspection.Health == "healthy" &&
			strings.TrimSpace(operation.Inspection.RuntimeExecutionID) != "" &&
			validMCPEndpoint(operation.Inspection.MCPEndpoint)
	case completionDisabled:
		return operation.Inspection.LifecycleState == "disabled" &&
			operation.Inspection.Health == "absent" &&
			operation.Inspection.RuntimeExecutionID == "" && operation.Inspection.MCPEndpoint == ""
	case completionDeleted:
		return operation.Inspection.LifecycleState == "deleted" &&
			operation.Inspection.Health == "absent" &&
			operation.Inspection.RuntimeExecutionID == "" && operation.Inspection.MCPEndpoint == ""
	default:
		return false
	}
}

func validUnreadyRuntimeOperation(operation runtimeOperationDTO, lifecycle string) bool {
	return operation.Effect == "completed" && operation.ErrorCode == "runtime_not_ready" &&
		operation.Inspection != nil && operation.Inspection.LifecycleState == lifecycle &&
		validRuntimeInspection(*operation.Inspection)
}

func validRuntimeInspection(inspection runtimeInspectionDTO) bool {
	if !runtimeRevisionPattern.MatchString(inspection.RuntimeRevision) ||
		!oneOf(
			inspection.LifecycleState,
			"initializing", "ready", "updating", "disabling", "disabled",
			"enabling", "deleting", "deleted", "failed", "unknown",
		) || !oneOf(inspection.Health, "absent", "starting", "healthy", "unhealthy", "unknown") {
		return false
	}
	if inspection.MCPEndpoint != "" && !validMCPEndpoint(inspection.MCPEndpoint) {
		return false
	}
	switch inspection.LifecycleState {
	case "failed":
		return inspection.Health == "unhealthy" && inspection.MCPEndpoint == ""
	case "ready":
		return inspection.Health != "healthy" ||
			(strings.TrimSpace(inspection.RuntimeExecutionID) != "" && validMCPEndpoint(inspection.MCPEndpoint))
	case "disabled":
		return oneOf(inspection.Health, "absent", "unhealthy") &&
			inspection.RuntimeExecutionID == "" && inspection.MCPEndpoint == ""
	case "deleted":
		return inspection.Health == "absent" &&
			inspection.RuntimeExecutionID == "" && inspection.MCPEndpoint == ""
	default:
		return true
	}
}

func validMCPEndpoint(value string) bool {
	if value != strings.TrimSpace(value) {
		return false
	}
	endpoint, err := url.ParseRequestURI(value)
	return err == nil && endpoint.Host != "" && endpoint.User == nil && endpoint.Fragment == "" &&
		(endpoint.Scheme == "http" || endpoint.Scheme == "https")
}

func oneOf(value string, allowed ...string) bool {
	for _, candidate := range allowed {
		if value == candidate {
			return true
		}
	}
	return false
}

type runtimeConfigurationDTO struct {
	ImageRef   string             `json:"image_ref"`
	MCPServers []domain.MCPServer `json:"mcp_servers,omitempty"`
	Network    struct {
		PacketContractRevision uint32 `json:"packet_contract_revision"`
		EgressEndpoint         struct {
			IPv4 string `json:"ipv4"`
			Port uint16 `json:"port"`
		} `json:"egress_endpoint"`
		TunnelIPv4   string `json:"tunnel_ipv4"`
		ResolverIPv4 string `json:"resolver_ipv4"`
	} `json:"network"`
	Resources struct {
		MemoryBytes int64 `json:"memory_bytes"`
		PIDsLimit   int   `json:"pids_limit"`
		TmpfsBytes  int64 `json:"tmpfs_bytes"`
	} `json:"resources"`
}

func runtimeConfigurationPayload(configuration ports.RuntimeConfiguration) runtimeConfigurationDTO {
	var payload runtimeConfigurationDTO
	payload.ImageRef = configuration.ImageRef
	payload.MCPServers = domain.CloneMCPServers(configuration.MCPServers)
	payload.Network.PacketContractRevision = configuration.Network.PacketContractRevision
	payload.Network.EgressEndpoint.IPv4 = configuration.Network.EgressIPv4
	payload.Network.EgressEndpoint.Port = configuration.Network.EgressPort
	payload.Network.TunnelIPv4 = configuration.Network.TunnelIPv4
	payload.Network.ResolverIPv4 = configuration.Network.ResolverIPv4
	payload.Resources.MemoryBytes = configuration.Resources.MemoryBytes
	payload.Resources.PIDsLimit = configuration.Resources.PIDsLimit
	payload.Resources.TmpfsBytes = configuration.Resources.TmpfsBytes
	return payload
}

type runtimeOperationDTO struct {
	RequestID      string                `json:"request_id"`
	Kind           string                `json:"kind"`
	AgentID        string                `json:"agent_id"`
	TargetRevision string                `json:"target_revision"`
	State          string                `json:"state"`
	Effect         string                `json:"effect"`
	Inspection     *runtimeInspectionDTO `json:"inspection"`
	ErrorCode      string                `json:"error_code"`
	ErrorDetail    string                `json:"error_detail"`
}

type runtimeInspectionDTO struct {
	AgentID            string `json:"agent_id"`
	RuntimeRevision    string `json:"runtime_revision"`
	LifecycleState     string `json:"lifecycle_state"`
	Health             string `json:"health"`
	MCPEndpoint        string `json:"mcp_endpoint"`
	RuntimeExecutionID string `json:"runtime_execution_id"`
}

func decodeFailure(payload []byte, status int) error {
	var response struct {
		Code      string `json:"code"`
		Retryable bool   `json:"retryable"`
	}
	if json.Unmarshal(payload, &response) != nil || strings.TrimSpace(response.Code) == "" {
		return dependencyFailure("invalid_response", status >= http.StatusInternalServerError)
	}
	return dependencyFailure(response.Code, response.Retryable)
}

func dependencyFailure(code string, retryable bool, causes ...error) error {
	return &ports.DependencyError{Service: "runtime-controller", Code: code, Retryable: retryable, Cause: errors.Join(causes...)}
}

func dependencyCode(err error) string {
	if failure, ok := err.(*ports.DependencyError); ok {
		return failure.Code
	}
	return "dependency_error"
}

var _ ports.RuntimeClient = (*Client)(nil)
