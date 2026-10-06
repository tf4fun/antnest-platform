package mcpsecretclient

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type Client struct {
	endpoint string
	http     *http.Client
	timeout  time.Duration
}

func New(endpoint string, client *http.Client, timeout time.Duration) (*Client, error) {
	parsed, err := url.ParseRequestURI(endpoint)
	if err != nil || parsed.Host == "" || parsed.User != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.RawQuery != "" || parsed.Fragment != "" || client == nil || timeout <= 0 {
		return nil, errors.New("invalid managed MCP bootstrap client")
	}
	return &Client{endpoint: strings.TrimRight(endpoint, "/") + "/internal/managed-mcp-secrets/resolve", http: client, timeout: timeout}, nil
}

func (client *Client) Resolve(ctx context.Context, source *deployment.MCPTemplateSource, servers []deployment.MCPServer) (map[string]map[string]string, error) {
	if err := source.Validate(); err != nil {
		return nil, err
	}
	body, err := json.Marshal(source)
	if err != nil {
		return nil, errors.New("managed MCP bootstrap request invalid")
	}
	ctx, cancel := context.WithTimeout(ctx, client.timeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, client.endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, errors.New("managed MCP bootstrap request invalid")
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return nil, errors.New("managed MCP bootstrap dependency unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != 200 {
		return nil, errors.New("managed MCP bootstrap dependency rejected")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if err != nil || len(data) > 65536 {
		return nil, errors.New("managed MCP bootstrap response invalid")
	}
	var values map[string]map[string]string
	if serviceauth.DecodeObject(data, &values) != nil || deployment.ValidateMCPSecretValues(servers, values) != nil {
		return nil, errors.New("managed MCP bootstrap response verification failed")
	}
	return values, nil
}
