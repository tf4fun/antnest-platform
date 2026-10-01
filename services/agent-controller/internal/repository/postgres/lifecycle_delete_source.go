package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func resolveDeleteAdvanceSource(operation ports.LifecycleOperationRecord, input ports.AdvanceAgentDelete) (ports.LifecycleOperationRecord, error) {
	inspection, proof := input.SourceRuntimeInspection, input.SourceRuntimeAbsenceProof
	if inspection == nil && proof == nil {
		return operation, nil
	}
	if operation.Phase != domain.PhaseNetworkFence || input.ExpectedPhase != domain.PhaseNetworkFence ||
		operation.SourceRuntimeRevision != "" || operation.SourceRuntimeAbsent ||
		operation.SourceRuntimeInspection != nil || operation.SourceRuntimeAbsenceProof != nil ||
		(inspection != nil && proof != nil) {
		return operation, ports.ErrConcurrentChange
	}
	if inspection != nil {
		if inspection.AgentID != operation.AgentID || inspection.RuntimeRevision == "" ||
			(inspection.LifecycleState != "provisioned" && inspection.LifecycleState != "disabled" && inspection.LifecycleState != "failed") {
			return operation, ports.ErrConcurrentChange
		}
		operation.SourceRuntimeRevision = inspection.RuntimeRevision
		operation.SourceRuntimeInspection = inspection
	} else {
		if !validRuntimeAbsenceProof(proof) || proof.ObservedAt.After(input.Now) {
			return operation, ports.ErrConcurrentChange
		}
		operation.SourceRuntimeAbsent = true
		operation.SourceRuntimeAbsenceProof = proof
	}
	return operation, nil
}

func advanceDeleteOperation(ctx context.Context, transaction *databaseTransaction, operation ports.LifecycleOperationRecord, input ports.AdvanceAgentDelete) error {
	inspection, inspectionErr := json.Marshal(operation.SourceRuntimeInspection)
	proof, proofErr := json.Marshal(operation.SourceRuntimeAbsenceProof)
	attachment, attachmentErr := json.Marshal(input.NetworkAttachment)
	runtime, runtimeErr := json.Marshal(input.RuntimeResult)
	if err := errors.Join(inspectionErr, proofErr, attachmentErr, runtimeErr); err != nil {
		return fmt.Errorf("encode delete evidence: %w", err)
	}
	result, err := transaction.Exec(ctx, `
UPDATE agent_controller.agent_lifecycle_operations AS operation
SET phase=$2, child_request_id=$3, updated_at=$4,
    source_runtime_revision=$5, source_runtime_absent=$6,
    source_runtime_inspection=NULLIF($7::jsonb, 'null'::jsonb),
    source_runtime_absence_proof=NULLIF($8::jsonb, 'null'::jsonb),
    network_attachment=CASE WHEN $11='authoritative_absent' THEN NULL
        ELSE COALESCE(NULLIF($9::jsonb, 'null'::jsonb), network_attachment) END,
    runtime_result=COALESCE(NULLIF($10::jsonb, 'null'::jsonb), runtime_result),
    network_release_outcome=CASE WHEN $12='network_release' THEN $11 ELSE network_release_outcome END
WHERE request_id=$1 AND state='running' AND phase=$12
  AND EXISTS (
      SELECT 1 FROM agent_controller.agents AS agent
      WHERE agent.id = operation.agent_id
        AND agent.active_operation_request_id = operation.request_id
  )`,
		operation.RequestID, input.NextPhase, input.NextChildRequestID, input.Now,
		operation.SourceRuntimeRevision, operation.SourceRuntimeAbsent, inspection, proof,
		attachment, runtime, input.NetworkReleaseOutcome, input.ExpectedPhase,
	)
	if err != nil {
		return fmt.Errorf("advance Agent delete: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}
