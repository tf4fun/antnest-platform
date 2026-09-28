package docker

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/platform"
)

func TestHTTPClientMapsDockerResourcesAndHardening(t *testing.T) {
	requests := make(map[string]int)
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		requests[request.Method+" "+request.URL.Path]++
		response := responseWith(http.StatusNoContent, "")
		switch request.Method + " " + request.URL.Path {
		case "GET /v1.47/_ping":
			response = responseWith(http.StatusOK, "OK")
		case "GET /v1.47/containers/json":
			if !strings.Contains(request.URL.Query().Get("filters"), labelManaged) {
				t.Errorf("managed label filter missing: %s", request.URL.RawQuery)
			}
			response = jsonResponse(http.StatusOK, []map[string]string{{"Id": "container-1"}})
		case "GET /v1.47/containers/container-1/json":
			response = jsonResponse(http.StatusOK, map[string]any{
				"Id": "container-1", "Name": "/antnest-runtime-agent-1", "RestartCount": 2,
				"State": map[string]any{"Running": true, "Status": "running", "ExitCode": 137, "OOMKilled": true, "Error": "startup error", "Health": map[string]string{"Status": "healthy"}},
				"Config": map[string]any{"Labels": map[string]string{
					labelManaged: "runtime", labelAgentID: "agent-1", labelGeneration: "7",
				}},
			})
		case "GET /v1.47/volumes/antnest-workspace-agent-1":
			response = jsonResponse(http.StatusOK, map[string]any{
				"Name":   "antnest-workspace-agent-1",
				"Labels": map[string]string{labelManaged: "workspace", labelAgentID: "agent-1"},
			})
		case "GET /v1.47/networks/antnest-runtime-management":
			response = jsonResponse(http.StatusOK, map[string]string{"Name": "antnest-runtime-management"})
		case "POST /v1.47/volumes/create":
			var body struct {
				Name   string            `json:"Name"`
				Labels map[string]string `json:"Labels"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil ||
				body.Name != "antnest-workspace-agent-1" || body.Labels[labelAgentID] != "agent-1" {
				t.Fatalf("managed volume labels missing: body=%+v err=%v", body, err)
			}
			response = jsonResponse(http.StatusCreated, map[string]string{"Name": "antnest-workspace-agent-1"})
		case "POST /v1.47/containers/create":
			var body struct {
				Env         []string `json:"Env"`
				Healthcheck struct {
					Test          []string `json:"Test"`
					Interval      int64    `json:"Interval"`
					StartInterval int64    `json:"StartInterval"`
					StartPeriod   int64    `json:"StartPeriod"`
					Timeout       int64    `json:"Timeout"`
					Retries       int      `json:"Retries"`
				} `json:"Healthcheck"`
				HostConfig struct {
					CapDrop        []string            `json:"CapDrop"`
					CapAdd         []string            `json:"CapAdd"`
					ReadonlyRootfs bool                `json:"ReadonlyRootfs"`
					RestartPolicy  dockerRestartPolicy `json:"RestartPolicy"`
					SecurityOpt    []string            `json:"SecurityOpt"`
					Devices        []dockerDevice      `json:"Devices"`
					Mounts         []dockerMount       `json:"Mounts"`
				} `json:"HostConfig"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
				t.Fatalf("decode Docker create request: %v", err)
			}
			if body.Healthcheck.StartInterval != int64(2*time.Second) ||
				body.Healthcheck.Interval != int64(10*time.Second) ||
				body.Healthcheck.StartPeriod != int64(30*time.Second) ||
				body.Healthcheck.Timeout != int64(2*time.Second) || body.Healthcheck.Retries != 3 {
				t.Fatalf("health cadence was lost at the Engine API boundary: %+v", body.Healthcheck)
			}
			if body.HostConfig.ReadonlyRootfs || len(body.HostConfig.CapDrop) != 1 ||
				body.HostConfig.CapDrop[0] != "ALL" || body.HostConfig.RestartPolicy.Name != "unless-stopped" ||
				len(body.HostConfig.SecurityOpt) != 1 || body.HostConfig.SecurityOpt[0] != "no-new-privileges=true" ||
				len(body.HostConfig.Devices) != 1 || body.HostConfig.Devices[0].CgroupPermissions != "rwm" ||
				len(body.HostConfig.Mounts) != 2 || body.HostConfig.Mounts[0].Type != "volume" ||
				len(body.Healthcheck.Test) == 0 || len(body.Env) == 0 {
				t.Fatalf("hardened container settings missing: %+v", body)
			}
			response = jsonResponse(http.StatusCreated, map[string]string{"Id": "created"})
		}
		return response, nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if err := client.Ping(ctx); err != nil {
		t.Fatal(err)
	}
	containers, err := client.ListManagedContainers(ctx)
	if err != nil || len(containers) != 1 || containers[0].RestartCount != 2 || containers[0].Health != "healthy" {
		t.Fatalf("list managed containers: containers=%+v err=%v", containers, err)
	}
	if containers[0].Status != "running" || containers[0].ExitCode != 137 || !containers[0].OOMKilled || containers[0].Error != "startup error" {
		t.Fatalf("Docker process facts were dropped: %+v", containers[0])
	}
	volume, err := client.InspectVolume(ctx, "antnest-workspace-agent-1")
	if err != nil || volume.Labels[labelManaged] != "workspace" {
		t.Fatal(err)
	}
	if err := client.CreateVolume(ctx, "antnest-workspace-agent-1", map[string]string{
		labelManaged: "workspace", labelAgentID: "agent-1",
	}); err != nil {
		t.Fatal(err)
	}
	if err := client.InspectNetwork(ctx, "antnest-runtime-management"); err != nil {
		t.Fatal(err)
	}
	driver := newTestDriver(t, newFakeEngine())
	spec, err := driver.containerSpec(testDeployment(), testDigest)
	if err != nil {
		t.Fatal(err)
	}
	containerID, err := client.CreateContainer(ctx, spec)
	if err != nil || containerID != "created" {
		t.Fatalf("create container: id=%q err=%v", containerID, err)
	}
	if err := client.StartContainer(ctx, containerID); err != nil {
		t.Fatal(err)
	}
	if err := client.StopContainer(ctx, containerID); err != nil {
		t.Fatal(err)
	}
	if err := client.RemoveContainer(ctx, containerID); err != nil {
		t.Fatal(err)
	}
	if err := client.RemoveVolume(ctx, "antnest-workspace-agent-1"); err != nil {
		t.Fatal(err)
	}
	if requests["GET /v1.47/containers/json"] != 1 || requests["POST /v1.47/containers/create"] != 1 {
		t.Fatalf("unexpected Docker requests: %+v", requests)
	}
}

func TestLegacyInventoryListsForeignAndStoppedDockerContainers(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.URL.Path {
		case "/v1.47/containers/json":
			if request.URL.Query().Get("all") != "1" || request.URL.Query().Has("filters") {
				t.Errorf("legacy inventory excluded Docker containers: %s", request.URL.RawQuery)
			}
			return jsonResponse(http.StatusOK, []map[string]string{{"Id": "owned"}, {"Id": "foreign"}}), nil
		case "/v1.47/containers/owned/json", "/v1.47/containers/foreign/json":
			id := strings.Split(request.URL.Path, "/")[3]
			return jsonResponse(http.StatusOK, map[string]any{
				"Id": id, "State": map[string]any{"Running": id == "owned", "Status": "exited"},
				"Config": map[string]any{"Labels": map[string]string{}},
				"Mounts": []map[string]any{{"Type": "volume", "Name": "legacy", "Destination": "/skills", "RW": false}},
			}), nil
		default:
			return responseWith(http.StatusNotFound, "missing"), nil
		}
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	containers, err := client.ListAllContainers(context.Background())
	if err != nil || len(containers) != 2 || len(containers[0].Mounts) != 1 || len(containers[1].Mounts) != 1 {
		t.Fatalf("legacy references incomplete: %+v, %v", containers, err)
	}
}

func TestHTTPClientPreservesNotFoundAndAmbiguousTransport(t *testing.T) {
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return responseWith(http.StatusNotFound, "missing"), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.InspectContainer(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("not found error = %v", err)
	}
	transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("connection reset")
	})
	client, _ = NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err := client.StartContainer(context.Background(), "missing"); !IsUncertain(err) {
		t.Fatalf("ambiguous mutation was not preserved: %v", err)
	}
}

func TestHTTPClientPreservesDockerConflict(t *testing.T) {
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return responseWith(http.StatusConflict, "name is already in use"), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.CreateContainer(context.Background(), ContainerSpec{Name: "duplicate"}); !errors.Is(err, ErrConflict) {
		t.Fatalf("Docker conflict was not preserved: %v", err)
	}
}

func TestHTTPClientTreatsMutatingServerFailureAsUnknown(t *testing.T) {
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return responseWith(http.StatusInternalServerError, "daemon failed after dispatch"), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.StartContainer(context.Background(), "container-1"); !IsUncertain(err) {
		t.Fatalf("mutating Docker 5xx was treated as definitely not started: %v", err)
	}
	if _, err := client.InspectContainer(context.Background(), "container-1"); IsUncertain(err) {
		t.Fatalf("read-only Docker 5xx was incorrectly classified as a mutation: %v", err)
	}
}

func TestHTTPClientStreamsFilteredDockerEvents(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Path != "/v1.47/events" || !strings.Contains(request.URL.Query().Get("filters"), labelManaged) {
			t.Fatalf("unexpected Docker event request: %s", request.URL.String())
		}
		return responseWith(http.StatusOK, strings.Join([]string{
			`{"status":"start","id":"container-1","Actor":{"Attributes":{"io.antnest.managed":"runtime","io.antnest.agent-id":"agent-1","io.antnest.runtime-generation":"7"}},"timeNano":100000000001}`,
			`{"Action":"die","id":"container-1","Actor":{"Attributes":{"io.antnest.managed":"runtime","io.antnest.agent-id":"agent-1","io.antnest.runtime-generation":"7"}},"timeNano":101000000001}`,
		}, "\n")), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	var events []ContainerEvent
	ready := false
	err = client.WatchManagedEvents(context.Background(), time.Unix(99, 0), func() error {
		ready = true
		return nil
	}, func(event ContainerEvent) error {
		events = append(events, event)
		return nil
	})
	if !errors.Is(err, platform.ErrObservationStreamDisconnected) {
		t.Fatalf("finite Docker event stream termination = %v", err)
	}
	if !ready || len(events) != 2 || events[0].Action != "start" || events[1].Action != "die" ||
		events[0].ObservedAt.Unix() != 100 {
		t.Fatalf("unexpected Docker events: ready=%t events=%+v", ready, events)
	}
}

func TestHTTPClientDoesNotAnnounceWatchBeforeResponseHeaders(t *testing.T) {
	transport := roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("Docker socket unavailable")
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	ready := false
	err = client.WatchManagedEvents(context.Background(), time.Time{}, func() error {
		ready = true
		return nil
	}, func(ContainerEvent) error { return nil })
	if err == nil || ready {
		t.Fatalf("failed Watch announced readiness: ready=%t err=%v", ready, err)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func responseWith(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status, Status: http.StatusText(status), Header: make(http.Header),
		Body: io.NopCloser(strings.NewReader(body)),
	}
}

func jsonResponse(status int, value any) *http.Response {
	encoded, _ := json.Marshal(value)
	return responseWith(status, string(encoded))
}
