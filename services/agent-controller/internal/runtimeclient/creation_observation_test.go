package runtimeclient

import "testing"

func TestProvisioningCompletionDoesNotRequireExecution(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"initialize_runtime", "update_runtime", "enable_runtime"} {
		t.Run(kind, func(t *testing.T) {
			t.Parallel()
			operation := runtimeOperationDTO{
				Kind: kind, AgentID: "agent-1", TargetRevision: "rtv_11111111111111111111111111111111",
				State: "completed", Effect: "completed",
				Inspection: &runtimeInspectionDTO{
					AgentID: "agent-1", RuntimeRevision: "rtv_11111111111111111111111111111111",
					LifecycleState: "provisioned", Health: "unknown",
				},
			}
			if !validRuntimeOperation(operation, completionProvisioned) {
				t.Fatal("confirmed resource creation must not require a healthy execution")
			}
			operation.Inspection.RuntimeExecutionID = "not-observed"
			if validRuntimeOperation(operation, completionProvisioned) {
				t.Fatal("creation completion must not manufacture an execution binding")
			}
		})
	}
}

func TestProvisionedInspectionSeparatesHealthFromCreation(t *testing.T) {
	t.Parallel()
	inspection := runtimeInspectionDTO{
		AgentID: "agent-1", RuntimeRevision: "rtv_11111111111111111111111111111111",
		LifecycleState: "provisioned", Health: "starting",
	}
	if !validRuntimeInspection(inspection) {
		t.Fatal("a created Runtime may still be starting")
	}
	inspection.Health = "healthy"
	if validRuntimeInspection(inspection) {
		t.Fatal("healthy observation requires an execution and endpoint")
	}
	inspection.RuntimeExecutionID = "execution-1"
	inspection.MCPEndpoint = "http://runtime-agent:8091/mcp"
	if !validRuntimeInspection(inspection) {
		t.Fatal("healthy observed binding was rejected")
	}
}
