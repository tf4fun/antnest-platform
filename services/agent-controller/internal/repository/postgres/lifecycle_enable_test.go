package postgres

import (
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestValidEnableEventRejectsCrossAggregateAuditData(t *testing.T) {
	t.Parallel()

	operation := ports.LifecycleOperationRecord{
		RequestID: "request-enable", AgentID: "agent-1",
		Kind: domain.OperationEnable, Phase: domain.PhasePublish,
		State: domain.OperationRunning,
	}
	valid := ports.AgentEventRecord{
		EventID: "event-enabled", AgentID: "agent-1", AggregateSequence: 4,
		SchemaVersion: 1, EventType: ports.EventAgentEnabled,
		OperationRequestID: "request-enable", Data: map[string]any{},
		OccurredAt: time.Unix(1, 0).UTC(),
	}
	if !validEnableEvent(valid, operation, ports.EventAgentEnabled, 4) {
		t.Fatal("valid enable event was rejected")
	}

	tests := []struct {
		name   string
		mutate func(*ports.AgentEventRecord)
	}{
		{name: "other Agent", mutate: func(event *ports.AgentEventRecord) { event.AgentID = "agent-2" }},
		{name: "other operation", mutate: func(event *ports.AgentEventRecord) { event.OperationRequestID = "request-other" }},
		{name: "wrong type", mutate: func(event *ports.AgentEventRecord) { event.EventType = ports.EventAgentDisabled }},
		{name: "wrong schema", mutate: func(event *ports.AgentEventRecord) { event.SchemaVersion = 2 }},
		{name: "missing data", mutate: func(event *ports.AgentEventRecord) { event.Data = nil }},
	}
	for _, testCase := range tests {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			candidate := valid
			testCase.mutate(&candidate)
			if validEnableEvent(candidate, operation, ports.EventAgentEnabled, 4) {
				t.Fatalf("invalid event was accepted: %+v", candidate)
			}
		})
	}
}

func TestValidEnableFailureCannotTerminateAfterRuntimeEffect(t *testing.T) {
	t.Parallel()

	operation := ports.LifecycleOperationRecord{
		RequestID: "request-enable", AgentID: "agent-1",
		Kind: domain.OperationEnable, Phase: domain.PhaseRuntimeEnable,
		State:                 domain.OperationRunning,
		SourceRuntimeRevision: "rtv_11111111111111111111111111111111",
	}
	inspection := ports.RuntimeInspection{
		AgentID: "agent-1", RuntimeRevision: operation.SourceRuntimeRevision,
		LifecycleState: "disabled", Health: "absent",
	}
	input := ports.FailAgentEnable{
		Stage: domain.PhaseRuntimeEnable, Code: "runtime_enable_rejected",
		SourceRuntimeInspection: &inspection,
		Now:                     time.Unix(1, 0).UTC(),
	}
	if !validEnableFailure(input, operation) {
		t.Fatal("proven pre-effect Runtime failure was rejected")
	}

	operation.Phase = domain.PhaseNetworkRestore
	if validEnableFailure(input, operation) {
		t.Fatal("post-ready Runtime failure was accepted as terminal")
	}
}
