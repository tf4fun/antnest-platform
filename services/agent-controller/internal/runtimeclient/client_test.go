package runtimeclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestInitializeRuntimeUsesRuntimeControllerContract(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/runtimes/agent-1/initialize" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Idempotency-Key") != "child-request-1" {
			t.Fatalf("Idempotency-Key = %q", request.Header.Get("Idempotency-Key"))
		}
		var payload struct {
			Configuration struct {
				ImageRef string `json:"image_ref"`
				Network  struct {
					TunnelIPv4 string `json:"tunnel_ipv4"`
				} `json:"network"`
			} `json:"configuration"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.Configuration.ImageRef == "" || payload.Configuration.Network.TunnelIPv4 != "100.64.0.2" {
			t.Fatalf("configuration = %+v", payload.Configuration)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"request_id":"child-request-1",
			"kind":"initialize_runtime",
			"agent_id":"agent-1",
			"target_revision":"rtv_11111111111111111111111111111111",
			"state":"completed",
			"effect":"completed",
			"inspection":{
				"agent_id":"agent-1",
				"runtime_revision":"rtv_11111111111111111111111111111111",
				"lifecycle_state":"provisioned",
				"health":"unknown",
				"mcp_endpoint":"",
				"runtime_execution_id":"",
				"restart_count":0,
				"observed_at":"2026-09-01T00:00:00Z"
			},
			"created_at":"2026-09-01T00:00:00Z",
			"updated_at":"2026-09-01T00:00:01Z"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	result, err := client.InitializeRuntime(
		context.Background(), "child-request-1", "agent-1", runtimeConfiguration(),
	)
	if err != nil {
		t.Fatalf("initialize Runtime: %v", err)
	}
	if result.State != "completed" || result.RuntimeRevision != "rtv_11111111111111111111111111111111" ||
		result.MCPEndpoint != "" || result.Health != "unknown" {
		t.Fatalf("Runtime operation = %+v", result)
	}
}

func TestUpdateRuntimeUsesExpectedRevisionAndCompleteConfiguration(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/runtimes/agent-1/update" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Idempotency-Key") != "child-request-update" {
			t.Fatalf("Idempotency-Key = %q", request.Header.Get("Idempotency-Key"))
		}
		var payload struct {
			ExpectedRevision string                  `json:"expected_revision"`
			Configuration    runtimeConfigurationDTO `json:"configuration"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.ExpectedRevision != "rtv_11111111111111111111111111111111" ||
			payload.Configuration.ImageRef == "" ||
			payload.Configuration.Network.TunnelIPv4 != "100.64.0.2" {
			t.Fatalf("update payload = %+v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"request_id":"child-request-update",
			"kind":"update_runtime",
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
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	result, err := client.UpdateRuntime(
		context.Background(), "child-request-update", "agent-1",
		"rtv_11111111111111111111111111111111", runtimeConfiguration(),
	)
	if err != nil {
		t.Fatalf("update Runtime: %v", err)
	}
	if result.RuntimeRevision != "rtv_22222222222222222222222222222222" ||
		result.RuntimeExecutionID != "" || result.Health != "unknown" {
		t.Fatalf("Runtime operation = %+v", result)
	}
}

func TestDisableRuntimeAcceptsAbsentComputeAndRetainedWorkspaceRevision(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/runtimes/agent-1/disable" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Idempotency-Key") != "child-request-disable" {
			t.Fatalf("Idempotency-Key = %q", request.Header.Get("Idempotency-Key"))
		}
		var payload struct {
			ExpectedRevision string `json:"expected_revision"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.ExpectedRevision != "rtv_11111111111111111111111111111111" {
			t.Fatalf("disable payload = %+v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"request_id":"child-request-disable",
			"kind":"disable_runtime",
			"agent_id":"agent-1",
			"target_revision":"rtv_33333333333333333333333333333333",
			"state":"completed",
			"effect":"completed",
			"inspection":{
				"agent_id":"agent-1",
				"runtime_revision":"rtv_33333333333333333333333333333333",
				"lifecycle_state":"disabled",
				"health":"absent",
				"restart_count":0,
				"observed_at":"2026-09-01T00:00:00Z"
			}
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	result, err := client.DisableRuntime(
		context.Background(), "child-request-disable", "agent-1",
		"rtv_11111111111111111111111111111111",
	)
	if err != nil {
		t.Fatalf("disable Runtime: %v", err)
	}
	if result.RuntimeRevision != "rtv_33333333333333333333333333333333" ||
		result.LifecycleState != "disabled" || result.Health != "absent" ||
		result.RuntimeExecutionID != "" || result.MCPEndpoint != "" {
		t.Fatalf("Runtime operation = %+v", result)
	}
}

func TestEnableRuntimeUsesDisabledRevisionAndCompleteConfiguration(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/runtimes/agent-1/enable" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Idempotency-Key") != "child-request-enable" {
			t.Fatalf("Idempotency-Key = %q", request.Header.Get("Idempotency-Key"))
		}
		var payload struct {
			ExpectedRevision string                  `json:"expected_revision"`
			Configuration    runtimeConfigurationDTO `json:"configuration"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.ExpectedRevision != "rtv_33333333333333333333333333333333" ||
			payload.Configuration.ImageRef == "" ||
			payload.Configuration.Network.TunnelIPv4 != "100.64.0.2" ||
			payload.Configuration.Network.ResolverIPv4 != "100.64.0.1" ||
			payload.Configuration.Network.PacketContractRevision != 1 ||
			payload.Configuration.Network.EgressEndpoint.IPv4 != "10.20.0.8" ||
			payload.Configuration.Network.EgressEndpoint.Port != 8092 ||
			payload.Configuration.Resources.MemoryBytes != 536870912 ||
			payload.Configuration.Resources.PIDsLimit != 256 ||
			payload.Configuration.Resources.TmpfsBytes != 67108864 {
			t.Fatalf("enable payload = %+v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"request_id":"child-request-enable",
			"kind":"enable_runtime",
			"agent_id":"agent-1",
			"target_revision":"rtv_44444444444444444444444444444444",
			"state":"completed",
			"effect":"completed",
			"inspection":{
				"agent_id":"agent-1",
				"runtime_revision":"rtv_44444444444444444444444444444444",
				"lifecycle_state":"provisioned",
				"health":"unknown",
				"mcp_endpoint":"",
				"runtime_execution_id":""
			}
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	result, err := client.EnableRuntime(
		context.Background(), "child-request-enable", "agent-1",
		"rtv_33333333333333333333333333333333", runtimeConfiguration(),
	)
	if err != nil {
		t.Fatalf("enable Runtime: %v", err)
	}
	if result.RuntimeRevision != "rtv_44444444444444444444444444444444" ||
		result.RuntimeExecutionID != "" || result.Health != "unknown" || result.LifecycleState != "provisioned" {
		t.Fatalf("Runtime operation = %+v", result)
	}
}

func TestDeleteRuntimeUsesRevisionFenceAndRequiresDeletedInspection(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/internal/runtimes/agent-1/delete" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Idempotency-Key") != "child-request-delete" {
			t.Fatalf("Idempotency-Key = %q", request.Header.Get("Idempotency-Key"))
		}
		var payload struct {
			ExpectedRevision string `json:"expected_revision"`
		}
		if err := json.NewDecoder(request.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		if payload.ExpectedRevision != "rtv_11111111111111111111111111111111" {
			t.Fatalf("delete payload = %+v", payload)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"request_id":"child-request-delete",
			"kind":"delete_runtime",
			"agent_id":"agent-1",
			"target_revision":"rtv_22222222222222222222222222222222",
			"state":"completed",
			"effect":"completed",
			"inspection":{
				"agent_id":"agent-1",
				"runtime_revision":"rtv_22222222222222222222222222222222",
				"lifecycle_state":"deleted",
				"health":"absent"
			}
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	result, err := client.DeleteRuntime(
		context.Background(), "child-request-delete", "agent-1",
		"rtv_11111111111111111111111111111111",
	)
	if err != nil {
		t.Fatalf("delete Runtime: %v", err)
	}
	if result.RuntimeRevision != "rtv_22222222222222222222222222222222" ||
		result.LifecycleState != "deleted" || result.Health != "absent" ||
		result.RuntimeExecutionID != "" || result.MCPEndpoint != "" {
		t.Fatalf("Runtime operation = %+v", result)
	}
}

func TestInspectRuntimeReturnsAuthoritativeReadyBinding(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/internal/runtimes/agent-1" {
			t.Fatalf("request = %s %s", request.Method, request.URL.Path)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"agent_id":"agent-1",
			"runtime_revision":"rtv_11111111111111111111111111111111",
			"lifecycle_state":"provisioned",
			"health":"healthy",
			"mcp_endpoint":"http://runtime-agent:8091/mcp",
			"runtime_execution_id":"execution-1",
			"restart_count":0,
			"observed_at":"2026-09-01T00:00:00Z"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	inspection, err := client.InspectRuntime(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("inspect Runtime: %v", err)
	}
	if inspection.AgentID != "agent-1" ||
		inspection.RuntimeRevision != "rtv_11111111111111111111111111111111" ||
		inspection.RuntimeExecutionID != "execution-1" ||
		inspection.MCPEndpoint != "http://runtime-agent:8091/mcp" ||
		inspection.LifecycleState != "provisioned" || inspection.Health != "healthy" {
		t.Fatalf("Runtime inspection = %+v", inspection)
	}
}

func TestInspectRuntimeRejectsIncoherentReadyBinding(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"agent_id":"agent-1",
			"runtime_revision":"rtv_11111111111111111111111111111111",
			"lifecycle_state":"provisioned",
			"health":"healthy"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	_, err = client.InspectRuntime(context.Background(), "agent-1")
	var dependencyError *ports.DependencyError
	if !errors.As(err, &dependencyError) || dependencyError.Code != "invalid_response" ||
		!dependencyError.Retryable {
		t.Fatalf("dependency error = %#v (%v)", dependencyError, err)
	}
}

func TestInitializeRuntimeReturnsStableDependencyFailure(t *testing.T) {
	t.Parallel()

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Type", "application/json")
		response.WriteHeader(http.StatusConflict)
		_, _ = response.Write([]byte(`{"code":"runtime_lifecycle_conflict","message":"conflict","retryable":false}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}

	_, err = client.InitializeRuntime(context.Background(), "child-request-1", "agent-1", runtimeConfiguration())
	var dependencyError *ports.DependencyError
	if !errors.As(err, &dependencyError) || dependencyError.Service != "runtime-controller" ||
		dependencyError.Code != "runtime_lifecycle_conflict" || dependencyError.Retryable {
		t.Fatalf("dependency error = %#v (%v)", dependencyError, err)
	}
}

func TestInitializeRuntimePropagatesTraceContext(t *testing.T) {
	previous := otel.GetTextMapPropagator()
	otel.SetTextMapPropagator(propagation.TraceContext{})
	t.Cleanup(func() { otel.SetTextMapPropagator(previous) })

	const expected = "00-11111111111111111111111111111111-2222222222222222-01"
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if actual := request.Header.Get("traceparent"); actual != expected {
			t.Fatalf("traceparent = %q, want %q", actual, expected)
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{
			"request_id":"child-request-1",
			"kind":"initialize_runtime",
			"agent_id":"agent-1",
			"target_revision":"rtv_11111111111111111111111111111111",
			"state":"completed",
			"effect":"completed",
			"inspection":{
				"agent_id":"agent-1",
				"runtime_revision":"rtv_11111111111111111111111111111111",
				"lifecycle_state":"provisioned",
				"health":"unknown",
				"mcp_endpoint":"",
				"runtime_execution_id":"",
				"restart_count":0,
				"observed_at":"2026-09-01T00:00:00Z"
			},
			"created_at":"2026-09-01T00:00:00Z",
			"updated_at":"2026-09-01T00:00:01Z"
		}`))
	}))
	t.Cleanup(server.Close)
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatalf("new client: %v", err)
	}
	ctx := trace.ContextWithRemoteSpanContext(context.Background(), trace.NewSpanContext(trace.SpanContextConfig{
		TraceID: trace.TraceID{0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11,
			0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x11},
		SpanID:     trace.SpanID{0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22},
		TraceFlags: trace.FlagsSampled, Remote: true,
	}))
	if _, err := client.InitializeRuntime(ctx, "child-request-1", "agent-1", runtimeConfiguration()); err != nil {
		t.Fatalf("initialize Runtime: %v", err)
	}
}

func TestInitializeRuntimeRejectsContradictoryCompletedResponse(t *testing.T) {
	t.Parallel()

	valid := `{
		"request_id":"child-request-1",
		"kind":"initialize_runtime",
		"agent_id":"agent-1",
		"target_revision":"rtv_11111111111111111111111111111111",
		"state":"completed",
		"effect":"completed",
		"inspection":{
			"agent_id":"agent-1",
			"runtime_revision":"rtv_11111111111111111111111111111111",
			"lifecycle_state":"provisioned",
			"health":"unknown",
			"mcp_endpoint":"",
			"runtime_execution_id":""
		}
	}`
	tests := []struct {
		name string
		body string
	}{
		{name: "effect not confirmed", body: strings.Replace(valid, `"effect":"completed"`, `"effect":"unknown"`, 1)},
		{name: "invalid endpoint", body: strings.Replace(valid, `"mcp_endpoint":""`, `"mcp_endpoint":"not-a-uri"`, 1)},
		{name: "non canonical endpoint", body: strings.Replace(valid, `"mcp_endpoint":""`, `"mcp_endpoint":" http://runtime-agent:8091/mcp "`, 1)},
		{name: "invalid revision", body: strings.ReplaceAll(valid, "rtv_11111111111111111111111111111111", "runtime-revision")},
		{name: "failed but effect completed", body: strings.Replace(valid, `"state":"completed"`, `"state":"failed"`, 1)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
				response.Header().Set("Content-Type", "application/json")
				_, _ = response.Write([]byte(test.body))
			}))
			t.Cleanup(server.Close)
			client, err := New(server.URL, time.Second, server.Client())
			if err != nil {
				t.Fatalf("new client: %v", err)
			}

			_, err = client.InitializeRuntime(
				context.Background(), "child-request-1", "agent-1", runtimeConfiguration(),
			)
			var dependencyError *ports.DependencyError
			if !errors.As(err, &dependencyError) || dependencyError.Code != "invalid_response" {
				t.Fatalf("dependency error = %#v (%v)", dependencyError, err)
			}
		})
	}
}

func runtimeConfiguration() ports.RuntimeConfiguration {
	return ports.RuntimeConfiguration{
		ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Network: ports.NetworkAttachment{
			AgentID: "agent-1", TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
			PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		},
		Resources: domain.RuntimeResources{
			MemoryBytes: 536870912, PIDsLimit: 256, TmpfsBytes: 67108864,
		},
	}
}
