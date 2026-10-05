package providerdiscovery

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/outbound"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

const maximumResponseBytes = 8 << 20

type Client struct{ http *http.Client }

func New(timeout time.Duration, policy *outbound.Policy) *Client {
	transport := outbound.NewTransport(policy)
	return &Client{http: telemetry.HTTPClient(&http.Client{Timeout: timeout, Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, "model-provider")}
}

func (client *Client) CloseIdleConnections() { client.http.CloseIdleConnections() }

func (client *Client) ListModels(ctx context.Context, connection Connection, secret string) (_ []Model, resultErr error) {
	ctx, call := telemetry.StartHTTPCall(ctx, "DiscoverModels", nil)
	defer func() { call.Finish(resultErr) }()
	if !Supports(connection.ProviderKey) {
		return nil, ports.ErrProviderDiscoveryFailed
	}
	endpoint, err := url.Parse(connection.BaseURL)
	if err != nil || endpoint == nil || endpoint.Hostname() == "" || (endpoint.Scheme != "https" && endpoint.Scheme != "http") || endpoint.User != nil || endpoint.RawQuery != "" || endpoint.Fragment != "" {
		return nil, ports.ErrProviderEndpointForbidden
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/models"
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint.String(), nil)
	if err != nil {
		return nil, ports.ErrProviderEndpointForbidden
	}
	request.Header.Set("Authorization", "Bearer "+secret)
	request.Header.Set("Accept", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		if errors.Is(err, ports.ErrProviderEndpointForbidden) {
			return nil, ports.ErrProviderEndpointForbidden
		}
		if errors.Is(err, ports.ErrProviderEndpointUnavailable) {
			return nil, ports.ErrProviderEndpointUnavailable
		}
		return nil, ports.ErrProviderDiscoveryFailed
	}
	defer func() {
		if err := response.Body.Close(); err != nil && resultErr == nil {
			resultErr = ports.ErrProviderDiscoveryFailed
		}
	}()
	if response.StatusCode != http.StatusOK {
		return nil, ports.ErrProviderDiscoveryFailed
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maximumResponseBytes+1))
	if err != nil || len(body) > maximumResponseBytes {
		return nil, ports.ErrProviderDiscoveryFailed
	}
	models, err := decodeModels(body)
	if err != nil {
		return nil, ports.ErrProviderDiscoveryFailed
	}
	return models, nil
}

type remoteModel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Context     *int   `json:"context_length"`
	TopProvider struct {
		Output *int `json:"max_completion_tokens"`
	} `json:"top_provider"`
	Architecture struct {
		Inputs []string `json:"input_modalities"`
	} `json:"architecture"`
	Pricing remotePricing `json:"pricing"`
}

func decodeModels(body []byte) ([]Model, error) {
	var envelope struct {
		Data []remoteModel `json:"data"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil || envelope.Data == nil {
		return nil, fmt.Errorf("invalid provider model list")
	}
	models := make([]Model, 0, len(envelope.Data))
	seen := make(map[string]bool)
	for _, remote := range envelope.Data {
		if strings.TrimSpace(remote.ID) == "" {
			return nil, fmt.Errorf("provider model list contains an invalid identifier")
		}
		if seen[remote.ID] {
			continue
		}
		seen[remote.ID] = true
		models = append(models, remote.candidate())
	}
	return models, nil
}

func (remote remoteModel) candidate() Model {
	model := Model{ModelID: remote.ID, DisplayName: remote.Name, ContextWindow: positive(remote.Context), MaxOutputTokens: positive(remote.TopProvider.Output), Pricing: modelPricing(remote.Pricing)}
	if strings.TrimSpace(model.DisplayName) == "" {
		model.DisplayName = remote.ID
	}
	if remote.Architecture.Inputs != nil {
		images := slices.Contains(remote.Architecture.Inputs, "image")
		model.SupportsImages = &images
	}
	return model
}

func positive(value *int) *int {
	if value == nil || *value <= 0 {
		return nil
	}
	return value
}
