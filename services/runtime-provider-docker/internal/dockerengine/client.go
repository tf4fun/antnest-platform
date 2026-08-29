package dockerengine

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
)

const dockerAPIVersion = "v1.47"

type Client struct {
	httpClient *http.Client
	baseURL    string
}

func (c *Client) Ping(ctx context.Context) error {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/_ping", nil)
	if err != nil {
		return fmt.Errorf("create Docker ping request: %w", err)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("ping Docker: %w", err)
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 4096))
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Docker ping returned %s", response.Status)
	}
	return nil
}

func NewUnixClient(socketPath string) (*Client, error) {
	socketPath = strings.TrimSpace(socketPath)
	if socketPath == "" {
		return nil, fmt.Errorf("Docker socket path is required")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
		DisableCompression: true,
	}
	return NewHTTPClient(&http.Client{Transport: transport, Timeout: 30 * time.Second}, "http://docker")
}

func NewHTTPClient(httpClient *http.Client, baseURL string) (*Client, error) {
	if httpClient == nil || strings.TrimSpace(baseURL) == "" {
		return nil, fmt.Errorf("Docker HTTP client and base URL are required")
	}
	return &Client{httpClient: httpClient, baseURL: strings.TrimRight(baseURL, "/")}, nil
}

func (c *Client) InspectContainer(ctx context.Context, identifier string) (Container, error) {
	var response struct {
		ID    string `json:"Id"`
		Name  string `json:"Name"`
		State struct {
			Running bool `json:"Running"`
		} `json:"State"`
		Config struct {
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	err := c.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(identifier)+"/json", nil, &response)
	if err != nil {
		return Container{}, err
	}
	return Container{
		ID: response.ID, Name: strings.TrimPrefix(response.Name, "/"),
		Running: response.State.Running, Labels: response.Config.Labels,
	}, nil
}

func (c *Client) EnsureVolume(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodPost, "/volumes/create", map[string]string{"Name": name}, nil)
}

func (c *Client) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	environment := make([]string, 0, len(spec.Environment))
	for key, value := range spec.Environment {
		environment = append(environment, key+"="+value)
	}
	sort.Strings(environment)
	mounts := make([]dockerMount, 0, len(spec.Mounts))
	for target, mount := range spec.Mounts {
		mounts = append(mounts, dockerMount{
			Type: "volume", Source: mount.Source, Target: target, ReadOnly: mount.ReadOnly,
		})
	}
	sort.Slice(mounts, func(left, right int) bool { return mounts[left].Target < mounts[right].Target })
	body := createContainerRequest{
		Image: spec.Image, User: spec.User, Env: environment, Labels: spec.Labels,
		NetworkingConfig: dockerNetworkingConfig{EndpointsConfig: dockerEndpoints(spec.Networks)},
		HostConfig: dockerHostConfig{
			ReadonlyRootfs: spec.ReadOnlyRootFS, Mounts: mounts,
			CapAdd: spec.Capabilities, Tmpfs: spec.Tmpfs,
			Dns: spec.DNS, DnsOptions: spec.DNSOptions, Devices: dockerDevices(spec.Devices),
			PidsLimit: spec.PidsLimit, Memory: spec.MemoryBytes,
			SecurityOpt: []string{"no-new-privileges=true"},
		},
	}
	var response struct {
		ID string `json:"Id"`
	}
	path := "/containers/create?name=" + url.QueryEscape(spec.Name)
	if err := c.do(ctx, http.MethodPost, path, body, &response); err != nil {
		var decodeErr responseDecodeError
		if errors.As(err, &decodeErr) {
			return "", Uncertain(err)
		}
		return "", err
	}
	if strings.TrimSpace(response.ID) == "" {
		return "", Uncertain(fmt.Errorf("Docker create returned an empty container id"))
	}
	return response.ID, nil
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

func (c *Client) StartContainer(ctx context.Context, identifier string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(identifier)+"/start", nil, nil)
}

func (c *Client) StopContainer(ctx context.Context, identifier string) error {
	return c.do(ctx, http.MethodPost, "/containers/"+url.PathEscape(identifier)+"/stop?t=10", nil, nil)
}

func (c *Client) RemoveContainer(ctx context.Context, identifier string) error {
	return c.do(ctx, http.MethodDelete, "/containers/"+url.PathEscape(identifier)+"?force=1", nil, nil)
}

func (c *Client) RemoveVolume(ctx context.Context, name string) error {
	return c.do(ctx, http.MethodDelete, "/volumes/"+url.PathEscape(name), nil, nil)
}

func (c *Client) do(
	ctx context.Context, method, path string, input any, output any,
) error {
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			return fmt.Errorf("encode Docker request: %w", err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(
		ctx, method, c.baseURL+"/"+dockerAPIVersion+path, body,
	)
	if err != nil {
		return fmt.Errorf("create Docker request: %w", err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return Uncertain(fmt.Errorf("Docker %s %s: %w", method, path, err))
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		_, _ = io.Copy(io.Discard, response.Body)
		return ErrNotFound
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return fmt.Errorf("Docker %s %s returned %s: %s",
			method, path, response.Status, strings.TrimSpace(string(detail)))
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

type responseDecodeError struct{ cause error }

func (e responseDecodeError) Error() string {
	return fmt.Sprintf("decode Docker response: %v", e.cause)
}
func (e responseDecodeError) Unwrap() error { return e.cause }

type dockerMount struct {
	Type     string `json:"Type"`
	Source   string `json:"Source"`
	Target   string `json:"Target"`
	ReadOnly bool   `json:"ReadOnly"`
}

type dockerDevice struct {
	PathOnHost        string `json:"PathOnHost"`
	PathInContainer   string `json:"PathInContainer"`
	CgroupPermissions string `json:"CgroupPermissions"`
}

func dockerDevices(paths []string) []dockerDevice {
	devices := make([]dockerDevice, 0, len(paths))
	for _, path := range paths {
		devices = append(devices, dockerDevice{
			PathOnHost: path, PathInContainer: path, CgroupPermissions: "rwm",
		})
	}
	return devices
}

type createContainerRequest struct {
	Image            string                 `json:"Image"`
	User             string                 `json:"User"`
	Env              []string               `json:"Env"`
	Labels           map[string]string      `json:"Labels"`
	HostConfig       dockerHostConfig       `json:"HostConfig"`
	NetworkingConfig dockerNetworkingConfig `json:"NetworkingConfig"`
}

type dockerNetworkingConfig struct {
	EndpointsConfig map[string]dockerEndpointSettings `json:"EndpointsConfig"`
}

type dockerEndpointSettings struct{}

type dockerHostConfig struct {
	ReadonlyRootfs bool              `json:"ReadonlyRootfs"`
	Mounts         []dockerMount     `json:"Mounts"`
	CapAdd         []string          `json:"CapAdd"`
	Tmpfs          map[string]string `json:"Tmpfs"`
	Dns            []string          `json:"Dns"`
	DnsOptions     []string          `json:"DnsOptions"`
	Devices        []dockerDevice    `json:"Devices"`
	PidsLimit      int64             `json:"PidsLimit"`
	Memory         int64             `json:"Memory"`
	SecurityOpt    []string          `json:"SecurityOpt"`
}
