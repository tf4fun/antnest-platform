package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/platform"
	"soft/antnest-platform/services/runtime-controller/internal/telemetry"
)

const dockerAPIVersion = "v1.47"

type Client struct {
	httpClient *http.Client
	baseURL    string
}

func NewUnixClient(socketPath string) (*Client, error) {
	socketPath = strings.TrimSpace(socketPath)
	if socketPath == "" {
		return nil, fmt.Errorf("docker socket path is required")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
		DisableCompression:    true,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	return NewHTTPClient(&http.Client{Transport: transport, Timeout: 30 * time.Second}, "http://docker")
}

func NewHTTPClient(httpClient *http.Client, baseURL string) (*Client, error) {
	if httpClient == nil || strings.TrimSpace(baseURL) == "" {
		return nil, fmt.Errorf("docker HTTP client and base URL are required")
	}
	observed := *httpClient
	observed.Transport = telemetry.NewTransport(httpClient.Transport, "docker")
	return &Client{httpClient: &observed, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

func (c *Client) Ping(ctx context.Context) error {
	return c.do(ctx, http.MethodGet, "/_ping", nil, nil)
}

func (c *Client) InspectContainer(ctx context.Context, identifier string) (Container, error) {
	var response inspectContainerResponse
	if err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(identifier)+"/json", nil, &response); err != nil {
		return Container{}, err
	}
	health := ""
	if response.State.Health != nil {
		health = response.State.Health.Status
	}
	return Container{
		ID: response.ID, Name: strings.TrimPrefix(response.Name, "/"),
		Running: response.State.Running, Health: health,
		Status: response.State.Status, ExitCode: response.State.ExitCode,
		OOMKilled: response.State.OOMKilled, Error: response.State.Error,
		RestartCount: response.RestartCount, Labels: response.Config.Labels,
		Mounts: observedMounts(response.Mounts, response.HostConfig.Mounts),
	}, nil
}

func observedMounts(actual []dockerObservedMount, requested []dockerMount) []ObservedMount {
	result := make([]ObservedMount, 0, len(actual))
	for _, mount := range actual {
		observed := ObservedMount{Type: mount.Type, Name: mount.Name, Destination: mount.Destination, ReadWrite: mount.RW}
		for _, wanted := range requested {
			if wanted.Target == mount.Destination && wanted.Source == mount.Name && wanted.VolumeOptions != nil {
				observed.NoCopy = wanted.VolumeOptions.NoCopy
			}
		}
		result = append(result, observed)
	}
	return result
}

func (c *Client) ListManagedContainers(ctx context.Context) ([]Container, error) {
	identifiers, err := c.ListManagedContainerIDs(ctx)
	if err != nil {
		return nil, err
	}
	result := make([]Container, 0, len(identifiers))
	for _, identifier := range identifiers {
		container, inspectErr := c.InspectContainer(ctx, identifier)
		if errors.Is(inspectErr, ErrNotFound) {
			continue
		}
		if inspectErr != nil {
			return nil, inspectErr
		}
		result = append(result, container)
	}
	return result, nil
}

func (c *Client) ListManagedContainerIDs(ctx context.Context) ([]string, error) {
	encodedFilters, err := json.Marshal(map[string][]string{"label": {labelManaged + "=runtime"}})
	if err != nil {
		return nil, fmt.Errorf("encode Docker filters: %w", err)
	}
	var summaries []struct {
		ID string `json:"Id"`
	}
	path := "/containers/json?all=1&filters=" + url.QueryEscape(string(encodedFilters))
	if err := c.do(ctx, http.MethodGet, path, nil, &summaries); err != nil {
		return nil, err
	}
	result := make([]string, 0, len(summaries))
	for _, summary := range summaries {
		identifier := strings.TrimSpace(summary.ID)
		if identifier == "" {
			return nil, fmt.Errorf("docker managed container summary is missing an ID")
		}
		result = append(result, identifier)
	}
	return result, nil
}

func (c *Client) WatchManagedEvents(
	ctx context.Context,
	since time.Time,
	ready func() error,
	emit func(ContainerEvent) error,
) (resultErr error) {
	if ready == nil || emit == nil {
		return fmt.Errorf("docker event readiness and sink callbacks are required")
	}
	encodedFilters, err := json.Marshal(map[string][]string{
		"type":  {"container"},
		"label": {labelManaged + "=runtime"},
	})
	if err != nil {
		return fmt.Errorf("encode Docker event filters: %w", err)
	}
	query := url.Values{}
	query.Set("filters", string(encodedFilters))
	if !since.IsZero() {
		query.Set("since", fmt.Sprintf("%d", since.Unix()))
	}
	request, err := http.NewRequestWithContext(
		ctx, http.MethodGet,
		c.baseURL+"/"+dockerAPIVersion+"/events?"+query.Encode(), nil,
	)
	if err != nil {
		return fmt.Errorf("create Docker event request: %w", err)
	}
	streamClient := *c.httpClient
	streamClient.Timeout = 0
	response, err := streamClient.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("watch Docker events: %w", err)
	}
	defer joinResponseCloseError(&resultErr, response.Body.Close)
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("watch Docker events returned %s: %s",
			response.Status, strings.TrimSpace(string(detail)))
	}
	if err := ready(); err != nil {
		return fmt.Errorf("announce Docker event stream readiness: %w", err)
	}
	decoder := json.NewDecoder(response.Body)
	for {
		var raw dockerEvent
		if err := decoder.Decode(&raw); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, io.EOF) {
				return platform.ErrObservationStreamDisconnected
			}
			return fmt.Errorf("decode Docker event: %w", err)
		}
		action := raw.Action
		if action == "" {
			action = raw.Status
		}
		observedAt := time.Unix(raw.Time, 0)
		if raw.TimeNano > 0 {
			observedAt = time.Unix(0, raw.TimeNano)
		}
		if err := emit(ContainerEvent{
			ID: raw.ID, Action: action, Attributes: raw.Actor.Attributes,
			ObservedAt: observedAt.UTC(),
		}); err != nil {
			return err
		}
	}
}

func (c *Client) InspectVolume(ctx context.Context, name string) (Volume, error) {
	var response struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
	}
	if err := c.do(ctx, http.MethodGet, "/volumes/"+url.PathEscape(name), nil, &response); err != nil {
		return Volume{}, err
	}
	return Volume{Name: response.Name, Labels: response.Labels}, nil
}

func (c *Client) CreateVolume(ctx context.Context, name string, labels map[string]string) error {
	return c.do(ctx, http.MethodPost, "/volumes/create", struct {
		Name   string            `json:"Name"`
		Labels map[string]string `json:"Labels"`
	}{Name: name, Labels: labels}, nil)
}

func (c *Client) InspectNetwork(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodGet, "/networks/"+url.PathEscape(name), nil, nil)
}

func (c *Client) RemoveVolume(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(name), nil, nil)
}

func (c *Client) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	body := dockerCreateRequest(spec)
	var response struct {
		ID string `json:"Id"`
	}
	requestPath := "/containers/create?name=" + url.QueryEscape(spec.Name)
	if err := c.do(ctx, http.MethodPost, requestPath, body, &response); err != nil {
		var decodeErr responseDecodeError
		if errors.As(err, &decodeErr) {
			return "", Uncertain(err)
		}
		return "", err
	}
	if strings.TrimSpace(response.ID) == "" {
		return "", Uncertain(fmt.Errorf("docker create returned an empty container ID"))
	}
	return response.ID, nil
}

func dockerCreateRequest(spec ContainerSpec) createContainerRequest {
	environment := make([]string, 0, len(spec.Environment))
	for key, value := range spec.Environment {
		environment = append(environment, key+"="+value)
	}
	sort.Strings(environment)
	mounts := make([]dockerMount, 0, len(spec.Mounts))
	for target, mount := range spec.Mounts {
		item := dockerMount{
			Type: "volume", Source: mount.Source, Target: target, ReadOnly: mount.ReadOnly,
		}
		if mount.NoCopy {
			item.VolumeOptions = &dockerVolumeOptions{NoCopy: true}
		}
		mounts = append(mounts, item)
	}
	sort.Slice(mounts, func(left, right int) bool { return mounts[left].Target < mounts[right].Target })
	return createContainerRequest{
		Image: spec.Image, User: spec.User, Env: environment, Labels: spec.Labels,
		Healthcheck: dockerHealthcheck{
			Test: spec.Healthcheck.Test, Interval: int64(spec.Healthcheck.Interval),
			Timeout: int64(spec.Healthcheck.Timeout), StartPeriod: int64(spec.Healthcheck.StartPeriod),
			StartInterval: int64(spec.Healthcheck.StartInterval), Retries: spec.Healthcheck.Retries,
		},
		NetworkingConfig: dockerNetworkingConfig{EndpointsConfig: dockerEndpoints(spec.Networks)},
		HostConfig: dockerHostConfig{
			ReadonlyRootfs: spec.ReadOnlyRootFS, Mounts: mounts,
			NetworkMode: spec.NetworkMode,
			CapDrop:     []string{"ALL"}, CapAdd: spec.Capabilities, Tmpfs: spec.Tmpfs,
			Dns: spec.DNS, DnsOptions: spec.DNSOptions, Devices: dockerDevices(spec.Devices),
			PidsLimit: spec.PidsLimit, Memory: spec.MemoryBytes,
			SecurityOpt:   []string{"no-new-privileges=true"},
			RestartPolicy: dockerRestartPolicy{Name: spec.RestartPolicy},
		},
	}
}

func (c *Client) StartContainer(ctx context.Context, identifier string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(identifier)+"/start", nil, nil)
}

func (c *Client) StopContainer(ctx context.Context, identifier string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(identifier)+"/stop?t=10", nil, nil)
}

func (c *Client) RemoveContainer(ctx context.Context, identifier string) error {
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(identifier)+"?force=1", nil, nil)
}

// PutArchive writes a tar stream into a container's mounted volume. The
// caller owns validation of the tar members and must close its input.
func (c *Client) PutArchive(ctx context.Context, identifier, destination string, archive io.Reader) (resultErr error) {
	requestPath := "/containers/" + url.PathEscape(identifier) + "/archive?path=" + url.QueryEscape(destination)
	request, err := http.NewRequestWithContext(ctx, http.MethodPut, c.baseURL+"/"+dockerAPIVersion+requestPath, archive)
	if err != nil {
		return fmt.Errorf("create Docker archive request: %w", err)
	}
	request.Header.Set("Content-Type", "application/x-tar")
	archiveClient := *c.httpClient
	archiveClient.Timeout = 0 // The preparation round's context owns the archive budget.
	response, err := archiveClient.Do(request)
	if err != nil {
		return Uncertain(fmt.Errorf("write Docker archive: %w", err))
	}
	defer joinResponseCloseError(&resultErr, response.Body.Close)
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, response.Body)
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		err := fmt.Errorf("write Docker archive returned %s: %s", response.Status, strings.TrimSpace(string(detail)))
		if response.StatusCode >= 500 {
			return Uncertain(err)
		}
		return err
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return nil
}

// GetArchive returns the raw tar stream from Docker. The caller must close it.
func (c *Client) GetArchive(ctx context.Context, identifier, source string) (io.ReadCloser, error) {
	requestPath := "/containers/" + url.PathEscape(identifier) + "/archive?path=" + url.QueryEscape(source)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/"+dockerAPIVersion+requestPath, nil)
	if err != nil {
		return nil, fmt.Errorf("create Docker archive request: %w", err)
	}
	archiveClient := *c.httpClient
	archiveClient.Timeout = 0 // The preparation round's context owns the archive budget.
	response, err := archiveClient.Do(request)
	if err != nil {
		return nil, fmt.Errorf("read Docker archive: %w", err)
	}
	if response.StatusCode == http.StatusNotFound {
		_ = response.Body.Close()
		return nil, ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		_ = response.Body.Close()
		return nil, fmt.Errorf("read Docker archive returned %s: %s", response.Status, strings.TrimSpace(string(detail)))
	}
	return response.Body, nil
}

func (c *Client) do(ctx context.Context, method, requestPath string, input, output any) (resultErr error) {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode Docker request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(
		ctx, method, c.baseURL+"/"+dockerAPIVersion+requestPath, body,
	)
	if err != nil {
		return fmt.Errorf("create Docker request: %w", err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return Uncertain(fmt.Errorf("docker %s %s: %w", method, requestPath, err))
	}
	defer joinResponseCloseError(&resultErr, response.Body.Close)
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, response.Body)
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		err := fmt.Errorf("docker %s %s returned %s: %s",
			method, requestPath, response.Status, strings.TrimSpace(string(detail)))
		if response.StatusCode == http.StatusConflict {
			return errors.Join(ErrConflict, err)
		}
		if mutatingMethod(method) && response.StatusCode >= 500 {
			return Uncertain(err)
		}
		return err
	}
	if output == nil {
		_, _ = io.Copy(io.Discard, response.Body)
		return nil
	}
	if err := json.NewDecoder(response.Body).Decode(output); err != nil {
		return responseDecodeError{cause: err}
	}
	return nil
}

func joinResponseCloseError(resultErr *error, closeFunc func() error) {
	if err := closeFunc(); err != nil {
		*resultErr = errors.Join(*resultErr, fmt.Errorf("close Docker response: %w", err))
	}
}

func mutatingMethod(method string) bool {
	switch method {
	case http.MethodPost, http.MethodPut, http.MethodPatch, http.MethodDelete:
		return true
	default:
		return false
	}
}

type inspectContainerResponse struct {
	ID           string `json:"Id"`
	Name         string `json:"Name"`
	RestartCount uint64 `json:"RestartCount"`
	State        struct {
		Running   bool   `json:"Running"`
		Status    string `json:"Status"`
		ExitCode  int    `json:"ExitCode"`
		OOMKilled bool   `json:"OOMKilled"`
		Error     string `json:"Error"`
		Health    *struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Labels map[string]string `json:"Labels"`
	} `json:"Config"`
	Mounts     []dockerObservedMount `json:"Mounts"`
	HostConfig struct {
		Mounts []dockerMount `json:"Mounts"`
	} `json:"HostConfig"`
}

type dockerObservedMount struct {
	Type        string `json:"Type"`
	Name        string `json:"Name"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

type dockerEvent struct {
	Status string `json:"status"`
	Action string `json:"Action"`
	ID     string `json:"id"`
	Actor  struct {
		Attributes map[string]string `json:"Attributes"`
	} `json:"Actor"`
	Time     int64 `json:"time"`
	TimeNano int64 `json:"timeNano"`
}

type responseDecodeError struct{ cause error }

func (e responseDecodeError) Error() string {
	return fmt.Sprintf("decode Docker response: %v", e.cause)
}
func (e responseDecodeError) Unwrap() error { return e.cause }

type dockerMount struct {
	Type          string               `json:"Type"`
	Source        string               `json:"Source"`
	Target        string               `json:"Target"`
	ReadOnly      bool                 `json:"ReadOnly"`
	VolumeOptions *dockerVolumeOptions `json:"VolumeOptions,omitempty"`
}

type dockerVolumeOptions struct {
	NoCopy bool `json:"NoCopy"`
}

type dockerDevice struct {
	PathOnHost        string `json:"PathOnHost"`
	PathInContainer   string `json:"PathInContainer"`
	CgroupPermissions string `json:"CgroupPermissions"`
}

func dockerDevices(paths []string) []dockerDevice {
	devices := make([]dockerDevice, 0, len(paths))
	for _, devicePath := range paths {
		devices = append(devices, dockerDevice{
			PathOnHost: devicePath, PathInContainer: devicePath, CgroupPermissions: "rwm",
		})
	}
	return devices
}

func dockerEndpoints(networks []string) map[string]dockerEndpointSettings {
	endpoints := make(map[string]dockerEndpointSettings, len(networks))
	for _, network := range networks {
		if network = strings.TrimSpace(network); network != "" {
			endpoints[network] = dockerEndpointSettings{}
		}
	}
	return endpoints
}

type createContainerRequest struct {
	Image            string                 `json:"Image"`
	User             string                 `json:"User"`
	Env              []string               `json:"Env"`
	Labels           map[string]string      `json:"Labels"`
	Healthcheck      dockerHealthcheck      `json:"Healthcheck"`
	HostConfig       dockerHostConfig       `json:"HostConfig"`
	NetworkingConfig dockerNetworkingConfig `json:"NetworkingConfig"`
}

type dockerHealthcheck struct {
	Test          []string `json:"Test"`
	Interval      int64    `json:"Interval"`
	Timeout       int64    `json:"Timeout"`
	StartPeriod   int64    `json:"StartPeriod"`
	StartInterval int64    `json:"StartInterval"`
	Retries       int      `json:"Retries"`
}

type dockerNetworkingConfig struct {
	EndpointsConfig map[string]dockerEndpointSettings `json:"EndpointsConfig"`
}

type dockerEndpointSettings struct{}

type dockerHostConfig struct {
	ReadonlyRootfs bool                `json:"ReadonlyRootfs"`
	Mounts         []dockerMount       `json:"Mounts"`
	NetworkMode    string              `json:"NetworkMode,omitempty"`
	CapDrop        []string            `json:"CapDrop"`
	CapAdd         []string            `json:"CapAdd"`
	Tmpfs          map[string]string   `json:"Tmpfs"`
	Dns            []string            `json:"Dns"`
	DnsOptions     []string            `json:"DnsOptions"`
	Devices        []dockerDevice      `json:"Devices"`
	PidsLimit      int64               `json:"PidsLimit"`
	Memory         int64               `json:"Memory"`
	SecurityOpt    []string            `json:"SecurityOpt"`
	RestartPolicy  dockerRestartPolicy `json:"RestartPolicy"`
}

type dockerRestartPolicy struct {
	Name string `json:"Name"`
}
