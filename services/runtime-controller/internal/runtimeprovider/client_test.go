package runtimeprovider

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

func TestEnsureMapsProviderResult(t *testing.T) {
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.Method != http.MethodPut || request.URL.Path != "/internal/v1/runtimes/agent-1" {
			t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		}
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		if !bytes.Contains(body, []byte(`"runtime_instance_id":"runtime-1"`)) ||
			!bytes.Contains(body, []byte(`"egress_endpoint":"172.30.255.3:8092"`)) {
			t.Fatalf("request body = %s", body)
		}
		return response(http.StatusOK,
			`{"outcome":{"state":"completed"},"container_id":"container-1"}`), nil
	})
	client, err := New(&http.Client{Transport: transport}, "http://runtime-provider-docker:8082")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	result := client.Ensure(context.Background(), application.EnsureRequest{
		AgentID: "agent-1", RuntimeInstanceID: "runtime-1", EgressEndpoint: "172.30.255.3:8092",
	})
	if result.Outcome.State != domain.EffectCompleted || result.ContainerID != "container-1" {
		t.Fatalf("Ensure() = %+v", result)
	}
}

func TestTransportFailureIsUnknown(t *testing.T) {
	client, _ := New(&http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		return nil, errors.New("provider unavailable")
	})}, "http://runtime-provider-docker:8082")
	result := client.Stop(context.Background(), application.RuntimeTarget{AgentID: "agent-1"})
	if result.Outcome.State != domain.EffectUnknown {
		t.Fatalf("Stop() = %+v", result)
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func response(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status, Status: http.StatusText(status),
		Header: make(http.Header), Body: io.NopCloser(bytes.NewBufferString(body)),
	}
}
