package postgres

import (
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
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

func TestValidEnableFailureRequiresExactDisabledRuntimeBeforeRuntimeEffect(t *testing.T) {
	t.Parallel()

	operation := ports.LifecycleOperationRecord{
		RequestID: "request-enable", AgentID: "agent-1",
		Kind: domain.OperationEnable, Phase: domain.PhaseNetworkEnsure,
		State:                 domain.OperationRunning,
		SourceRuntimeRevision: "rtv_11111111111111111111111111111111",
	}
	input := ports.FailAgentEnable{
		Stage: domain.PhaseNetworkEnsure, Code: "policy_restore_conflict",
		Now: time.Unix(1, 0).UTC(),
	}
	if validEnableFailure(input, operation) {
		t.Fatal("Enable failure without Runtime proof was accepted")
	}
	inspection := ports.RuntimeInspection{
		AgentID: "agent-1", RuntimeRevision: operation.SourceRuntimeRevision,
		LifecycleState: "disabled", Health: "absent",
	}
	input.SourceRuntimeInspection = &inspection
	if !validEnableFailure(input, operation) {
		t.Fatal("Enable failure with exact disabled Runtime proof was rejected")
	}
	inspection.RuntimeRevision = "rtv_22222222222222222222222222222222"
	if validEnableFailure(input, operation) {
		t.Fatal("Enable failure with mismatched Runtime proof was accepted")
	}
}
