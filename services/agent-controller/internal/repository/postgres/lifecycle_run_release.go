package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) releaseBlockedRunAdmission(
	ctx context.Context,
	transaction pgx.Tx,
	operation ports.LifecycleOperationRecord,
	barrier runReleaseBarrier,
	event ports.RunAdmissionEvent,
	now time.Time,
) (bool, bool, error) {
	reason, sourceRuntimeRevision, valid := validateRunReleaseBarrier(operation, barrier, now)
	if !valid || !validRunReleaseEvent(event, reason, sourceRuntimeRevision, now) {
		return false, false, fmt.Errorf("invalid lifecycle Runtime removal barrier")
	}
	agent, err := loadAgentRecordForUpdate(ctx, transaction, operation.AgentID)
	if err != nil {
		return false, false, err
	}
	if agent.ActiveOperationRequestID != operation.RequestID {
		return false, false, ports.ErrConcurrentChange
	}

	var admissionID, runtimeRevision, terminalReportPayload string
	err = transaction.QueryRow(ctx, `
SELECT admission_id, runtime_revision,
       terminal_report::text
FROM agent_controller.run_admissions
WHERE agent_id = $1 AND state = 'blocked_unknown_effect'
ORDER BY admission_id LIMIT 1 FOR UPDATE`, operation.AgentID).Scan(
		&admissionID, &runtimeRevision, &terminalReportPayload,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, false, nil
	}
	if err != nil {
		return false, false, fmt.Errorf("load unresolved Run admission: %w", err)
	}
	var terminalReport domain.TerminalReport
	if err := json.Unmarshal([]byte(terminalReportPayload), &terminalReport); err != nil {
		return false, false, fmt.Errorf("decode unresolved Run terminal report: %w", err)
	}
	state, err := domain.ValidateTerminalReport(terminalReport)
	if err != nil || state != domain.AdmissionBlockedUnknownEffect {
		return false, false, fmt.Errorf("invalid unresolved Run terminal report")
	}
	if terminalReport.UnknownEffectSource != domain.UnknownEffectRuntimeMCP {
		return false, true, nil
	}
	if !operation.SourceRuntimeAbsent && runtimeRevision != operation.SourceRuntimeRevision {
		return false, false, fmt.Errorf(
			"%w: unresolved Run belongs to another Runtime revision",
			ports.ErrRunAdmissionRuntimeMismatch,
		)
	}

	released, err := transaction.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET state = 'released', released_by_operation_request_id = $2,
    released_at = $3, updated_at = $3
WHERE admission_id = $1 AND state = 'blocked_unknown_effect'`,
		admissionID, operation.RequestID, now,
	)
	if err != nil {
		return false, false, fmt.Errorf("release unresolved Run after Runtime removal: %w", err)
	}
	if released.RowsAffected() != 1 {
		return false, false, ports.ErrConcurrentChange
	}

	nextSequence := agent.AggregateSequence + 1
	projected, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET aggregate_sequence = $2, updated_at = $3
WHERE id = $1 AND active_operation_request_id = $4 AND aggregate_sequence = $5`,
		agent.AgentID, nextSequence, now, operation.RequestID, agent.AggregateSequence,
	)
	if err != nil {
		return false, false, fmt.Errorf("advance Agent Run release sequence: %w", err)
	}
	if projected.RowsAffected() != 1 {
		return false, false, ports.ErrConcurrentChange
	}
	if err := repository.insertAgentEvent(ctx, transaction, ports.AgentEventRecord{
		EventID: event.EventID, AgentID: operation.AgentID,
		AggregateSequence: nextSequence, SchemaVersion: 1,
		EventType:          ports.EventRunAdmissionReleased,
		OperationRequestID: operation.RequestID, AdmissionID: admissionID,
		TraceID: event.TraceID, Data: event.Data, OccurredAt: event.OccurredAt,
	}); err != nil {
		return false, false, err
	}
	return true, false, nil
}

type runReleaseBarrier struct {
	runtimeResult *ports.RuntimeOperation
	absenceProof  *ports.RuntimeAbsenceProof
}

func validateRunReleaseBarrier(
	operation ports.LifecycleOperationRecord,
	barrier runReleaseBarrier,
	now time.Time,
) (string, string, bool) {
	if operation.State != domain.OperationRunning || now.IsZero() ||
		(barrier.runtimeResult != nil && barrier.absenceProof != nil) {
		return "", "", false
	}
	if barrier.absenceProof != nil && operation.Kind != domain.OperationDelete {
		if (operation.Kind != domain.OperationRebuild && operation.Kind != domain.OperationDisable) ||
			(operation.Phase != domain.PhaseRuntimeUpdate && operation.Phase != domain.PhaseRuntimeDisable) ||
			!validRuntimeRemovalProof(operation, barrier.absenceProof, now) {
			return "", "", false
		}
		return barrier.absenceProof.Reason, operation.SourceRuntimeRevision, true
	}
	switch operation.Kind {
	case domain.OperationRebuild:
		return validateRebuildRunBarrier(operation, barrier.runtimeResult)
	case domain.OperationDisable:
		return validateDisableRunBarrier(operation, barrier.runtimeResult)
	case domain.OperationDelete:
		return validateDeleteRunBarrier(operation, barrier)
	default:
		return "", "", false
	}
}

func validateRebuildRunBarrier(
	operation ports.LifecycleOperationRecord, result *ports.RuntimeOperation,
) (string, string, bool) {
	valid := operation.Phase == domain.PhaseRuntimeUpdate && result != nil &&
		readyRuntimeResult(*result) && result.RuntimeRevision != operation.SourceRuntimeRevision
	return "runtime_replaced", operation.SourceRuntimeRevision, valid
}

func validateDisableRunBarrier(
	operation ports.LifecycleOperationRecord, result *ports.RuntimeOperation,
) (string, string, bool) {
	valid := operation.Phase == domain.PhaseRuntimeDisable && result != nil &&
		disabledRuntimeResult(*result)
	return "runtime_disabled", operation.SourceRuntimeRevision, valid
}

func validateDeleteRunBarrier(
	operation ports.LifecycleOperationRecord, barrier runReleaseBarrier,
) (string, string, bool) {
	if operation.Phase == domain.PhaseRuntimeDelete && barrier.runtimeResult != nil &&
		deletedRuntimeResult(*barrier.runtimeResult) {
		return "runtime_deleted", operation.SourceRuntimeRevision, true
	}
	proof := barrier.absenceProof
	if operation.Phase == domain.PhaseNetworkFence && operation.SourceRuntimeAbsent &&
		proof != nil && operation.SourceRuntimeAbsenceProof != nil &&
		proof.Reason == "runtime_not_found" && proof.RuntimeRevision == "" &&
		proof.Reason == operation.SourceRuntimeAbsenceProof.Reason &&
		proof.RuntimeRevision == operation.SourceRuntimeAbsenceProof.RuntimeRevision &&
		proof.ObservedAt.Equal(operation.SourceRuntimeAbsenceProof.ObservedAt) {
		return "runtime_absent", operation.SourceRuntimeRevision, true
	}
	return "", "", false
}

func validRuntimeRemovalProof(
	operation ports.LifecycleOperationRecord, proof *ports.RuntimeAbsenceProof, now time.Time,
) bool {
	return proof.Reason == "runtime_deleted" &&
		proof.RuntimeRevision == operation.SourceRuntimeRevision &&
		!proof.ObservedAt.IsZero() && !proof.ObservedAt.After(now)
}

func validRunReleaseEvent(
	event ports.RunAdmissionEvent, reason string, sourceRuntimeRevision string, now time.Time,
) bool {
	if !validRunEvent(event, domain.AdmissionReleased) || !event.OccurredAt.Equal(now) {
		return false
	}
	eventReason, reasonOK := event.Data["release_reason"].(string)
	eventRevision, revisionOK := event.Data["source_runtime_revision"].(string)
	return reasonOK && revisionOK && eventReason == reason && eventRevision == sourceRuntimeRevision
}

func runReleaseOutcome(requested bool, released bool, retained bool) string {
	if !requested {
		return ""
	}
	if released {
		return ports.RunReleaseOutcomeReleased
	}
	if retained {
		return ports.RunReleaseOutcomeRetained
	}
	return ports.RunReleaseOutcomeNotBlocked
}

func emptyRunAdmissionEvent(event ports.RunAdmissionEvent) bool {
	return event.EventID == "" && event.EventType == "" && event.TraceID == "" &&
		event.Data == nil && event.OccurredAt.IsZero()
}
