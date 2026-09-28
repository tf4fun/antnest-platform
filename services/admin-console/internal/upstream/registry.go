package upstream

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"soft/antnest-platform/services/admin-console/internal/telemetry"
)

// RegistryClient is the Console's internal-only connection to Skill Registry.
// It never forwards browser cookies, Authorization, or principal headers.
type RegistryClient struct {
	base  *url.URL
	token string
	http  *http.Client
}

func NewRegistryClient(rawURL, token string, source *http.Client) (*RegistryClient, error) {
	base, err := parseServiceURL("Skill Registry", rawURL)
	if err != nil || source == nil || len(token) < 32 || strings.TrimSpace(token) != token {
		return nil, fmt.Errorf("skill registry connection is invalid")
	}
	client := *source
	client.Transport = telemetry.NewHTTPTransport(client.Transport)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &RegistryClient{base: base, token: token, http: &client}, nil
}

func (client *RegistryClient) Do(ctx context.Context, method, path, query, contentType string, body []byte) (*http.Response, error) {
	if !strings.HasPrefix(path, "/internal/") || strings.Contains(path, "..") {
		return nil, fmt.Errorf("registry path is invalid")
	}
	if _, err := url.ParseQuery(query); err != nil {
		return nil, fmt.Errorf("registry query is invalid")
	}
	target := client.base.ResolveReference(&url.URL{Path: path, RawQuery: query})
	request, err := http.NewRequestWithContext(telemetry.WithTarget(ctx, "skill-registry"), method, target.String(), bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create Registry request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+client.token)
	request.Header.Set("Accept", "application/json")
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := client.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("skill registry unavailable: %w", err)
	}
	return response, nil
}
