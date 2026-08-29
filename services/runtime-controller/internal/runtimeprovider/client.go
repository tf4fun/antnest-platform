package runtimeprovider

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

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

type Client struct {
	httpClient *http.Client
	baseURL    string
}

func New(httpClient *http.Client, baseURL string) (*Client, error) {
	if httpClient == nil || strings.TrimSpace(baseURL) == "" {
		return nil, fmt.Errorf("Runtime Provider HTTP client and base URL are required")
	}
	return &Client{httpClient: httpClient, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

func DefaultHTTPClient() *http.Client {
	return &http.Client{Timeout: 45 * time.Second}
}

func (c *Client) Ready(ctx context.Context) error {
	_, err := c.do(ctx, http.MethodGet, "/readyz", nil)
	return err
}

func (c *Client) Ensure(ctx context.Context, input application.EnsureRequest) application.DriverResult {
	return c.dispatch(ctx, http.MethodPut, runtimePath(input.AgentID), ensureRequest{
		AgentID: input.AgentID, Generation: input.Generation,
		RuntimeInstanceID: input.RuntimeInstanceID, ImageRef: input.ImageRef,
		NetworkMode: string(input.NetworkMode), NetworkPolicyEpoch: input.NetworkPolicyEpoch,
		TunnelIPv4: input.TunnelIPv4, AllocatorEpoch: input.AllocatorEpoch,
		AdvertisedEndpoint: input.AdvertisedEndpoint, EgressEndpoint: input.EgressEndpoint,
		ManagementNetwork: input.ManagementNetwork, DNSIPv4: input.DNSIPv4,
		BootstrapToken: input.BootstrapToken,
	})
}

func (c *Client) Stop(ctx context.Context, target application.RuntimeTarget) application.DriverResult {
	return c.dispatch(ctx, http.MethodPost, runtimePath(target.AgentID)+"/stop", mapTarget(target))
}

func (c *Client) Remove(
	ctx context.Context,
	target application.RuntimeTarget,
	purgeWorkspace bool,
) application.DriverResult {
	return c.dispatch(ctx, http.MethodPost, runtimePath(target.AgentID)+"/remove", removeRequest{
		Target: mapTarget(target), PurgeWorkspace: purgeWorkspace,
	})
}

func (c *Client) dispatch(
	ctx context.Context,
	method string,
	path string,
	input any,
) application.DriverResult {
	raw, err := c.do(ctx, method, path, input)
	if err != nil {
		return application.DriverResult{Outcome: domain.EffectOutcome{
			State: domain.EffectUnknown, Code: "runtime_provider_unavailable", Detail: err.Error(),
		}}
	}
	var result driverResult
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil {
		return application.DriverResult{Outcome: domain.EffectOutcome{
			State: domain.EffectUnknown, Code: "runtime_provider_invalid_response", Detail: err.Error(),
		}}
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			err = fmt.Errorf("response contains trailing JSON")
		}
		return application.DriverResult{Outcome: domain.EffectOutcome{
			State: domain.EffectUnknown, Code: "runtime_provider_invalid_response", Detail: err.Error(),
		}}
	}
	if err := result.Outcome.Validate(); err != nil {
		return application.DriverResult{Outcome: domain.EffectOutcome{
			State: domain.EffectUnknown, Code: "runtime_provider_invalid_response", Detail: err.Error(),
		}}
	}
	return application.DriverResult{Outcome: result.Outcome, ContainerID: result.ContainerID}
}

func (c *Client) do(ctx context.Context, method, path string, input any) ([]byte, error) {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return nil, fmt.Errorf("encode Runtime Provider request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, fmt.Errorf("create Runtime Provider request: %w", err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("Runtime Provider %s %s: %w", method, path, err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 128<<10))
	if err != nil {
		return nil, fmt.Errorf("read Runtime Provider response: %w", err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, fmt.Errorf("Runtime Provider %s %s returned %s: %s",
			method, path, response.Status, strings.TrimSpace(string(raw)))
	}
	return raw, nil
}

func runtimePath(agentID string) string {
	return "/internal/v1/runtimes/" + url.PathEscape(strings.TrimSpace(agentID))
}

type removeRequest struct {
	Target         runtimeTarget `json:"target"`
	PurgeWorkspace bool          `json:"purge_workspace"`
}

type ensureRequest struct {
	AgentID            string `json:"agent_id"`
	Generation         uint64 `json:"generation"`
	RuntimeInstanceID  string `json:"runtime_instance_id"`
	ImageRef           string `json:"image_ref"`
	NetworkMode        string `json:"network_mode"`
	NetworkPolicyEpoch uint64 `json:"network_policy_epoch"`
	TunnelIPv4         string `json:"tunnel_ipv4"`
	AllocatorEpoch     uint64 `json:"allocator_epoch"`
	AdvertisedEndpoint string `json:"advertised_endpoint"`
	EgressEndpoint     string `json:"egress_endpoint"`
	ManagementNetwork  string `json:"management_network"`
	DNSIPv4            string `json:"dns_ipv4"`
	BootstrapToken     string `json:"bootstrap_token"`
}

type runtimeTarget struct {
	AgentID           string `json:"agent_id"`
	Generation        uint64 `json:"generation"`
	RuntimeInstanceID string `json:"runtime_instance_id"`
	ContainerID       string `json:"container_id,omitempty"`
}

type driverResult struct {
	Outcome     domain.EffectOutcome `json:"outcome"`
	ContainerID string               `json:"container_id,omitempty"`
}

func mapTarget(target application.RuntimeTarget) runtimeTarget {
	return runtimeTarget{
		AgentID: target.AgentID, Generation: target.Generation,
		RuntimeInstanceID: target.RuntimeInstanceID, ContainerID: target.ContainerID,
	}
}
