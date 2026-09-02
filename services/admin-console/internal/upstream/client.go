package upstream

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

type Target string

const (
	Identity        Target = "identity-service"
	AgentController Target = "agent-controller"
)

var tracer = otel.Tracer("soft/antnest-platform/admin-console/upstream")

type Config struct {
	IdentityURL        string
	AgentControllerURL string
	HTTPClient         *http.Client
}

type Client struct {
	identity        *url.URL
	agentController *url.URL
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
	if config.HTTPClient == nil {
		return nil, fmt.Errorf("upstream HTTP client is required")
	}
	return &Client{identity: identityURL, agentController: agentURL, httpClient: config.HTTPClient}, nil
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
	ctx, span := tracer.Start(ctx, string(target)+" "+method, trace.WithSpanKind(trace.SpanKindClient))
	span.SetAttributes(
		attribute.String("rpc.system", "http"), attribute.String("server.address", base.Host),
		attribute.String("http.request.method", method), attribute.String("url.path", path),
	)
	targetURL := base.ResolveReference(&url.URL{Path: path, RawQuery: rawQuery})
	var reader io.Reader
	if len(body) > 0 {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, targetURL.String(), reader)
	if err != nil {
		span.End()
		return nil, fmt.Errorf("create upstream request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	otel.GetTextMapPropagator().Inject(ctx, propagation.HeaderCarrier(request.Header))
	response, err := client.httpClient.Do(request)
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, "transport failure")
		span.End()
		return nil, fmt.Errorf("%s unavailable: %w", target, err)
	}
	span.SetAttributes(attribute.Int("http.response.status_code", response.StatusCode))
	if response.StatusCode >= http.StatusInternalServerError {
		span.SetStatus(codes.Error, response.Status)
	}
	span.End()
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
	default:
		return nil, fmt.Errorf("unknown upstream target %q", target)
	}
}

func parseServiceURL(name, raw string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, fmt.Errorf("%s URL is invalid", name)
	}
	return parsed, nil
}
