package runtimeclient

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestInitializeReconcilesRecordedFailures(t *testing.T) {
	t.Parallel()
	for _, effect := range []string{"not_started", "completed"} {
		t.Run(effect, func(t *testing.T) {
			code := "platform_unavailable"
			if effect == "completed" {
				code = "runtime_not_ready"
			}
			reads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.Method == http.MethodPost {
					status := http.StatusServiceUnavailable
					if effect == "completed" {
						status = http.StatusInternalServerError
					}
					w.WriteHeader(status)
					_ = json.NewEncoder(w).Encode(map[string]any{"code": code, "retryable": effect == "not_started"})
					return
				}
				reads++
				if r.URL.Path != "/internal/runtime-operations/child-failure" {
					t.Errorf("unexpected journal request: %s", r.URL.Path)
				}
				_ = json.NewEncoder(w).Encode(failedRuntimeOperation(effect, code))
			}))
			t.Cleanup(server.Close)
			client := failureTestClient(t, server)
			result, err := client.InitializeRuntime(context.Background(), "child-failure", "agent-1", runtimeConfiguration())
			if err != nil || result.State != "failed" || result.Effect != effect || result.ErrorCode != code || reads != 1 {
				t.Fatalf("recorded failure not consumed: %+v %v reads=%d", result, err, reads)
			}
		})
	}
}

func TestInitializeRejectsForeignOperationAndPreservesUnknown(t *testing.T) {
	t.Parallel()
	for _, foreign := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown", true: "foreign"}[foreign], func(t *testing.T) {
			operation := failedRuntimeOperation("completed", "runtime_not_ready")
			operation.State = "unknown"
			operation.Inspection.LifecycleState = "unknown"
			if foreign {
				operation.RequestID = "another-request"
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusAccepted)
				_ = json.NewEncoder(w).Encode(operation)
			}))
			t.Cleanup(server.Close)
			result, err := failureTestClient(t, server).InitializeRuntime(context.Background(), "child-failure", "agent-1", runtimeConfiguration())
			if foreign {
				var dependency *ports.DependencyError
				if !errors.As(err, &dependency) || dependency.Code != "invalid_response" || !dependency.Retryable {
					t.Fatalf("foreign result accepted: %+v %v", result, err)
				}
				return
			}
			if err != nil || result.State != "unknown" || result.Effect != "completed" {
				t.Fatalf("unknown completed effect rejected: %+v %v", result, err)
			}
		})
	}
}

func TestInspectFailedRuntimeRetainsNonExecutableOwnership(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(failedRuntimeOperation("completed", "runtime_not_ready").Inspection)
	}))
	t.Cleanup(server.Close)
	inspection, err := failureTestClient(t, server).InspectRuntime(context.Background(), "agent-1")
	if err != nil || inspection.LifecycleState != "failed" || inspection.RuntimeRevision == "" || inspection.MCPEndpoint != "" {
		t.Fatalf("failed ownership lost: %+v %v", inspection, err)
	}
}

func TestDegradedRuntimeOwnershipIsInspectableButNotPublishable(t *testing.T) {
	t.Parallel()
	for _, lifecycle := range []string{"provisioned", "disabled"} {
		t.Run(lifecycle, func(t *testing.T) {
			operation := failedRuntimeOperation("completed", "")
			operation.State = "completed"
			operation.Inspection.LifecycleState = lifecycle
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodGet {
					_ = json.NewEncoder(w).Encode(operation.Inspection)
					return
				}
				_ = json.NewEncoder(w).Encode(operation)
			}))
			t.Cleanup(server.Close)
			client := failureTestClient(t, server)
			inspection, err := client.InspectRuntime(context.Background(), "agent-1")
			if err != nil || inspection.Health != "unhealthy" || inspection.RuntimeRevision != operation.TargetRevision {
				t.Fatalf("degraded ownership cannot be cleaned up: %+v %v", inspection, err)
			}
			_, err = client.InitializeRuntime(context.Background(), "child-failure", "agent-1", runtimeConfiguration())
			var failure *ports.DependencyError
			if !errors.As(err, &failure) || failure.Code != "invalid_response" {
				t.Fatalf("degraded ownership was publishable: %v", err)
			}
		})
	}
}

func TestFailureJournalDoesNotInventTerminalResults(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name          string
		postCode      string
		journalStatus int
		wantCode      string
		wantReads     int
	}{
		{"missing", "platform_unavailable", http.StatusNotFound, "platform_unavailable", 1},
		{"unavailable", "platform_unavailable", http.StatusServiceUnavailable, "operation_unverified", 1},
		{"foreign", "platform_unavailable", http.StatusOK, "invalid_response", 1},
		{"conflicting_key", "request_id_conflict", http.StatusOK, "request_id_conflict", 0},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			reads := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method == http.MethodPost {
					w.WriteHeader(http.StatusServiceUnavailable)
					_ = json.NewEncoder(w).Encode(map[string]any{"code": test.postCode, "retryable": test.postCode != "request_id_conflict"})
					return
				}
				reads++
				w.WriteHeader(test.journalStatus)
				if test.journalStatus == http.StatusOK {
					operation := failedRuntimeOperation("completed", "runtime_not_ready")
					operation.RequestID = "somebody-elses-command"
					_ = json.NewEncoder(w).Encode(operation)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"code": "operation_not_found", "retryable": false})
			}))
			t.Cleanup(server.Close)
			_, err := failureTestClient(t, server).InitializeRuntime(context.Background(), "child-failure", "agent-1", runtimeConfiguration())
			var failure *ports.DependencyError
			if !errors.As(err, &failure) || failure.Code != test.wantCode || failure.Retryable != (test.name != "conflicting_key") || reads != test.wantReads {
				t.Fatalf("unsafe failure reconciliation: %v reads=%d", err, reads)
			}
		})
	}
}

func failedRuntimeOperation(effect, code string) runtimeOperationDTO {
	return runtimeOperationDTO{
		RequestID: "child-failure", Kind: "initialize_runtime", AgentID: "agent-1",
		TargetRevision: "rtv_11111111111111111111111111111111", State: "failed", Effect: effect,
		ErrorCode: code, ErrorDetail: "Runtime did not become ready; inspect required MCP processes",
		Inspection: &runtimeInspectionDTO{
			AgentID: "agent-1", RuntimeRevision: "rtv_11111111111111111111111111111111",
			LifecycleState: "failed", Health: "unhealthy",
		},
	}
}

func failureTestClient(t *testing.T, server *httptest.Server) *Client {
	t.Helper()
	client, err := New(server.URL, time.Second, server.Client())
	if err != nil {
		t.Fatal(err)
	}
	return client
}
