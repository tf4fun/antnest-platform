package agentacp

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

type Service interface {
	GetWorkspaceState(context.Context, WorkspaceStateInput) (WorkspaceState, error)
	WatchWorkspaceState(context.Context, WorkspaceStateInput, WorkspaceStateEmitter) error
}

type Client struct {
	base       *url.URL
	httpClient *http.Client
}

func NewClient(rawBaseURL string, httpClient *http.Client) (*Client, error) {
	base, err := url.Parse(strings.TrimSpace(rawBaseURL))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return nil, fmt.Errorf("agent ACP URL is invalid")
	}
	if httpClient == nil {
		return nil, fmt.Errorf("agent ACP HTTP client is required")
	}
	return &Client{base: base, httpClient: httpClient}, nil
}

var _ Service = (*Client)(nil)
