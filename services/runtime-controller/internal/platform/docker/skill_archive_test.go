package docker

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSkillArchiveAndObservedMountContract(t *testing.T) {
	var wrote bool
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		switch request.Method + " " + request.URL.Path {
		case "PUT /v1.47/containers/prepare-1/archive":
			if request.URL.Query().Get("path") != "/skills" || request.Header.Get("Content-Type") != "application/x-tar" {
				t.Fatalf("wrong archive destination: %s %q", request.URL, request.Header.Get("Content-Type"))
			}
			body, _ := io.ReadAll(request.Body)
			wrote = bytes.Equal(body, []byte("tar payload"))
			return responseWith(http.StatusOK, ""), nil
		case "GET /v1.47/containers/prepare-1/archive":
			if request.URL.Query().Get("path") != "/skills/code-review" {
				t.Fatalf("wrong archive source: %s", request.URL)
			}
			return responseWith(http.StatusOK, "tar readback"), nil
		case "GET /v1.47/containers/prepare-1/json":
			return jsonResponse(http.StatusOK, map[string]any{
				"Id": "prepare-1", "Name": "/prepare-1", "State": map[string]any{"Status": "created"},
				"Config":     map[string]any{"Labels": map[string]string{}},
				"Mounts":     []map[string]any{{"Type": "volume", "Name": "skills-1", "Destination": "/skills", "RW": false}},
				"HostConfig": map[string]any{"Mounts": []map[string]any{{"Type": "volume", "Source": "skills-1", "Target": "/skills", "ReadOnly": true, "VolumeOptions": map[string]any{"NoCopy": true}}}},
			}), nil
		default:
			t.Fatalf("unexpected Docker request: %s %s", request.Method, request.URL)
			return nil, nil
		}
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if err := client.PutArchive(context.Background(), "prepare-1", "/skills", strings.NewReader("tar payload")); err != nil {
		t.Fatal(err)
	}
	if !wrote {
		t.Fatal("archive payload not written")
	}
	readback, err := client.GetArchive(context.Background(), "prepare-1", "/skills/code-review")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = readback.Close() }()
	content, err := io.ReadAll(readback)
	if err != nil || string(content) != "tar readback" {
		t.Fatalf("archive readback = %q, %v", content, err)
	}
	container, err := client.InspectContainer(context.Background(), "prepare-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(container.Mounts) != 1 || container.Mounts[0].Name != "skills-1" || container.Mounts[0].Destination != "/skills" || container.Mounts[0].ReadWrite || !container.Mounts[0].NoCopy {
		t.Fatalf("actual mount facts missing: %+v", container.Mounts)
	}
}

func TestSkillArchiveRejectsMissingContainerAndBadStatus(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method == http.MethodGet {
			return responseWith(http.StatusNotFound, "missing"), nil
		}
		return responseWith(http.StatusInternalServerError, "failure"), nil
	})
	client, err := NewHTTPClient(&http.Client{Transport: transport}, "http://docker")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.GetArchive(context.Background(), "gone", "/skills"); err != ErrNotFound {
		t.Fatalf("missing container = %v", err)
	}
	if err := client.PutArchive(context.Background(), "broken", "/skills", strings.NewReader("x")); err == nil {
		t.Fatal("accepted failed archive write")
	}
}

func TestPreparationContainerHasNoNetworkAndDoesNotCopyVolume(t *testing.T) {
	spec := ContainerSpec{
		Name: "prepare-1", Image: "debian:bookworm-slim", NetworkMode: "none",
		Mounts: map[string]Mount{"/skills": {Source: "skills-1", NoCopy: true}},
	}
	request := dockerCreateRequest(spec)
	if request.HostConfig.NetworkMode != "none" || len(request.NetworkingConfig.EndpointsConfig) != 0 ||
		len(request.HostConfig.Mounts) != 1 || request.HostConfig.Mounts[0].VolumeOptions == nil ||
		!request.HostConfig.Mounts[0].VolumeOptions.NoCopy || request.HostConfig.Mounts[0].ReadOnly {
		t.Fatalf("unsafe preparation container request: %+v", request)
	}
}
