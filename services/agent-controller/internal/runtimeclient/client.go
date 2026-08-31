package runtimeclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const maximumResponseBytes = 1 << 20

var tracer = otel.Tracer("soft/antnest-platform/agent-controller/runtimeclient")

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
	return &Client{baseURL: endpoint, httpClient: httpClient, timeout: timeout}, nil
}

func (client *Client) InitializeRuntime(
	ctx context.Context,
	requestID string,
	agentID string,
	configuration ports.RuntimeConfiguration,
) (result ports.RuntimeOperation, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := tracer.Start(
		ctx, "agent_controller.runtime.initialize",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("server.address", client.baseURL.Hostname()),
			attribute.String("antnest.agent.id", agentID),
			attribute.String("antnest.operation.request_id", requestID),
			attribute.String("rpc.system", "http_json"),
		),
	)
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, dependencyCode(resultErr))
		}
		span.End()
	}()

	payload := struct {
		Configuration runtimeConfigurationDTO `json:"configuration"`
	}{Configuration: runtimeConfigurationPayload(configuration)}
	body, err := json.Marshal(payload)
	if err != nil {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	endpoint := *client.baseURL
	endpoint.Path = "/internal/runtimes/" + url.PathEscape(agentID) + "/initialize"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(body))
	if err != nil {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_request", false)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", requestID)
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.RuntimeOperation{}, dependencyFailure("control_plane_unavailable", true)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_response", true)
	}
	if response.StatusCode != http.StatusOK && response.StatusCode != http.StatusAccepted {
		return ports.RuntimeOperation{}, decodeFailure(responseBody, response.StatusCode)
	}
	var operation runtimeOperationDTO
	if err := json.Unmarshal(responseBody, &operation); err != nil ||
		operation.RequestID != requestID || operation.AgentID != agentID ||
		operation.Kind != "initialize_runtime" || operation.State == "" {
		return ports.RuntimeOperation{}, dependencyFailure("invalid_response", true)
	}
	result = ports.RuntimeOperation{
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

type runtimeConfigurationDTO struct {
	ImageRef string `json:"image_ref"`
	Network  struct {
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
	RequestID      string `json:"request_id"`
	Kind           string `json:"kind"`
	AgentID        string `json:"agent_id"`
	TargetRevision string `json:"target_revision"`
	State          string `json:"state"`
	Effect         string `json:"effect"`
	Inspection     *struct {
		AgentID            string `json:"agent_id"`
		RuntimeRevision    string `json:"runtime_revision"`
		LifecycleState     string `json:"lifecycle_state"`
		Health             string `json:"health"`
		MCPEndpoint        string `json:"mcp_endpoint"`
		RuntimeExecutionID string `json:"runtime_execution_id"`
	} `json:"inspection"`
	ErrorCode   string `json:"error_code"`
	ErrorDetail string `json:"error_detail"`
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

func dependencyFailure(code string, retryable bool) error {
	return &ports.DependencyError{Service: "runtime-controller", Code: code, Retryable: retryable}
}

func dependencyCode(err error) string {
	if failure, ok := err.(*ports.DependencyError); ok {
		return failure.Code
	}
	return "dependency_error"
}

var _ ports.RuntimeClient = (*Client)(nil)
