package postgres

import (
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestValidDeleteBeginBindsRuntimeEvidenceToAgentProjection(t *testing.T) {
	t.Parallel()

	now := time.Now().Add(-15 * time.Second).UTC().Truncate(time.Microsecond)
	agent := deleteAgentBaseRecord()
	valid := deleteBegin(agent, "request-delete-valid", strings.Repeat("a", 64), now)
	if !validDeleteBegin(agent, valid) {
		t.Fatal("matching Runtime revision was rejected")
	}

	wrongRevision := valid
	wrongRevision.Operation.SourceRuntimeRevision = "rtv_wrong_revision"
	if validDeleteBegin(agent, wrongRevision) {
		t.Fatal("delete accepted a Runtime revision not owned by the Agent projection")
	}

	agent.RuntimeRevision = ""
	agent.RuntimeExecutionID = ""
	agent.RuntimeMCPEndpoint = ""
	absent := deleteBegin(agent, "request-delete-absent", strings.Repeat("b", 64), now)
	absent.Operation.SourceRuntimeRevision = ""
	absent.Operation.SourceRuntimeAbsent = true
	if validDeleteBegin(agent, absent) {
		t.Fatal("delete accepted an unstructured Runtime absence claim")
	}
	absent.Operation.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{
		Reason: "runtime_not_found", ObservedAt: now,
	}
	if !validDeleteBegin(agent, absent) {
		t.Fatal("authoritative Runtime absence proof was rejected")
	}

	orphan := deleteBegin(agent, "request-delete-orphan", strings.Repeat("c", 64), now)
	orphan.Operation.SourceRuntimeRevision = "rtv_orphan"
	orphan.Operation.SourceRuntimeInspection = &ports.RuntimeInspection{
		AgentID: agent.AgentID, RuntimeRevision: "rtv_orphan",
		LifecycleState: "provisioned", Health: "healthy",
	}
	if !validDeleteBegin(agent, orphan) {
		t.Fatal("matching inspected orphan Runtime was rejected")
	}
	orphan.Operation.SourceRuntimeInspection.AgentID = "another-agent"
	if validDeleteBegin(agent, orphan) {
		t.Fatal("delete accepted another Agent's inspected Runtime")
	}
}

func TestValidDeleteAdvanceRequiresExplicitNetworkReleaseOutcome(t *testing.T) {
	t.Parallel()

	operation := ports.LifecycleOperationRecord{
		RequestID: "request-delete-release", AgentID: "agent-delete",
		Kind: domain.OperationDelete, Phase: domain.PhaseNetworkRelease,
		State: domain.OperationRunning,
	}
	input := ports.AdvanceAgentDelete{
		RequestID: operation.RequestID, ExpectedPhase: domain.PhaseNetworkRelease,
		NextPhase:          domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(operation.RequestID, domain.PhasePublish),
	}
	if validDeleteAdvance(operation, input) {
		t.Fatal("delete accepted a missing network release result")
	}
	input.NetworkReleaseOutcome = ports.NetworkReleaseAuthoritativeNone
	if validDeleteAdvance(operation, input) {
		t.Fatal("network absence was accepted before Runtime cleanup proof")
	}
	operation.RuntimeResult = &ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: "rtv_deleted",
		LifecycleState: "deleted", Health: "absent",
	}
	if !validDeleteAdvance(operation, input) {
		t.Fatal("authoritative missing network result was rejected")
	}
}

func deleteBegin(
	agent ports.AgentRecord, requestID string, fingerprint string, now time.Time,
) ports.BeginAgentDelete {
	deadline := now.Add(time.Minute)
	return ports.BeginAgentDelete{
		AgentID: agent.AgentID, ExpectedAggregateSequence: agent.AggregateSequence,
		ExpectedDesiredState: agent.DesiredState, ExpectedLifecycleState: agent.LifecycleState,
		ExpectedRuntimeRevision: agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: fingerprint,
			AgentID: agent.AgentID, Kind: domain.OperationDelete,
			DrainDeadlineAt: &deadline,
			Phase:           domain.PhaseDrain, State: domain.OperationRunning,
			SourceRuntimeRevision: agent.RuntimeRevision,
			ChildRequestID:        domain.ChildRequestID(requestID, domain.PhaseDrain),
			CreatedAt:             now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-delete-requested-" + requestID,
			AgentID: agent.AgentID, AggregateSequence: agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDeleteRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now,
		},
		Now: now,
	}
}

func deleteAgentBaseRecord() ports.AgentRecord {
	now := time.Now().Add(-15 * time.Second).UTC().Truncate(time.Microsecond)
	return ports.AgentRecord{
		AgentID: "agent-delete-proof", OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Delete Proof Agent", DesiredState: domain.DesiredEnabled,
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, AccessRevision: "access-delete-proof",
		AgentSpecRevisionID: "spec-delete-proof", ExecutionRevisionID: "execution-delete-proof",
		LastSuccessfulExecutionRevisionID: "execution-delete-proof",
		RuntimeRevision:                   "rtv_delete_proof", RuntimeExecutionID: "runtime-delete-proof",
		RuntimeMCPEndpoint: "http://runtime-delete-proof:8091/mcp",
		AggregateSequence:  3, CreatedAt: now, UpdatedAt: now,
	}
}
