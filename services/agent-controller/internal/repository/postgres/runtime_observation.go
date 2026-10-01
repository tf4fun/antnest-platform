package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetRuntimeObservationCursor(
	ctx context.Context,
) (ports.RuntimeObservationCursor, error) {
	var cursor ports.RuntimeObservationCursor
	err := repository.pool.QueryRow(ctx, `
SELECT last_sequence, initialized
FROM agent_controller.runtime_observation_cursor
WHERE singleton = TRUE`).Scan(&cursor.Sequence, &cursor.Initialized)
	if err != nil {
		return ports.RuntimeObservationCursor{}, fmt.Errorf("query Runtime observation cursor: %w", err)
	}
	return cursor, nil
}

func (repository *Repository) InitializeRuntimeObservationCursor(
	ctx context.Context, runtimes []ports.RuntimeEnvironmentSnapshot,
) error {
	return repository.reconcileRuntimeObservationCursor(ctx, runtimes, 0, false)
}

func (repository *Repository) ResetRuntimeObservationCursor(
	ctx context.Context, runtimes []ports.RuntimeEnvironmentSnapshot, sequence uint64,
) error {
	if sequence > math.MaxInt64 {
		return fmt.Errorf("runtime observation sequence exceeds PostgreSQL BIGINT")
	}
	return repository.reconcileRuntimeObservationCursor(ctx, runtimes, sequence, true)
}

func (repository *Repository) reconcileRuntimeObservationCursor(
	ctx context.Context,
	runtimes []ports.RuntimeEnvironmentSnapshot,
	sequence uint64,
	reset bool,
) error {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Runtime observation reconciliation: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	cursor, err := lockRuntimeObservationCursor(ctx, transaction)
	if err != nil {
		return err
	}
	if (!reset && cursor.Initialized) || (reset && cursor.Sequence > sequence) {
		return transaction.Commit(ctx)
	}
	agentIDs := make([]string, 0, len(runtimes))
	for _, runtime := range runtimes {
		agentIDs = append(agentIDs, runtime.AgentID)
	}
	before, err := lockRuntimeExecutionAgents(ctx, transaction, agentIDs, true)
	if err != nil {
		return err
	}
	lockedIDs := make([]string, 0, len(before))
	locked := make(map[string]bool, len(before))
	for _, agent := range before {
		lockedIDs = append(lockedIDs, agent.AgentID)
		locked[agent.AgentID] = true
	}
	// Missing journal entries may describe process changes absent from inventory.
	// Reject every pending Inspect that predates this bootstrap or reset.
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET aggregate_sequence = aggregate_sequence + 1, updated_at = clock_timestamp()
WHERE id=ANY($1::text[]) AND `+pendingObservationPredicate, lockedIDs); err != nil {
		return fmt.Errorf("fence pending Runtime reconciliation: %w", err)
	}
	eventCounts := make(map[string]int)
	for _, runtime := range runtimes {
		if !locked[runtime.AgentID] {
			continue
		}
		if !runtime.ObservedAt.IsZero() {
			if err := repository.applyCurrentRuntimeCondition(ctx, transaction, &ports.RuntimeInspection{
				AgentID: runtime.AgentID, RuntimeRevision: runtime.RuntimeRevision, RuntimeExecutionID: runtime.RuntimeExecutionID,
				LifecycleState: runtime.LifecycleState, Phase: runtime.Phase, Health: runtime.Health,
				Reason: runtime.Reason, DiagnosticSummary: runtime.DiagnosticSummary, ObservedAt: runtime.ObservedAt,
			}, false); err != nil {
				return err
			}
			continue
		}
		invalidation, observedExecutionID, ok := runtimeSnapshotInvalidation(runtime)
		if !ok {
			continue
		}
		eventID := runtimeReconciliationEventID(runtime)
		changed, invalidateErr := invalidateRuntimeExecution(
			ctx, transaction, runtime.AgentID, runtime.RuntimeRevision,
			observedExecutionID, eventID, invalidation, sequence,
		)
		if invalidateErr != nil {
			return invalidateErr
		}
		if changed {
			eventCounts[invalidation.eventType]++
		}
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.runtime_observation_cursor
SET last_sequence = $1, initialized = TRUE
WHERE singleton = TRUE`, int64(sequence)); err != nil {
		return fmt.Errorf("update Runtime observation cursor: %w", err)
	}
	if err := repository.advanceRuntimeExecutionChanges(ctx, transaction, before); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit Runtime observation reconciliation: %w", err)
	}
	for eventType, count := range eventCounts {
		for range count {
			repository.recordEventAppend(ctx, eventType)
		}
	}
	return nil
}

func (repository *Repository) ApplyRuntimeObservation(
	ctx context.Context, observation ports.RuntimeObservation,
) error {
	if observation.Sequence == 0 {
		return fmt.Errorf("runtime observation sequence must be positive")
	}
	if observation.Sequence > math.MaxInt64 {
		return fmt.Errorf("runtime observation sequence exceeds PostgreSQL BIGINT")
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Runtime observation transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	cursor, err := lockRuntimeObservationCursor(ctx, transaction)
	if err != nil {
		return err
	}
	if observation.Sequence <= cursor.Sequence {
		return transaction.Commit(ctx)
	}
	before, err := lockRuntimeExecutionAgents(ctx, transaction, []string{observation.AgentID}, false)
	if err != nil {
		return err
	}
	changed := false
	invalidation, shouldInvalidate := runtimeObservationInvalidation(observation.Kind)
	fencePending := shouldInvalidate
	if len(before) == 0 {
		shouldInvalidate, fencePending = false, false
	}
	observedExecutionID := ""
	if observation.Current != nil {
		current := observation.Current
		if current.AgentID != observation.AgentID {
			return fmt.Errorf("current Runtime observation belongs to another Agent")
		}
		if len(before) > 0 {
			if err := repository.applyCurrentRuntimeCondition(ctx, transaction, current,
				fencePending && current.RuntimeRevision == observation.RuntimeRevision); err != nil {
				return err
			}
		}
		shouldInvalidate, fencePending = false, false
	}
	if fencePending || shouldInvalidate {
		// Fence an Inspect that began before this process change. Pending Agents
		// have no execution to invalidate yet, but must reject that stale result.
		if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.agents
SET aggregate_sequence = aggregate_sequence + 1, updated_at = clock_timestamp()
WHERE id = $1 AND runtime_revision = $2 AND lifecycle_state = 'created' AND activation_state = 'enabled'
  AND executable_execution_revision_id = ''
  AND desired_state = 'enabled' AND active_operation_request_id = ''`,
			observation.AgentID, observation.RuntimeRevision); err != nil {
			return fmt.Errorf("fence pending Runtime observation: %w", err)
		}
	}
	if shouldInvalidate {
		changed, err = invalidateRuntimeExecution(
			ctx, transaction, observation.AgentID, observation.RuntimeRevision,
			observedExecutionID,
			domain.DeriveResourceID("event", "runtime-observation", strconv.FormatUint(observation.Sequence, 10)),
			invalidation, observation.Sequence,
		)
		if err != nil {
			return err
		}
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.runtime_observation_cursor
SET last_sequence = $1, initialized = TRUE
WHERE singleton = TRUE`, int64(observation.Sequence)); err != nil {
		return fmt.Errorf("advance Runtime observation cursor: %w", err)
	}
	if err := repository.advanceRuntimeExecutionChanges(ctx, transaction, before); err != nil {
		return err
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit Runtime observation transaction: %w", err)
	}
	if changed {
		repository.recordEventAppend(ctx, invalidation.eventType)
	}
	return nil
}

func lockRuntimeObservationCursor(
	ctx context.Context, transaction *databaseTransaction,
) (ports.RuntimeObservationCursor, error) {
	var cursor ports.RuntimeObservationCursor
	err := transaction.QueryRow(ctx, `
SELECT last_sequence, initialized
FROM agent_controller.runtime_observation_cursor
WHERE singleton = TRUE
FOR UPDATE`).Scan(&cursor.Sequence, &cursor.Initialized)
	if err != nil {
		return ports.RuntimeObservationCursor{}, fmt.Errorf("lock Runtime observation cursor: %w", err)
	}
	return cursor, nil
}

func invalidateRuntimeExecution(
	ctx context.Context,
	transaction *databaseTransaction,
	agentID string,
	runtimeRevision string,
	observedExecutionID string,
	eventID string,
	invalidation runtimeInvalidation,
	observationSequence uint64,
) (bool, error) {
	var aggregateSequence int64
	err := transaction.QueryRow(ctx, `
UPDATE agent_controller.agents
SET runtime_state = 'unknown', runtime_reason = $3, runtime_detail = $5,
    executable_execution_revision_id = '',
    runtime_execution_id = '',
    runtime_mcp_endpoint = '',
    failure_stage = 'runtime_observation',
    failure_code = $3,
    failure_detail = $5,
    aggregate_sequence = aggregate_sequence + 1,
    updated_at = clock_timestamp()
WHERE id = $1
  AND runtime_revision = $2
  AND desired_state = 'enabled'
  AND lifecycle_state = 'created' AND activation_state = 'enabled' AND executable_execution_revision_id <> ''
  AND active_operation_request_id = ''
  AND ($4 = '' OR runtime_execution_id <> $4)
RETURNING aggregate_sequence`, agentID, runtimeRevision, invalidation.code, observedExecutionID, invalidation.detail).Scan(&aggregateSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("invalidate Runtime execution: %w", err)
	}
	data, err := json.Marshal(map[string]any{
		"runtime_revision": runtimeRevision, "observation_sequence": observationSequence,
		"reason": invalidation.code,
	})
	if err != nil {
		return false, fmt.Errorf("encode Runtime invalidation event: %w", err)
	}
	var globalSequence int64
	if err := transaction.QueryRow(ctx, `
UPDATE agent_controller.event_journal_cursor
SET last_sequence = last_sequence + 1
WHERE singleton = TRUE
RETURNING last_sequence`).Scan(&globalSequence); err != nil {
		return false, fmt.Errorf("allocate Runtime invalidation event sequence: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_events (
    global_sequence, event_id, agent_id, aggregate_sequence, schema_version, event_type,
    data, occurred_at
) VALUES ($1, $2, $3, $4, 1, $5, $6, clock_timestamp())`,
		globalSequence, eventID, agentID, aggregateSequence,
		invalidation.eventType, data,
	); err != nil {
		return false, fmt.Errorf("insert Runtime invalidation event: %w", err)
	}
	return true, nil
}

func runtimeReconciliationEventID(runtime ports.RuntimeEnvironmentSnapshot) string {
	return domain.DeriveResourceID("event", "runtime-reconcile",
		runtime.AgentID+"\x00"+runtime.RuntimeRevision+"\x00"+runtime.RuntimeExecutionID)
}

var _ ports.RuntimeObservationStore = (*Repository)(nil)
