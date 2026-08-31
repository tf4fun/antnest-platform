package egressclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
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

var tracer = otel.Tracer("soft/antnest-platform/agent-controller/egressclient")

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
		return nil, fmt.Errorf("runtime egress URL must be an HTTP origin")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("runtime egress timeout must be positive")
	}
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	return &Client{baseURL: endpoint, httpClient: httpClient, timeout: timeout}, nil
}

func (client *Client) EnsureAgentNetwork(
	ctx context.Context, agentID string,
) (result ports.NetworkAttachment, resultErr error) {
	return client.readAgentNetwork(ctx, http.MethodPut, agentID, "ensure_agent_network", true)
}

func (client *Client) GetAgentNetwork(
	ctx context.Context, agentID string,
) (result ports.NetworkAttachment, resultErr error) {
	return client.readAgentNetwork(ctx, http.MethodGet, agentID, "get_agent_network", false)
}

func (client *Client) FenceAgentNetwork(ctx context.Context, agentID string) error {
	return client.postAgentNetworkAction(ctx, agentID, "fence", "fence_agent_network")
}

func (client *Client) ResetAgentFlows(ctx context.Context, agentID string) error {
	return client.postAgentNetworkAction(ctx, agentID, "reset-flows", "reset_agent_flows")
}

func (client *Client) GetAgentPolicyAssignment(
	ctx context.Context, agentID string,
) (ports.NetworkPolicyAssignment, error) {
	return client.callPolicyAssignment(
		ctx, http.MethodGet, ports.NetworkPolicyAssignment{AgentID: agentID}, 0,
		"get_agent_policy_assignment",
	)
}

func (client *Client) AssignAgentPolicy(
	ctx context.Context,
	assignment ports.NetworkPolicyAssignment,
	expectedResourceVersion uint64,
) (ports.NetworkPolicyAssignment, error) {
	return client.callPolicyAssignment(
		ctx, http.MethodPut, assignment, expectedResourceVersion, "assign_agent_policy",
	)
}

func (client *Client) callPolicyAssignment(
	ctx context.Context,
	method string,
	assignment ports.NetworkPolicyAssignment,
	expectedResourceVersion uint64,
	operation string,
) (result ports.NetworkPolicyAssignment, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := tracer.Start(
		ctx, "agent_controller.egress."+operation,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("server.address", client.baseURL.Hostname()),
			attribute.String("antnest.agent.id", assignment.AgentID),
			attribute.String("rpc.system", "http_json"),
		),
	)
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, dependencyCode(resultErr))
		}
		span.End()
	}()

	var body io.Reader = http.NoBody
	if method == http.MethodPut {
		payload, err := json.Marshal(struct {
			PolicyID                string `json:"policy_id"`
			Revision                uint64 `json:"revision"`
			ExpectedResourceVersion uint64 `json:"expected_resource_version"`
		}{
			PolicyID: assignment.PolicyID, Revision: assignment.Revision,
			ExpectedResourceVersion: expectedResourceVersion,
		})
		if err != nil {
			return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_request", false)
		}
		body = bytes.NewReader(payload)
	}
	endpoint := *client.baseURL
	endpoint.Path = "/internal/agent-policy-assignments/" + url.PathEscape(assignment.AgentID)
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), body)
	if err != nil {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_request", false)
	}
	if method == http.MethodPut {
		request.Header.Set("Content-Type", "application/json")
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("control_plane_unavailable", true)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(payload) > maximumResponseBytes {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_response", true)
	}
	if response.StatusCode != http.StatusOK {
		return ports.NetworkPolicyAssignment{}, decodeFailure(payload, response.StatusCode)
	}
	if err := json.Unmarshal(payload, &result); err != nil ||
		result.AgentID != assignment.AgentID || strings.TrimSpace(result.PolicyID) == "" ||
		result.Revision == 0 || result.ResourceVersion == 0 {
		return ports.NetworkPolicyAssignment{}, dependencyFailure("invalid_response", true)
	}
	return result, nil
}

func (client *Client) readAgentNetwork(
	ctx context.Context,
	method string,
	agentID string,
	operation string,
	requireActive bool,
) (result ports.NetworkAttachment, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := tracer.Start(
		ctx, "agent_controller.egress."+operation,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("server.address", client.baseURL.Hostname()),
			attribute.String("antnest.agent.id", agentID),
			attribute.String("rpc.system", "http_json"),
		),
	)
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, dependencyCode(resultErr))
		}
		span.End()
	}()

	endpoint := *client.baseURL
	endpoint.Path = "/internal/agent-networks/" + url.PathEscape(agentID)
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), http.NoBody)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("control_plane_unavailable", true)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(body) > maximumResponseBytes {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true)
	}
	if response.StatusCode != http.StatusOK {
		return ports.NetworkAttachment{}, decodeFailure(body, response.StatusCode)
	}
	var payload struct {
		AgentID                string `json:"agent_id"`
		TunnelIPv4             string `json:"tunnel_ipv4"`
		ResolverIPv4           string `json:"resolver_ipv4"`
		PacketContractRevision uint32 `json:"packet_contract_revision"`
		EgressEndpoint         struct {
			IPv4 string `json:"ipv4"`
			Port uint16 `json:"port"`
		} `json:"egress_endpoint"`
		State string `json:"state"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.AgentID != agentID ||
		!validIPv4(payload.TunnelIPv4) || !validIPv4(payload.ResolverIPv4) ||
		!validIPv4(payload.EgressEndpoint.IPv4) || payload.EgressEndpoint.Port == 0 ||
		payload.PacketContractRevision == 0 || !validNetworkState(payload.State) ||
		(requireActive && payload.State != "active") {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true)
	}
	return ports.NetworkAttachment{
		AgentID: payload.AgentID, TunnelIPv4: payload.TunnelIPv4,
		ResolverIPv4:           payload.ResolverIPv4,
		PacketContractRevision: payload.PacketContractRevision,
		EgressIPv4:             payload.EgressEndpoint.IPv4, EgressPort: payload.EgressEndpoint.Port,
		State: payload.State,
	}, nil
}

func (client *Client) postAgentNetworkAction(
	ctx context.Context, agentID string, action string, operation string,
) (resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := tracer.Start(
		ctx, "agent_controller.egress."+operation,
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("server.address", client.baseURL.Hostname()),
			attribute.String("antnest.agent.id", agentID),
			attribute.String("rpc.system", "http_json"),
		),
	)
	defer func() {
		if resultErr != nil {
			span.SetStatus(codes.Error, dependencyCode(resultErr))
		}
		span.End()
	}()

	endpoint := *client.baseURL
	endpoint.Path = "/internal/agent-networks/" + url.PathEscape(agentID) + "/" + action
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), http.NoBody)
	if err != nil {
		return dependencyFailure("invalid_request", false)
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		return dependencyFailure("control_plane_unavailable", true)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(body) > maximumResponseBytes {
		return dependencyFailure("invalid_response", true)
	}
	if response.StatusCode != http.StatusNoContent {
		return decodeFailure(body, response.StatusCode)
	}
	if len(body) != 0 {
		return dependencyFailure("invalid_response", true)
	}
	return nil
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
	return &ports.DependencyError{Service: "runtime-egress", Code: code, Retryable: retryable}
}

func dependencyCode(err error) string {
	if failure, ok := err.(*ports.DependencyError); ok {
		return failure.Code
	}
	return "dependency_error"
}

func validIPv4(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && address.Is4()
}

func validNetworkState(value string) bool {
	return value == "active" || value == "quarantined"
}

var _ ports.EgressClient = (*Client)(nil)
