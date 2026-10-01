package postgres

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) RecordRuntimeCondition(ctx context.Context, input ports.RecordRuntimeCondition) (int64, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin Runtime condition: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockAgentExecutionConfiguration(ctx, tx, input.Inspection.AgentID); err != nil {
		return 0, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, input.Inspection.AgentID)
	if err != nil {
		return 0, err
	}
	if agent.AggregateSequence != input.ExpectedAggregateSequence || !acceptsRuntimeCondition(agent, input.Inspection) {
		return 0, ports.ErrConcurrentChange
	}
	sequence, err := repository.applyRuntimeCondition(ctx, tx, agent, input.Inspection, false, input.TraceID)
	if err != nil {
		return 0, err
	}
	if err := repository.advanceRuntimeExecutionChanges(ctx, tx, []ports.AgentRecord{agent}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return sequence, nil
}

func acceptsRuntimeCondition(agent ports.AgentRecord, current ports.RuntimeInspection) bool {
	return agent.LifecycleState == domain.AgentCreated && agent.ActivationState == domain.ActivationEnabled &&
		agent.FailureCode != "lifecycle_invariant_failed" &&
		agent.ActiveOperationRequestID == "" && agent.RuntimeRevision != "" &&
		agent.AgentID == current.AgentID && agent.RuntimeRevision == current.RuntimeRevision &&
		!current.ObservedAt.IsZero() && (agent.RuntimeObservedAt == nil || !current.ObservedAt.Before(*agent.RuntimeObservedAt))
}

// Current evidence and execution validity change together, after ownership,
// target and observation-time checks under the Agent row lock.
func (repository *Repository) applyRuntimeCondition(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord, current ports.RuntimeInspection, fencePending bool, traceID string) (int64, error) {
	if fencePending && agent.ExecutionRevisionID == "" {
		if _, err := tx.Exec(ctx, "UPDATE agent_controller.agents SET aggregate_sequence=aggregate_sequence+1 WHERE id=$1", agent.AgentID); err != nil {
			return 0, err
		}
		agent.AggregateSequence++
	}
	invalidation, executionID, invalidate := currentRuntimeInvalidation(current)
	if invalidate {
		eventID := domain.DeriveResourceID("event", "runtime-condition-loss", agent.AgentID+"\x00"+strconv.FormatInt(agent.AggregateSequence+1, 10))
		changed, err := invalidateRuntimeExecution(ctx, tx, agent.AgentID, agent.RuntimeRevision, executionID, eventID, invalidation, 0)
		if err != nil {
			return 0, err
		}
		if changed {
			agent, err = loadAgentRecordForUpdate(ctx, tx, agent.AgentID)
			if err != nil {
				return 0, err
			}
		}
	}
	return repository.recordRuntimeCondition(ctx, tx, agent, current, traceID)
}

func (repository *Repository) recordRuntimeCondition(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord, current ports.RuntimeInspection, traceID string) (int64, error) {
	state := domain.ObservedRuntimeState(current.Phase, current.Health)
	changed := agent.RuntimeState != state || agent.RuntimeReason != current.Reason || agent.RuntimeDetail != current.DiagnosticSummary
	sequence := agent.AggregateSequence
	if changed {
		sequence++
	}
	if _, err := tx.Exec(ctx, `
UPDATE agent_controller.agents
SET runtime_state=$2, runtime_reason=$3, runtime_detail=$4, runtime_observed_at=$5,
    aggregate_sequence=$6, updated_at=CASE WHEN $7 THEN clock_timestamp() ELSE updated_at END
WHERE id=$1`, agent.AgentID, state, current.Reason, current.DiagnosticSummary, current.ObservedAt, sequence, changed); err != nil {
		return 0, fmt.Errorf("save Runtime condition: %w", err)
	}
	if changed {
		err := repository.insertAgentEvent(ctx, tx, ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "runtime-condition", agent.AgentID+"\x00"+strconv.FormatInt(sequence, 10)), AgentID: agent.AgentID,
			AggregateSequence: sequence, SchemaVersion: 1, EventType: ports.EventAgentRuntimeConditionChanged,
			TraceID: traceID, OccurredAt: current.ObservedAt,
			Data: map[string]any{"runtime_revision": current.RuntimeRevision, "runtime_state": state, "reason": current.Reason},
		})
		if err != nil {
			return 0, err
		}
	}
	return sequence, nil
}

func (repository *Repository) applyCurrentRuntimeCondition(ctx context.Context, tx *databaseTransaction, current *ports.RuntimeInspection, fencePending bool) error {
	if current == nil {
		return nil
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, current.AgentID)
	if errors.Is(err, ports.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if !acceptsRuntimeCondition(agent, *current) {
		return nil
	}
	traceID := ""
	if span := trace.SpanContextFromContext(ctx); span.IsValid() {
		traceID = span.TraceID().String()
	}
	_, err = repository.applyRuntimeCondition(ctx, tx, agent, *current, fencePending, traceID)
	return err
}
