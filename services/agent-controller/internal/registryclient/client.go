package registryclient

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

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type Client struct {
	baseURL string
	http    *http.Client
}

func New(baseURL string, timeout time.Duration, transport http.RoundTripper) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" || transport == nil {
		return nil, fmt.Errorf("skill registry endpoint and authenticated transport are required")
	}
	if timeout <= 0 {
		return nil, fmt.Errorf("skill registry timeout must be positive")
	}
	client := &http.Client{Timeout: timeout, Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	return &Client{baseURL: strings.TrimSuffix(baseURL, "/"), http: client}, nil
}

func (client *Client) Resolve(ctx context.Context, organizationID string, refs []domain.SkillReference) ([]domain.FrozenSkill, error) {
	payload, err := json.Marshal(struct {
		OrganizationID string                  `json:"organization_id"`
		Refs           []domain.SkillReference `json:"refs"`
	}{organizationID, refs})
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost,
		client.baseURL+"/internal/skill-versions/resolve", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	callercontext.Forward(ctx, request.Header)
	request.Header.Set("Content-Type", "application/json")
	response, err := client.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("skill registry resolve: %w", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode == http.StatusNotFound {
		return nil, ports.ErrSkillNotFound
	}
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("skill registry resolve returned HTTP %d", response.StatusCode)
	}
	var result struct {
		Items []domain.FrozenSkill `json:"items"`
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 32<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&result); err != nil || result.Items == nil {
		return nil, fmt.Errorf("skill registry returned invalid resolve result")
	}
	var trailing any
	if decoder.Decode(&trailing) != io.EOF {
		return nil, fmt.Errorf("skill registry returned trailing data")
	}
	return result.Items, nil
}
