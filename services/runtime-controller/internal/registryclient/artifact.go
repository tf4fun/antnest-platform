package registryclient

import (
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/skillset"
	"soft/antnest-platform/services/runtime-controller/internal/telemetry"
)

var (
	ErrNotFound         = errors.New("skill Registry version was not found")
	ErrUnavailable      = errors.New("skill Registry is temporarily unavailable")
	ErrUnauthorized     = errors.New("skill Registry authentication failed")
	ErrArtifactMismatch = errors.New("skill Registry artifact differs from frozen metadata")
)

type Client struct {
	baseURL, token string
	http           *http.Client
}

func New(baseURL, token string, timeout time.Duration, transport http.RoundTripper) (*Client, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil || parsed.Host == "" || parsed.Scheme != "http" && parsed.Scheme != "https" ||
		parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" || token == "" || timeout <= 0 {
		return nil, fmt.Errorf("skill Registry endpoint, token or timeout is invalid")
	}
	if transport == nil {
		transport = http.DefaultTransport
	}
	client := &http.Client{Timeout: timeout, Transport: telemetry.NewTransport(transport, "skill-registry"),
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	return &Client{baseURL: strings.TrimSuffix(baseURL, "/"), token: token, http: client}, nil
}

// Download accepts only the exact frozen ZIP bytes from the scoped immutable
// version. No redirect can carry the Registry bearer token to another host.
func (c *Client) Download(ctx context.Context, organizationID string, frozen skillset.FrozenSkill) ([]byte, skillset.Package, error) {
	if frozen.ArtifactSize < 1 || frozen.ArtifactSize > 8<<20 {
		return nil, skillset.Package{}, fmt.Errorf("%w: invalid frozen artifact size", ErrArtifactMismatch)
	}
	target := c.baseURL + "/internal/skills/" + url.PathEscape(frozen.SkillID) + "/versions/" + strconv.FormatInt(frozen.Version, 10) +
		"/artifact?organization_id=" + url.QueryEscape(organizationID)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return nil, skillset.Package{}, fmt.Errorf("%w: create artifact request: %w", ErrUnavailable, err)
	}
	request.Header.Set("Authorization", "Bearer "+c.token)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, skillset.Package{}, fmt.Errorf("%w: artifact request: %w", ErrUnavailable, err)
	}
	defer func() { _ = response.Body.Close() }()
	switch response.StatusCode {
	case http.StatusOK:
	case http.StatusNotFound:
		return nil, skillset.Package{}, ErrNotFound
	case http.StatusUnauthorized, http.StatusForbidden:
		return nil, skillset.Package{}, ErrUnauthorized
	default:
		return nil, skillset.Package{}, fmt.Errorf("%w: artifact returned HTTP %d", ErrUnavailable, response.StatusCode)
	}
	mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/zip" || response.ContentLength != frozen.ArtifactSize ||
		response.Header.Get("X-Antnest-Artifact-Digest") != frozen.ArtifactDigest {
		return nil, skillset.Package{}, fmt.Errorf("%w: response identity headers differ", ErrArtifactMismatch)
	}
	artifact, err := io.ReadAll(io.LimitReader(response.Body, frozen.ArtifactSize+1))
	if err != nil {
		return nil, skillset.Package{}, fmt.Errorf("%w: read artifact: %w", ErrUnavailable, err)
	}
	if int64(len(artifact)) != frozen.ArtifactSize {
		return nil, skillset.Package{}, fmt.Errorf("%w: artifact size differs", ErrArtifactMismatch)
	}
	pkg, err := skillset.ValidateFrozenArtifact(ctx, artifact, frozen)
	if err != nil {
		return nil, skillset.Package{}, fmt.Errorf("%w: %v", ErrArtifactMismatch, err)
	}
	return artifact, pkg, nil
}
