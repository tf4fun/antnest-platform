package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func reliabilitySeedCreate(
	t *testing.T, repository *Repository, base ports.AgentLifecycleBase, id string,
) ports.LifecycleOperationRecord {
	t.Helper()
	input := identityCreate(base, id, base.Agent.OrganizationID, 0)
	input.Agent.LifecycleState = domain.AgentNotCreated
	input.Agent.ActivationState = ""
	if _, _, err := repository.BeginAgentCreate(context.Background(), input); err != nil {
		t.Fatalf("seed create %s: %v", id, err)
	}
	return input.Operation
}

func reliabilityEvents(t *testing.T, repository *Repository, eventType, agentID string) int {
	t.Helper()
	var count int
	if err := repository.pool.QueryRow(context.Background(),
		"SELECT count(*) FROM agent_controller.agent_events WHERE event_type = $1 AND agent_id = $2",
		eventType, agentID).Scan(&count); err != nil {
		t.Fatalf("count %s: %v", eventType, err)
	}
	return count
}

func TestTerminateLifecycleOperationMarksTerminalWithPhaseCAS(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	operation := reliabilitySeedCreate(t, repository, base, "terminate-agent")
	termination := ports.TerminateLifecycleOperation{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, ErrorCode: "lifecycle_cancelled",
		ErrorDetail: "administrator cancelled create", EventID: "event-termination-terminate-agent",
	}
	record, err := repository.TerminateLifecycleOperation(ctx, termination)
	if err != nil {
		t.Fatal(err)
	}
	if record.State != domain.OperationFailed || record.ErrorCode != "lifecycle_cancelled" ||
		record.Kind != domain.OperationCreate || record.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("terminated record: %+v", record)
	}
	agent, err := loadAgentRecord(ctx, repository.pool, operation.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	if agent.ActiveOperationRequestID != "" || agent.RuntimeExecutionID != "" ||
		agent.RuntimeMCPEndpoint != "" || agent.ExecutionRevisionID != "" {
		t.Fatalf("terminal Agent still executes: %+v", agent)
	}
	if agent.AgentSpecRevisionID == "" || agent.DesiredState != domain.DesiredEnabled ||
		agent.RuntimeState != domain.RuntimeUnknown || agent.FailureCode != "lifecycle_cancelled" {
		t.Fatalf("termination destroyed configured source: %+v", agent)
	}
	if reliabilityEvents(t, repository, "agent_lifecycle_cancelled", operation.AgentID) != 1 {
		t.Fatal("agent_lifecycle_cancelled event missing")
	}
	replayed, err := repository.TerminateLifecycleOperation(ctx, termination)
	if err != nil {
		t.Fatal(err)
	}
	if replayed.State != record.State || replayed.ErrorCode != record.ErrorCode ||
		replayed.UpdatedAt != record.UpdatedAt {
		t.Fatalf("terminal replay mutated record: %+v", replayed)
	}
	if reliabilityEvents(t, repository, "agent_lifecycle_cancelled", operation.AgentID) != 1 {
		t.Fatal("replay duplicated cancellation event")
	}
}

func TestTerminateLifecycleOperationRejectsStalePhaseAndFingerprint(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	operation := reliabilitySeedCreate(t, repository, base, "terminate-stale")
	termination := ports.TerminateLifecycleOperation{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseRuntimeInitialize, ErrorCode: "lifecycle_cancelled",
		ErrorDetail: "stale phase", EventID: "event-terminate-stale",
	}
	if _, err := repository.TerminateLifecycleOperation(ctx, termination); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale phase = %v", err)
	}
	termination.ExpectedPhase = domain.PhaseNetworkEnsure
	termination.Fingerprint = strings.Repeat("f", 64)
	if _, err := repository.TerminateLifecycleOperation(ctx, termination); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("foreign fingerprint = %v", err)
	}
	loaded, err := repository.GetLifecycleOperation(ctx, operation.RequestID)
	if err != nil || loaded.State != domain.OperationRunning {
		t.Fatalf("rejected termination mutated operation: %+v %v", loaded, err)
	}
	if reliabilityEvents(t, repository, "agent_lifecycle_cancelled", operation.AgentID) != 0 {
		t.Fatal("rejected termination emitted an event")
	}
}

func TestClearLifecycleQuarantineRestoresAgentWithSequenceCAS(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Microsecond)
	fingerprint := strings.Repeat("ab", 32)
	deadline := now.Add(time.Minute)
	targetSpec := base.ConfiguredSpec
	targetSpec.ID = "agentspec-clear-integration"
	targetSpec.Revision = base.NextSpecRevision
	targetSpec.CreatedAt = now
	begin := ports.BeginAgentRebuild{
		AgentID:                     base.Agent.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.ConfiguredSpec.ID,
		ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		TargetSpec:                  targetSpec,
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-clear-agent", RequestFingerprint: fingerprint,
			AgentID: base.Agent.AgentID,
			Kind:    domain.OperationRebuild, Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:      base.ConfiguredSpec.ID,
			SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      "agentspec-clear-integration",
			DrainDeadlineAt:           &deadline,
			ChildRequestID:            domain.ChildRequestID("request-clear-agent", domain.PhaseDrain),
			CreatedAt:                 now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-clear-rebuild-requested", AgentID: base.Agent.AgentID,
			AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: "request-clear-agent",
			Data:               map[string]any{"target_agent_spec_revision_id": "agentspec-clear-integration"},
			OccurredAt:         now,
		},
		Now: now,
	}
	if _, replayed, err := repository.BeginAgentRebuild(ctx, begin); err != nil || replayed {
		t.Fatalf("begin rebuild: %v replayed=%t", err, replayed)
	}
	operation := begin.Operation
	quarantine := ports.QuarantineLifecycleOperation{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseDrain, ErrorCode: "lifecycle_invariant_failed",
		ErrorDetail: "runtime observation contradicted the journal",
		EventID:     "event-clear-agent-quarantine",
	}
	if err := repository.QuarantineLifecycleOperation(ctx, quarantine); err != nil {
		t.Fatal(err)
	}
	quarantined, err := loadAgentRecord(ctx, repository.pool, operation.AgentID)
	if err != nil || quarantined.FailureCode != "lifecycle_invariant_failed" {
		t.Fatalf("quarantined Agent: %+v %v", quarantined, err)
	}
	lifecycleBase, err := repository.GetAgentLifecycleBase(ctx, operation.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	inspection := ports.RuntimeInspection{
		AgentID: operation.AgentID, RuntimeRevision: quarantined.RuntimeRevision,
		Phase: "absent", LifecycleState: "disabled", Health: "unhealthy",
		ObservedAt: time.Now().UTC(),
	}
	clear := ports.ClearLifecycleQuarantine{
		OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: operation.AgentID, ExpectedAggregateSequence: quarantined.AggregateSequence + 1,
		ExpectedSpecRevisionID:                    lifecycleBase.ConfiguredSpec.ID,
		ExpectedRuntimeRevision:                   quarantined.RuntimeRevision,
		ExpectedLastSuccessfulExecutionRevisionID: quarantined.LastSuccessfulExecutionRevisionID,
		Inspection: inspection, EventID: "event-clear-agent",
	}
	if _, err := repository.ClearLifecycleQuarantine(ctx, clear); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale sequence = %v", err)
	}
	clear.ExpectedAggregateSequence = quarantined.AggregateSequence
	forged := clear
	forged.Inspection.AgentID = "agent-other"
	if _, err := repository.ClearLifecycleQuarantine(ctx, forged); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("forged inspection = %v", err)
	}
	forged = clear
	forged.ExpectedRuntimeRevision = "runtime-rev-forged"
	if _, err := repository.ClearLifecycleQuarantine(ctx, forged); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("forged runtime revision = %v", err)
	}
	agent, err := repository.ClearLifecycleQuarantine(ctx, clear)
	if err != nil {
		t.Fatal(err)
	}
	if agent.FailureCode != "" || agent.FailureStage != "" || agent.ActiveOperationRequestID != "" ||
		agent.RuntimeReason == "lifecycle_invariant_failed" {
		t.Fatalf("cleared Agent retains failure markers: %+v", agent)
	}
	if agent.AgentSpecRevisionID != quarantined.AgentSpecRevisionID ||
		agent.RuntimeRevision != quarantined.RuntimeRevision {
		t.Fatalf("clear rewrote configured source: %+v", agent)
	}
	if reliabilityEvents(t, repository, "agent_lifecycle_quarantine_cleared", operation.AgentID) != 1 {
		t.Fatal("agent_lifecycle_quarantine_cleared event missing")
	}
	reloaded, err := loadAgentRecord(ctx, repository.pool, operation.AgentID)
	if err != nil || reloaded.AggregateSequence != agent.AggregateSequence {
		t.Fatalf("persisted Agent differs: %+v", reloaded)
	}
	if _, err := repository.ClearLifecycleQuarantine(ctx, ports.ClearLifecycleQuarantine{
		OrganizationID: base.Agent.OrganizationID, ActorPrincipalID: "admin-1",
		AgentID: "agent-missing", ExpectedAggregateSequence: 1,
		ExpectedSpecRevisionID: "spec-missing", ExpectedRuntimeRevision: "rev-missing",
		Inspection: inspection, EventID: "event-missing",
	}); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("unknown Agent = %v", err)
	}
}
