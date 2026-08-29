package dockerengine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestHTTPClientImplementsDockerLifecycle(t *testing.T) {
	requests := make(map[string]int)
	transport := &recordingTransport{}
	transport.handle = func(request *http.Request) (*http.Response, error) {
		requests[request.Method+" "+request.URL.Path]++
		response := &http.Response{
			StatusCode: http.StatusNoContent, Status: "204 No Content",
			Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header),
		}
		switch request.Method + " " + request.URL.Path {
		case "GET /v1.47/containers/antnest-runtime-agent-1/json":
			response.StatusCode = http.StatusOK
			response.Status = "200 OK"
			response.Body = jsonBody(map[string]any{
				"Id": "container-1", "Name": "/antnest-runtime-agent-1",
				"State":  map[string]any{"Running": true},
				"Config": map[string]any{"Labels": map[string]string{labelAgentID: "agent-1"}},
			})
		case "POST /v1.47/volumes/create":
			response.StatusCode = http.StatusCreated
			response.Status = "201 Created"
		case "POST /v1.47/containers/create":
			if request.URL.Query().Get("name") != "antnest-runtime-agent-1" {
				t.Errorf("unexpected container name: %s", request.URL.RawQuery)
			}
			var body struct {
				Image            string `json:"Image"`
				NetworkingConfig struct {
					EndpointsConfig map[string]json.RawMessage `json:"EndpointsConfig"`
				} `json:"NetworkingConfig"`
				HostConfig struct {
					ReadonlyRootfs bool     `json:"ReadonlyRootfs"`
					DNS            []string `json:"Dns"`
					DNSOptions     []string `json:"DnsOptions"`
					Devices        []struct {
						PathOnHost        string `json:"PathOnHost"`
						PathInContainer   string `json:"PathInContainer"`
						CgroupPermissions string `json:"CgroupPermissions"`
					} `json:"Devices"`
					Mounts []struct {
						Source   string `json:"Source"`
						Target   string `json:"Target"`
						ReadOnly bool   `json:"ReadOnly"`
					} `json:"Mounts"`
				} `json:"HostConfig"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Errorf("decode create: %v", err)
			}
			if body.Image != "antnest/runtime:test" || !body.HostConfig.ReadonlyRootfs || len(body.HostConfig.Mounts) != 2 {
				t.Errorf("unexpected create body: %+v", body)
			}
			if _, ok := body.NetworkingConfig.EndpointsConfig["antnest-runtime-management"]; !ok ||
				len(body.NetworkingConfig.EndpointsConfig) != 1 {
				t.Errorf("runtime management network was not isolated: %+v", body.NetworkingConfig)
			}
			if len(body.HostConfig.DNS) != 1 || body.HostConfig.DNS[0] != "100.64.0.1" ||
				len(body.HostConfig.DNSOptions) != 1 || body.HostConfig.DNSOptions[0] != "use-vc" ||
				len(body.HostConfig.Devices) != 1 || body.HostConfig.Devices[0].PathOnHost != "/dev/net/tun" ||
				body.HostConfig.Devices[0].PathInContainer != "/dev/net/tun" ||
				body.HostConfig.Devices[0].CgroupPermissions != "rwm" {
				t.Errorf("runtime TUN or DNS was not forwarded: %+v", body.HostConfig)
			}
			response.StatusCode = http.StatusCreated
			response.Status = "201 Created"
			response.Body = jsonBody(map[string]string{"Id": "created"})
		}
		return response, nil
	}
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	ctx := context.Background()
	container, err := client.InspectContainer(ctx, "antnest-runtime-agent-1")
	if err != nil || container.ID != "container-1" || !container.Running {
		t.Fatalf("inspect: container=%+v err=%v", container, err)
	}
	if err := client.EnsureVolume(ctx, "antnest-workspace-agent-1"); err != nil {
		t.Fatalf("ensure volume: %v", err)
	}
	id, err := client.CreateContainer(ctx, containerSpec(ensureRequest(), "antnest-runtime-agent-1", "antnest-workspace-agent-1"))
	if err != nil || id != "created" {
		t.Fatalf("create: id=%q err=%v", id, err)
	}
	if err := client.StartContainer(ctx, "container-1"); err != nil {
		t.Fatalf("start: %v", err)
	}
	if err := client.StopContainer(ctx, "container-1"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if err := client.RemoveContainer(ctx, "container-1"); err != nil {
		t.Fatalf("remove: %v", err)
	}
	if err := client.RemoveVolume(ctx, "antnest-workspace-agent-1"); err != nil {
		t.Fatalf("remove volume: %v", err)
	}
	if len(requests) != 7 {
		t.Fatalf("unexpected requests: %+v", requests)
	}
}

func TestHTTPClientMapsNotFoundAndAmbiguousTransport(t *testing.T) {
	transport := &recordingTransport{handle: func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusNotFound, Status: "404 Not Found",
			Body: io.NopCloser(strings.NewReader("missing")), Header: make(http.Header),
		}, nil
	}}
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	_, err = client.InspectContainer(context.Background(), "missing")
	if err != ErrNotFound {
		t.Fatalf("not found error = %v", err)
	}
	transport.handle = func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	}
	if err := client.StartContainer(context.Background(), "missing"); !IsUncertain(err) {
		t.Fatalf("transport error was not ambiguous: %v", err)
	}
}

func TestCreateContainerTreatsMalformedSuccessAsUncertain(t *testing.T) {
	transport := &recordingTransport{handle: func(*http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusCreated, Status: "201 Created",
			Body: io.NopCloser(strings.NewReader("{")), Header: make(http.Header),
		}, nil
	}}
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	_, err = client.CreateContainer(context.Background(), containerSpec(
		ensureRequest(), "antnest-runtime-agent-1", "antnest-workspace-agent-1",
	))
	if !IsUncertain(err) {
		t.Fatalf("malformed success response was not ambiguous: %v", err)
	}
}

type recordingTransport struct {
	handle func(*http.Request) (*http.Response, error)
}

func (t *recordingTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return t.handle(request)
}

func jsonBody(value any) io.ReadCloser {
	encoded, _ := json.Marshal(value)
	return io.NopCloser(strings.NewReader(string(encoded)))
}
