package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

const acpIncarnationResponseLimit = 1 << 20

// AcpIncarnationPlatform observes Docker process facts without changing the
// existing Runtime client or treating an incomplete response as stop evidence.
type AcpIncarnationPlatform struct {
	client     *Client
	httpClient *http.Client
}

func NewAcpIncarnationPlatform(client *Client) (*AcpIncarnationPlatform, error) {
	if client == nil || client.httpClient == nil {
		return nil, errors.New("Docker client is required for ACP incarnation observations")
	}
	private := *client.httpClient
	private.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &AcpIncarnationPlatform{client: client, httpClient: &private}, nil
}

func (p *AcpIncarnationPlatform) EngineID(ctx context.Context) (string, error) {
	var response struct {
		ID string `json:"ID"`
	}
	if err := p.readJSON(ctx, "/info", false, &response); err != nil {
		return "", err
	}
	if response.ID == "" || len(response.ID) > 256 || strings.TrimSpace(response.ID) != response.ID {
		return "", errors.New("Docker engine identity is invalid")
	}
	return response.ID, nil
}

func (p *AcpIncarnationPlatform) Inspect(ctx context.Context, selector, network string) (acpincarnation.Observation, error) {
	var response struct {
		ID    string `json:"Id"`
		State struct {
			Running   *bool  `json:"Running"`
			StartedAt string `json:"StartedAt"`
		} `json:"State"`
		NetworkSettings struct {
			Networks map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
		} `json:"NetworkSettings"`
	}
	if err := p.readJSON(ctx, "/containers/"+url.PathEscape(selector)+"/json", true, &response); err != nil {
		return acpincarnation.Observation{}, err
	}
	if !validAcpIncarnationContainerID(response.ID) || response.State.Running == nil {
		return acpincarnation.Observation{}, errors.New("Docker container process identity is invalid")
	}
	started, err := time.Parse(time.RFC3339Nano, response.State.StartedAt)
	if err != nil || started.IsZero() {
		return acpincarnation.Observation{}, errors.New("Docker container start identity is invalid")
	}
	address := response.NetworkSettings.Networks[network].IPAddress
	if address != "" {
		parsed, err := netip.ParseAddr(address)
		if err != nil || parsed.Unmap().IsUnspecified() || parsed.Unmap().IsMulticast() || parsed.Zone() != "" {
			return acpincarnation.Observation{}, errors.New("Docker container probe address is invalid")
		}
	}
	return acpincarnation.Observation{
		ContainerID: response.ID,
		StartedAt:   started.UTC().Format(time.RFC3339Nano),
		Address:     address,
		Running:     *response.State.Running,
	}, nil
}

func (p *AcpIncarnationPlatform) readJSON(ctx context.Context, path string, container bool, target any) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, p.client.baseURL+"/"+dockerAPIVersion+path, nil)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Docker incarnation request is invalid")
	}
	response, requestErr := p.httpClient.Do(request)
	if response == nil || response.Body == nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New("Docker incarnation request failed")
	}

	// Read and close the actual body before interpreting even an HTTP 404. Error
	// messages intentionally exclude the request URL and Docker response contents.
	raw, readErr := io.ReadAll(io.LimitReader(response.Body, acpIncarnationResponseLimit+1))
	closeErr := response.Body.Close()
	var failures []error
	if ctx.Err() != nil {
		failures = append(failures, ctx.Err())
	}
	if requestErr != nil {
		failures = append(failures, errors.New("Docker incarnation request failed"))
	}
	if readErr != nil {
		failures = append(failures, errors.New("Docker incarnation response body could not be read"))
	}
	if closeErr != nil {
		failures = append(failures, errors.New("Docker incarnation response body could not be closed"))
	}
	if len(failures) != 0 {
		return errors.Join(failures...)
	}
	if len(raw) > acpIncarnationResponseLimit {
		return errors.New("Docker incarnation response exceeds the body limit")
	}
	if response.StatusCode == http.StatusNotFound && container {
		return acpincarnation.ErrContainerNotFound
	}
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("Docker incarnation request returned HTTP %d", response.StatusCode)
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return errors.New("Docker incarnation response is invalid JSON")
	}
	return nil
}

func validAcpIncarnationContainerID(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, character := range value {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return false
		}
	}
	return true
}
