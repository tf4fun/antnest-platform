package ports

import (
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func failedCreateRetryBase() AgentLifecycleBase {
	now := time.Now()
	spec := AgentSpecRecord{ID: "spec-source", AgentID: "agent-1", Revision: 1, CreatedAt: now}
	return AgentLifecycleBase{
		Agent: AgentRecord{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentNotCreated,
			AggregateSequence: 2, CreatedAt: now, UpdatedAt: now,
		},
		ConfiguredSpec:   spec,
		NextSpecRevision: 2,
		FailedCreateOperation: &LifecycleOperationRecord{
			RequestID: "request-create", AgentID: "agent-1", Kind: domain.OperationCreate,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationFailed,
			ErrorCode: "dependency_unavailable", TargetSpecRevisionID: "spec-source",
			CreatedAt: now, UpdatedAt: now,
		},
	}
}

func TestFailedCreateRebuildSourceMatches(t *testing.T) {
	base := failedCreateRetryBase()
	if !FailedCreateRebuildSourceMatches(base) {
		t.Fatal("valid retry source must match")
	}
	rejections := []struct {
		name   string
		mutate func(*AgentLifecycleBase)
	}{
		{"created agent", func(b *AgentLifecycleBase) { b.Agent.LifecycleState = domain.AgentCreated }},
		{"deleted desired", func(b *AgentLifecycleBase) { b.Agent.DesiredState = domain.DesiredDeleted }},
		{"active operation", func(b *AgentLifecycleBase) { b.Agent.ActiveOperationRequestID = "op-active" }},
		{"runtime revision", func(b *AgentLifecycleBase) { b.Agent.RuntimeRevision = "runtime-1" }},
		{"execution pointer", func(b *AgentLifecycleBase) { b.Agent.ExecutionRevisionID = "exec-1" }},
		{"success pointer", func(b *AgentLifecycleBase) { b.Agent.LastSuccessfulExecutionRevisionID = "exec-1" }},
		{"revoked identity", func(b *AgentLifecycleBase) {
			b.Agent.OwnerAuthorizationSequence, b.Agent.IdentityRevocationSequence = 1, 2
		}},
		{"terminated", func(b *AgentLifecycleBase) { b.Agent.FailureCode = "lifecycle_cancelled" }},
		{"quarantine code", func(b *AgentLifecycleBase) { b.Agent.FailureCode = "lifecycle_invariant_failed" }},
		{"missing op", func(b *AgentLifecycleBase) { b.FailedCreateOperation = nil }},
		{"wrong agent", func(b *AgentLifecycleBase) { b.FailedCreateOperation.AgentID = "other" }},
		{"wrong kind", func(b *AgentLifecycleBase) { b.FailedCreateOperation.Kind = domain.OperationRebuild }},
		{"running op", func(b *AgentLifecycleBase) { b.FailedCreateOperation.State = domain.OperationRunning }},
		{"later phase", func(b *AgentLifecycleBase) { b.FailedCreateOperation.Phase = domain.PhaseRuntimeInitialize }},
		{"cancelled op", func(b *AgentLifecycleBase) { b.FailedCreateOperation.ErrorCode = "lifecycle_cancelled" }},
		{"quarantined op", func(b *AgentLifecycleBase) { b.FailedCreateOperation.ErrorCode = "lifecycle_invariant_failed" }},
		{"source runtime", func(b *AgentLifecycleBase) { b.FailedCreateOperation.SourceRuntimeRevision = "runtime-1" }},
		{"absence claim", func(b *AgentLifecycleBase) { b.FailedCreateOperation.SourceRuntimeAbsent = true }},
		{"source execution", func(b *AgentLifecycleBase) { b.FailedCreateOperation.SourceExecutionRevisionID = "exec-1" }},
		{"source spec set", func(b *AgentLifecycleBase) { b.FailedCreateOperation.SourceSpecRevisionID = "spec-x" }},
		{"empty target", func(b *AgentLifecycleBase) { b.FailedCreateOperation.TargetSpecRevisionID = "" }},
		{"spec mismatch", func(b *AgentLifecycleBase) { b.ConfiguredSpec.ID = "spec-other" }},
		{"spec agent mismatch", func(b *AgentLifecycleBase) { b.ConfiguredSpec.AgentID = "other" }},
		{"stored spec mismatch", func(b *AgentLifecycleBase) { b.Agent.AgentSpecRevisionID = "spec-other" }},
		{"source execution present", func(b *AgentLifecycleBase) { b.SourceExecution.ID = "exec-1" }},
		{"stale revision", func(b *AgentLifecycleBase) { b.NextSpecRevision = 1 }},
	}
	for _, tc := range rejections {
		b := failedCreateRetryBase()
		tc.mutate(&b)
		if FailedCreateRebuildSourceMatches(b) {
			t.Fatalf("%s must reject the retry source", tc.name)
		}
	}
	stored := failedCreateRetryBase()
	stored.Agent.AgentSpecRevisionID = "spec-source"
	if !FailedCreateRebuildSourceMatches(stored) {
		t.Fatal("matching stored spec pointer must not reject")
	}
	deadline := failedCreateRetryBase()
	deadline.Agent.FailureStage = string(domain.PhaseNetworkEnsure)
	deadline.Agent.FailureCode = "phase_deadline_exceeded"
	deadline.FailedCreateOperation.ErrorCode = "phase_deadline_exceeded"
	if !FailedCreateRebuildSourceMatches(deadline) {
		t.Fatal("the Egress-down deadline retry must remain eligible")
	}
}
