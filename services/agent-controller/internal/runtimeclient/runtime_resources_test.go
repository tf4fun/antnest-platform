package runtimeclient

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func resourceOperationFixture(requestID, kind string) string {
	return fmt.Sprintf(`{
		"request_id":%q,
		"kind":%q,
		"agent_id":"agent-1",
		"target_revision":"rtv_22222222222222222222222222222222",
		"state":"completed",
		"effect":"completed",
		"inspection":{
			"agent_id":"agent-1",
			"runtime_revision":"rtv_22222222222222222222222222222222",
			"lifecycle_state":"provisioned",
			"health":"unknown",
			"mcp_endpoint":"",
			"runtime_execution_id":""
		}
	}`, requestID, kind)
}

func operationServer(t *testing.T, bodies *map[string]map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, err := io.ReadAll(request.Body)
		if err != nil {
			t.Fatalf("read request body: %v", err)
		}
		var body map[string]any
		if err := json.Unmarshal(raw, &body); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		(*bodies)[request.URL.Path] = body
		var kind string
		switch request.URL.Path {
		case "/internal/runtimes/agent-1/initialize":
			kind = "initialize_runtime"
		case "/internal/runtimes/agent-1/update":
			kind = "update_runtime"
		case "/internal/runtimes/agent-1/enable":
			kind = "enable_runtime"
		default:
			t.Fatalf("unexpected path %s", request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(resourceOperationFixture("request-1", kind)))
	}))
}

func bodyResources(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	configuration, _ := body["configuration"].(map[string]any)
	resources, _ := configuration["resources"].(map[string]any)
	if resources == nil {
		t.Fatalf("configuration.resources missing: %+v", body)
	}
	return resources
}

func TestRuntimeResourcesReachTheWireOnEveryMutation(t *testing.T) {
	t.Parallel()
	bodies := map[string]map[string]any{}
	server := operationServer(t, &bodies)
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	if _, err := client.InitializeRuntime(ctx, "request-1", "agent-1", runtimeConfiguration()); err != nil {
		t.Fatalf("initialize: %v", err)
	}
	legacy := bodyResources(t, bodies["/internal/runtimes/agent-1/initialize"])
	if legacy["cpu_millis"] != float64(1000) || legacy["workspace_bytes"] != float64(10737418240) {
		t.Fatalf("legacy configuration must emit concrete defaults: %+v", legacy)
	}

	explicit := runtimeConfiguration()
	cpu, workspace := int64(2500), int64(67108864)
	explicit.Resources.CPUMillis = &cpu
	explicit.Resources.WorkspaceBytes = &workspace
	if _, err := client.UpdateRuntime(ctx, "request-1", "agent-1",
		"rtv_11111111111111111111111111111111", explicit); err != nil {
		t.Fatalf("update: %v", err)
	}
	update := bodyResources(t, bodies["/internal/runtimes/agent-1/update"])
	if update["cpu_millis"] != float64(2500) || update["workspace_bytes"] != float64(67108864) {
		t.Fatalf("explicit limits not preserved: %+v", update)
	}
	if update := bodies["/internal/runtimes/agent-1/update"]; update["expected_revision"] != "rtv_11111111111111111111111111111111" {
		t.Fatalf("expected_revision lost: %+v", update)
	}

	bounds := runtimeConfiguration()
	maxCPU, minWS := int64(16000), int64(67108864)
	bounds.Resources.CPUMillis = &maxCPU
	bounds.Resources.WorkspaceBytes = &minWS
	if _, err := client.EnableRuntime(ctx, "request-1", "agent-1",
		"rtv_11111111111111111111111111111111", bounds); err != nil {
		t.Fatalf("enable: %v", err)
	}
	enable := bodyResources(t, bodies["/internal/runtimes/agent-1/enable"])
	if enable["cpu_millis"] != float64(16000) || enable["workspace_bytes"] != float64(67108864) {
		t.Fatalf("boundary limits not preserved: %+v", enable)
	}
}

func TestRuntimeResourceDeliveryProducer(t *testing.T) {
	t.Parallel()
	cpu100, cpu1000, cpu16000 := int64(100), int64(1000), int64(16000)
	wsMin, wsDefault, wsMax := int64(67108864), int64(10737418240), int64(1099511627776)
	entries := []map[string]any{}
	for _, test := range []struct {
		name      string
		cpu       *int64
		workspace *int64
		wantCPU   int64
		wantWS    int64
	}{
		{"legacy", nil, nil, 1000, 10737418240},
		{"cpu_min", &cpu100, nil, 100, 10737418240},
		{"cpu_default", &cpu1000, nil, 1000, 10737418240},
		{"cpu_max", &cpu16000, nil, 16000, 10737418240},
		{"workspace_min", nil, &wsMin, 1000, 67108864},
		{"workspace_default", nil, &wsDefault, 1000, 10737418240},
		{"workspace_max", nil, &wsMax, 1000, 1099511627776},
	} {
		configuration := runtimeConfiguration()
		configuration.Resources.CPUMillis = test.cpu
		configuration.Resources.WorkspaceBytes = test.workspace
		payload := runtimeConfigurationPayload(configuration)
		if payload.Resources.CPUMillis != test.wantCPU || payload.Resources.WorkspaceBytes != test.wantWS {
			t.Fatalf("%s emitted cpu=%d workspace=%d, want %d/%d",
				test.name, payload.Resources.CPUMillis, payload.Resources.WorkspaceBytes, test.wantCPU, test.wantWS)
		}
		configurationJSON, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		resourcesJSON, err := json.Marshal(configuration.Resources)
		if err != nil {
			t.Fatal(err)
		}
		entries = append(entries, map[string]any{
			"name":               test.name,
			"configuration":      json.RawMessage(configurationJSON),
			"template_resources": json.RawMessage(resourcesJSON),
		})
	}
	marker, err := json.Marshal(entries)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("ANTNEST_RUNTIME_RESOURCE_PAYLOAD=%s", marker)
}
