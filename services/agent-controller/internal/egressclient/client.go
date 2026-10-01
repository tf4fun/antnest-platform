package egressclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"go.opentelemetry.io/otel/attribute"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

const maximumResponseBytes = 1 << 20

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
	return &Client{
		baseURL: endpoint, httpClient: telemetry.HTTPClient(httpClient, "runtime-egress"), timeout: timeout,
	}, nil
}

func (client *Client) EnsureAgentNetwork(
	ctx context.Context, agentID string,
) (result ports.NetworkAttachment, resultErr error) {
	return client.readAgentNetwork(ctx, http.MethodPut, agentID, "ensure_agent_network", true)
}

func (client *Client) GetAgentNetwork(
	ctx context.Context, agentID string,
) (result ports.NetworkAttachment, resultErr error) {
	resultErr = client.policyRequest(ctx, http.MethodGet, "/internal/agent-networks/"+url.PathEscape(agentID), "get_agent_network", agentID, nil, func(payload []byte) error {
		var err error
		result, err = decodeNetworkAttachment(payload, agentID, "")
		if err != nil {
			return dependencyFailure("invalid_response", true)
		}
		return nil
	})
	return result, resultErr
}

func (client *Client) SetAgentNetworkAttachment(
	ctx context.Context,
	agentID string,
	state string,
	expectedResourceVersion uint64,
) (ports.NetworkAttachment, error) {
	if state != ports.NetworkAttachmentClosed && state != ports.NetworkAttachmentOpen {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	payload, err := json.Marshal(struct {
		State                   string `json:"state"`
		ExpectedResourceVersion uint64 `json:"expected_resource_version"`
	}{State: state, ExpectedResourceVersion: expectedResourceVersion})
	if err != nil || expectedResourceVersion == 0 {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	return client.writeAgentNetwork(
		ctx,
		agentID,
		"set_agent_network_attachment",
		"/internal/agent-network-attachments/"+url.PathEscape(agentID),
		bytes.NewReader(payload),
		state,
	)
}

func (client *Client) ReleaseAgentNetwork(
	ctx context.Context, agentID string, expectedResourceVersion uint64,
) (ports.NetworkAttachment, error) {
	return client.readAgentNetworkAction(
		ctx, agentID, "release", "release_agent_network", "quarantined", expectedResourceVersion,
	)
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
	ctx, span := telemetry.StartHTTPCall(ctx, operation, []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()

	endpoint := *client.baseURL
	endpoint.Path = "/internal/agent-networks/" + url.PathEscape(agentID)
	request, err := http.NewRequestWithContext(ctx, method, endpoint.String(), http.NoBody)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(body) > maximumResponseBytes {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true, err, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return ports.NetworkAttachment{}, decodeFailure(body, response.StatusCode)
	}
	requiredState := ""
	if requireActive {
		requiredState = "active"
	}
	result, err = decodeNetworkAttachment(body, agentID, requiredState)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true)
	}
	return result, nil
}

func (client *Client) readAgentNetworkAction(
	ctx context.Context,
	agentID string,
	action string,
	operation string,
	requiredState string,
	expectedResourceVersion uint64,
) (result ports.NetworkAttachment, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, operation, []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()

	endpoint := *client.baseURL
	endpoint.Path = "/internal/agent-networks/" + url.PathEscape(agentID) + "/" + action
	requestBody, err := resourceVersionBody(expectedResourceVersion)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), requestBody)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true, err, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return ports.NetworkAttachment{}, decodeFailure(responseBody, response.StatusCode)
	}
	result, err = decodeNetworkAttachment(responseBody, agentID, requiredState)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true)
	}
	return result, nil
}

func (client *Client) writeAgentNetwork(
	ctx context.Context,
	agentID string,
	operation string,
	path string,
	body io.Reader,
	requiredAttachmentState string,
) (result ports.NetworkAttachment, resultErr error) {
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	ctx, span := telemetry.StartHTTPCall(ctx, operation, []attribute.KeyValue{attribute.String("antnest.agent.id", agentID)})
	defer func() { span.Finish(resultErr) }()

	endpoint := *client.baseURL
	endpoint.Path = path
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, endpoint.String(), body)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_request", false)
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.httpClient.Do(request)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("control_plane_unavailable", true, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	closeErr := response.Body.Close()
	if err != nil || closeErr != nil || len(responseBody) > maximumResponseBytes {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true, err, closeErr)
	}
	if response.StatusCode != http.StatusOK {
		return ports.NetworkAttachment{}, decodeFailure(responseBody, response.StatusCode)
	}
	result, err = decodeNetworkAttachment(
		responseBody, agentID, ports.NetworkStateActive, requiredAttachmentState,
	)
	if err != nil {
		return ports.NetworkAttachment{}, dependencyFailure("invalid_response", true)
	}
	return result, nil
}

func resourceVersionBody(expectedResourceVersion uint64) (io.Reader, error) {
	if expectedResourceVersion == 0 {
		return nil, fmt.Errorf("expected resource version must be positive")
	}
	payload, err := json.Marshal(struct {
		ExpectedResourceVersion uint64 `json:"expected_resource_version"`
	}{ExpectedResourceVersion: expectedResourceVersion})
	if err != nil {
		return nil, err
	}
	return bytes.NewReader(payload), nil
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
	return &ports.DependencyError{Service: "runtime-egress", Code: code, Retryable: retryable, Cause: errors.Join(causes...)}
}

func validIPv4(value string) bool {
	address, err := netip.ParseAddr(value)
	return err == nil && address.Is4()
}

func validNetworkState(value string) bool {
	return value == ports.NetworkStateActive || value == ports.NetworkStateQuarantined
}

func validAttachmentState(value string) bool {
	return value == ports.NetworkAttachmentClosed || value == ports.NetworkAttachmentOpen
}

func decodeNetworkAttachment(
	body []byte, agentID string, requiredState string, requiredAttachmentState ...string,
) (ports.NetworkAttachment, error) {
	var payload struct {
		AgentID                string `json:"agent_id"`
		TunnelIPv4             string `json:"tunnel_ipv4"`
		ResolverIPv4           string `json:"resolver_ipv4"`
		PacketContractRevision uint32 `json:"packet_contract_revision"`
		EgressEndpoint         struct {
			IPv4 string `json:"ipv4"`
			Port uint16 `json:"port"`
		} `json:"egress_endpoint"`
		State                     string `json:"state"`
		NetworkResourceVersion    uint64 `json:"network_resource_version"`
		AttachmentState           string `json:"attachment_state"`
		AttachmentResourceVersion uint64 `json:"attachment_resource_version"`
	}
	expectedAttachmentState := ""
	if len(requiredAttachmentState) > 0 {
		expectedAttachmentState = requiredAttachmentState[0]
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.AgentID != agentID ||
		!validIPv4(payload.TunnelIPv4) || !validIPv4(payload.ResolverIPv4) ||
		!validIPv4(payload.EgressEndpoint.IPv4) || payload.EgressEndpoint.Port == 0 ||
		payload.PacketContractRevision == 0 || !validNetworkState(payload.State) ||
		payload.NetworkResourceVersion == 0 || !validAttachmentState(payload.AttachmentState) ||
		payload.AttachmentResourceVersion == 0 ||
		(requiredState != "" && payload.State != requiredState) ||
		(expectedAttachmentState != "" && payload.AttachmentState != expectedAttachmentState) {
		return ports.NetworkAttachment{}, fmt.Errorf("invalid Agent network attachment")
	}
	return ports.NetworkAttachment{
		AgentID: payload.AgentID, TunnelIPv4: payload.TunnelIPv4,
		ResolverIPv4:           payload.ResolverIPv4,
		PacketContractRevision: payload.PacketContractRevision,
		EgressIPv4:             payload.EgressEndpoint.IPv4, EgressPort: payload.EgressEndpoint.Port,
		State: payload.State, NetworkResourceVersion: payload.NetworkResourceVersion,
		AttachmentState:           payload.AttachmentState,
		AttachmentResourceVersion: payload.AttachmentResourceVersion,
	}, nil
}

var _ ports.EgressClient = (*Client)(nil)
