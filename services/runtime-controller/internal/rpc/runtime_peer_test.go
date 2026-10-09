package rpc

import (
	"encoding/json"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRuntimeInspectionReportsPeerIndependentlyOfExecutionReadiness(t *testing.T) {
	environment := deployment.Environment{
		AgentID: "agent-1", LifecycleState: deployment.LifecycleProvisioned,
		Phase: deployment.PhaseRunning, Health: deployment.HealthStarting,
		RuntimeEndpoint: "10.243.1.20", TunnelKeyID: "rtk_0123456789abcdef0123456789abcdef",
	}
	encoded, err := json.Marshal(runtimeInspectionFromDomain(environment))
	if err != nil {
		t.Fatal(err)
	}
	var response map[string]any
	if err := json.Unmarshal(encoded, &response); err != nil {
		t.Fatal(err)
	}
	if response["runtime_endpoint"] != "10.243.1.20" || response["tunnel_key_id"] != "rtk_0123456789abcdef0123456789abcdef" {
		t.Fatal("current Runtime peer address was omitted", response)
	}
	if _, ok := response["mcp_endpoint"]; ok {
		t.Fatal("invented MCP readiness")
	}
	if _, ok := response["runtime_execution_id"]; ok {
		t.Fatal("invented execution identity")
	}
}
