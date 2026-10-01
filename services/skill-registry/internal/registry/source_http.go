package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/skill-registry/internal/telemetry"
)

type HTTPAgentSource struct {
	origin string
	token  string
	client *http.Client
}

func NewHTTPAgentSource(origin, token string) (*HTTPAgentSource, error) {
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") ||
		len(token) < 32 || strings.TrimSpace(token) != token || strings.ContainsAny(token, "\r\n") {
		return nil, failure("invalid_request", "invalid private Skill source configuration")
	}
	return &HTTPAgentSource{origin: strings.TrimRight(origin, "/"), token: token, client: telemetry.HTTPClient(&http.Client{
		Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse },
	}, "agent-acp-service")}, nil
}
func (s *HTTPAgentSource) post(ctx context.Context, path string, in any, max int64) ([]byte, http.Header, error) {
	data, err := json.Marshal(in)
	if err != nil {
		return nil, nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, s.origin+path, bytes.NewReader(data))
	if err != nil {
		return nil, nil, failure("source_unavailable", "Agent Skill source is unavailable")
	}
	request.Header.Set("Authorization", "Bearer "+s.token)
	request.Header.Set("Content-Type", "application/json")
	response, err := s.client.Do(request)
	if err != nil {
		return nil, nil, failure("source_unavailable", "Agent Skill source is unavailable")
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusOK {
		if path == "/internal/skill-sources/artifact" && (response.StatusCode == 403 || response.StatusCode == 404) {
			return nil, nil, failure("not_found", "Skill source not found")
		}
		if response.StatusCode == 409 {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			var payload struct {
				Error struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"error"`
			}
			if decodeOne(body, &payload) == nil && payload.Error.Code == "content_changed" {
				return nil, nil, failure("content_changed", "Skill source content changed; choose again")
			}
		}
		return nil, nil, failure("source_unavailable", "Agent Skill source is unavailable")
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, max+1))
	if err != nil {
		return nil, nil, failure("source_unavailable", "Agent Skill source response was interrupted")
	}
	if int64(len(body)) > max || len(body) == 0 {
		return nil, nil, failure("source_invalid", "Skill source response exceeds its limit")
	}
	kind, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	expected := "application/json"
	if path == "/internal/skill-sources/artifact" {
		expected = "application/zip"
	}
	if err != nil || kind != expected {
		return nil, nil, failure("source_invalid", "invalid Skill source content type")
	}
	if expected == "application/zip" && response.ContentLength != int64(len(body)) {
		return nil, nil, failure("source_invalid", "invalid source artifact length")
	}
	return body, response.Header, nil
}
func (s *HTTPAgentSource) Inspect(ctx context.Context, org, actor string, keys []SourceKey) ([]Projection, error) {
	in := struct {
		OrganizationID string      `json:"organization_id"`
		ActorID        string      `json:"actor_id"`
		Sources        []SourceKey `json:"sources"`
	}{org, actor, keys}
	data, _, err := s.post(ctx, "/internal/skill-sources/inspect", in, 128<<10)
	if err != nil {
		return nil, err
	}
	var result struct {
		Items []Projection `json:"items"`
	}
	if err := decodeOne(data, &result); err != nil || result.Items == nil || len(result.Items) > MaxDiscoveryLimit {
		return nil, failure("source_invalid", "invalid source inspection")
	}
	return result.Items, nil
}
func (s *HTTPAgentSource) Artifact(ctx context.Context, in SourceArtifactInput) ([]byte, error) {
	data, headers, err := s.post(ctx, "/internal/skill-sources/artifact", in, MaxArtifactBytes)
	if err != nil {
		return nil, err
	}
	if headers.Get("X-Antnest-Source-Sequence") != strconv.FormatInt(in.SkillRef.Sequence, 10) || headers.Get("X-Antnest-Content-Digest") != in.ExpectedDigest {
		return nil, failure("content_changed", "Skill source content changed; choose again")
	}
	if headers.Get("X-Antnest-Artifact-Digest") != digest(data) {
		return nil, failure("source_invalid", "source artifact digest does not match bytes")
	}
	return data, nil
}
