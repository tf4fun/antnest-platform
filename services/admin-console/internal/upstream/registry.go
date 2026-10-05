package upstream

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/telemetry"
)

// RegistryClient is the Console's internal-only connection to Skill Registry.
// It forwards verified caller context, never browser credentials or identity hints.
type RegistryClient struct {
	base *url.URL
	http *http.Client
}

func NewRegistryClient(rawURL string, source *http.Client) (*RegistryClient, error) {
	base, err := parseServiceURL("Skill Registry", rawURL)
	if err != nil || source == nil {
		return nil, fmt.Errorf("skill registry connection is invalid")
	}
	client := *source
	client.Transport = telemetry.NewHTTPTransport(client.Transport)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &RegistryClient{base: base, http: &client}, nil
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
	callercontext.Forward(ctx, request.Header)
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
