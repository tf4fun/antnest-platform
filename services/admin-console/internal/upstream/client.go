package upstream

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/telemetry"
)

type Target string

const (
	Identity        Target = "identity-service"
	AgentController Target = "agent-controller"
	AgentACP        Target = "agent-acp-service"
)

type Config struct {
	IdentityURL        string
	AgentControllerURL string
	AgentACPURL        string
	HTTPClient         *http.Client
}

type Client struct {
	identity        *url.URL
	agentController *url.URL
	agentACP        *url.URL
	httpClient      *http.Client
}

func NewClient(config Config) (*Client, error) {
	identityURL, err := parseServiceURL("Identity Service", config.IdentityURL)
	if err != nil {
		return nil, err
	}
	agentURL, err := parseServiceURL("Agent Controller", config.AgentControllerURL)
	if err != nil {
		return nil, err
	}
	acpURL, err := parseServiceURL("Agent ACP Service", config.AgentACPURL)
	if err != nil {
		return nil, err
	}
	if config.HTTPClient == nil {
		return nil, fmt.Errorf("upstream HTTP client is required")
	}
	httpClient := *config.HTTPClient
	httpClient.Transport = telemetry.NewHTTPTransport(httpClient.Transport)
	httpClient.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{identity: identityURL, agentController: agentURL, agentACP: acpURL, httpClient: &httpClient}, nil
}

func (client *Client) Do(
	ctx context.Context,
	target Target,
	method string,
	path string,
	rawQuery string,
	body []byte,
) (*http.Response, error) {
	base, err := client.target(target)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(path, "/") || strings.Contains(path, "..") {
		return nil, fmt.Errorf("upstream path is invalid")
	}
	if _, err := url.ParseQuery(rawQuery); err != nil {
		return nil, fmt.Errorf("upstream query is invalid")
	}
	ctx = telemetry.WithTarget(ctx, string(target))
	targetURL := base.ResolveReference(&url.URL{Path: path, RawQuery: rawQuery})
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, targetURL.String(), reader)
	if err != nil {
		return nil, fmt.Errorf("create upstream request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if target == AgentACP {
		if err := applyAuditPrincipal(request); err != nil {
			return nil, err
		}
	}
	response, err := client.httpClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("%s unavailable: %w", target, err)
	}
	return response, nil
}

func (client *Client) Ready(ctx context.Context, target Target) error {
	response, err := client.Do(ctx, target, http.MethodGet, "/status", "", nil)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("%s status returned %s", target, response.Status)
	}
	return nil
}

func (client *Client) target(target Target) (*url.URL, error) {
	switch target {
	case Identity:
		return client.identity, nil
	case AgentController:
		return client.agentController, nil
	case AgentACP:
		return client.agentACP, nil
	default:
		return nil, fmt.Errorf("unknown upstream target %q", target)
	}
}

func applyAuditPrincipal(request *http.Request) error {
	actor, ok := principal.FromContext(request.Context())
	if !ok || !actor.Administrator() {
		return fmt.Errorf("ACP audit request requires a trusted administrator")
	}
	headers, err := actor.Headers()
	if err != nil {
		return err
	}
	for name, values := range headers {
		request.Header[name] = values
	}
	return nil
}

func parseServiceURL(name, raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s URL is invalid", name)
	}
	return parsed, nil
}
