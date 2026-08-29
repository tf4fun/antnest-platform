package egressclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
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
		return nil, fmt.Errorf("egress HTTP client and base URL are required")
	}
	return &Client{httpClient: httpClient, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

func (c *Client) Apply(ctx context.Context, request application.NetworkRequest) domain.EffectOutcome {
	if request.Mode == domain.NetworkRestricted {
		return domain.EffectOutcome{State: domain.EffectCompleted}
	}
	if err := validateNetworkRequest(request); err != nil {
		return failed(domain.EffectNotStarted, "invalid_network_policy", err)
	}
	body := reservation{
		RuntimeInstanceID: request.RuntimeInstanceID,
		Generation:        request.Generation,
		AgentID:           request.AgentID,
		VirtualIP:         request.TunnelIPv4,
		AllocatorEpoch:    request.AllocatorEpoch,
		NetworkMode:       string(request.Mode),
		PolicyEpoch:       request.PolicyEpoch,
		PolicyRevision:    request.PolicyEpoch,
	}
	path := reservationPath(request.RuntimeInstanceID, request.Generation)
	if err := c.do(ctx, http.MethodPut, path, body); err != nil {
		return failed(domain.EffectUnknown, "egress_reservation_failed", err)
	}
	return domain.EffectOutcome{State: domain.EffectCompleted}
}

func (c *Client) Release(ctx context.Context, target application.RuntimeTarget) domain.EffectOutcome {
	if strings.TrimSpace(target.RuntimeInstanceID) == "" || target.Generation == 0 {
		return domain.EffectOutcome{State: domain.EffectCompleted}
	}
	if err := c.do(ctx, http.MethodDelete, reservationPath(target.RuntimeInstanceID, target.Generation), nil); err != nil {
		return failed(domain.EffectUnknown, "egress_release_failed", err)
	}
	return domain.EffectOutcome{State: domain.EffectCompleted}
}

func (c *Client) Ready(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, "/readyz", nil)
}

func (c *Client) do(ctx context.Context, method, path string, input any) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode egress request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return fmt.Errorf("create egress request: %w", err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("egress %s %s: %w", method, path, err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("egress %s %s returned %s: %s",
			method, path, response.Status, strings.TrimSpace(string(detail)))
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}

func reservationPath(runtimeInstanceID string, generation uint64) string {
	return "/internal/v1/reservations/" + url.PathEscape(strings.TrimSpace(runtimeInstanceID)) +
		"/" + strconv.FormatUint(generation, 10)
}

func validateNetworkRequest(request application.NetworkRequest) error {
	if domain.ValidateAgentID(request.AgentID) != nil || strings.TrimSpace(request.RuntimeInstanceID) == "" ||
		request.Generation == 0 || strings.TrimSpace(request.TunnelIPv4) == "" ||
		request.AllocatorEpoch == 0 || request.PolicyEpoch == 0 || request.Mode != domain.NetworkUnrestricted {
		return fmt.Errorf("complete unrestricted Runtime network identity is required")
	}
	return nil
}

func failed(state domain.EffectState, code string, err error) domain.EffectOutcome {
	return domain.EffectOutcome{State: state, Code: code, Detail: err.Error()}
}

type reservation struct {
	RuntimeInstanceID string `json:"runtime_instance_id"`
	Generation        uint64 `json:"generation"`
	AgentID           string `json:"agent_id"`
	VirtualIP         string `json:"virtual_ip"`
	AllocatorEpoch    uint64 `json:"allocator_epoch"`
	NetworkMode       string `json:"network_mode"`
	PolicyEpoch       uint64 `json:"policy_epoch"`
	PolicyRevision    uint64 `json:"policy_revision"`
}

func DefaultHTTPClient() *http.Client {
	return &http.Client{Timeout: 15 * time.Second}
}
