package postgres

import "soft/antnest-platform/services/agent-controller/internal/ports"

type runtimeInvalidation struct {
	code      string
	eventType string
	detail    string
}

func runtimeObservationInvalidation(kind string) (runtimeInvalidation, bool) {
	switch kind {
	case ports.RuntimeObservationRestarted, "runtime_execution_changed":
		code := "runtime_restarted"
		if kind == "runtime_execution_changed" {
			code = kind
		}
		return runtimeInvalidation{
			code: code, eventType: ports.EventAgentRuntimeRestarted,
			detail: "Runtime process identity changed outside an Agent lifecycle operation; explicit lifecycle recovery is required",
		}, true
	case ports.RuntimeObservationMissing, ports.RuntimeObservationDeleted:
		return runtimeInvalidation{
			code: kind, eventType: ports.EventAgentRuntimeMissing,
			detail: "Runtime container is missing; the prior execution binding is unavailable and explicit lifecycle recovery is required",
		}, true
	case "exited":
		return runtimeInvalidation{code: "runtime_exited", eventType: ports.EventAgentRuntimeMissing,
			detail: "Runtime process exited; explicit lifecycle recovery is required"}, true
	default:
		return runtimeInvalidation{}, false
	}
}

func runtimeSnapshotInvalidation(runtime ports.RuntimeEnvironmentSnapshot) (runtimeInvalidation, string, bool) {
	if runtime.LifecycleState != "provisioned" {
		return runtimeInvalidation{}, "", false
	}
	if runtime.Phase == "exited" {
		invalidation, ok := runtimeObservationInvalidation("exited")
		return invalidation, "", ok
	}
	if runtime.Health == "absent" {
		invalidation, ok := runtimeObservationInvalidation(ports.RuntimeObservationMissing)
		return invalidation, "", ok
	}
	if runtime.Health == "healthy" && runtime.RuntimeExecutionID != "" {
		invalidation, ok := runtimeObservationInvalidation("runtime_execution_changed")
		return invalidation, runtime.RuntimeExecutionID, ok
	}
	return runtimeInvalidation{}, "", false
}

func currentRuntimeInvalidation(current ports.RuntimeInspection) (runtimeInvalidation, string, bool) {
	return runtimeSnapshotInvalidation(ports.RuntimeEnvironmentSnapshot{
		AgentID: current.AgentID, RuntimeRevision: current.RuntimeRevision, RuntimeExecutionID: current.RuntimeExecutionID,
		LifecycleState: current.LifecycleState, Phase: current.Phase, Health: current.Health,
	})
}
