// Package tunnelclient sends only the private Egress generation registration.
// It intentionally has no request/response content tracing or error-body logging.
package tunnelclient

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

type Client struct {
	endpoint string
	http     *http.Client
	timeout  time.Duration
}

func New(endpoint string, client *http.Client, timeout time.Duration) (*Client, error) {
	parsed, err := url.ParseRequestURI(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" || parsed.Scheme != "http" && parsed.Scheme != "https" || client == nil || timeout <= 0 {
		return nil, instanceauth.ErrTunnelRegistrationRejected
	}
	copyClient := *client
	copyClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &Client{endpoint: strings.TrimRight(endpoint, "/") + "/internal/agent-tunnel-keys/", http: &copyClient, timeout: timeout}, nil
}
func (c *Client) Register(ctx context.Context, agent string, value instanceauth.TunnelRegistration) error {
	if agent == "" || len(agent) > 200 || url.PathEscape(agent) != agent {
		return instanceauth.ErrTunnelRegistrationRejected
	}
	body, err := json.Marshal(value)
	if err != nil {
		return instanceauth.ErrTunnelRegistrationRejected
	}
	defer clear(body)
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, c.endpoint+agent, bytes.NewReader(body))
	if err != nil {
		return instanceauth.ErrTunnelRegistrationRejected
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := c.http.Do(request)
	if err != nil {
		return instanceauth.ErrTunnelRegistrationUnavailable
	}
	defer func() { _ = response.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 1024))
	if response.StatusCode == 200 || response.StatusCode == 204 {
		return nil
	}
	if response.StatusCode >= 500 || response.StatusCode == 429 {
		return instanceauth.ErrTunnelRegistrationUnavailable
	}
	return instanceauth.ErrTunnelRegistrationRejected
}
