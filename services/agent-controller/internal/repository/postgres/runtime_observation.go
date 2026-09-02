package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/ports"
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
	eventCount := 0
	for _, runtime := range runtimes {
		if runtime.LifecycleState != "ready" || runtime.Health != "healthy" ||
			runtime.RuntimeExecutionID == "" {
			continue
		}
		eventID := runtimeReconciliationEventID(runtime)
		changed, invalidateErr := invalidateRuntimeExecution(
			ctx, transaction, runtime.AgentID, runtime.RuntimeRevision,
			runtime.RuntimeExecutionID, eventID, "runtime_execution_changed", sequence,
		)
		if invalidateErr != nil {
			return invalidateErr
		}
		if changed {
			eventCount++
		}
	}
	if _, err := transaction.Exec(ctx, `
UPDATE agent_controller.runtime_observation_cursor
SET last_sequence = $1, initialized = TRUE
WHERE singleton = TRUE`, int64(sequence)); err != nil {
		return fmt.Errorf("update Runtime observation cursor: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit Runtime observation reconciliation: %w", err)
	}
	for range eventCount {
		repository.recordEventAppend(ctx, ports.EventAgentRuntimeRestarted)
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
	changed := false
	if observation.Kind == ports.RuntimeObservationRestarted {
		changed, err = invalidateRuntimeExecution(
			ctx, transaction, observation.AgentID, observation.RuntimeRevision,
			"",
			"runtime-observation-"+strconv.FormatUint(observation.Sequence, 10),
			"runtime_restarted", observation.Sequence,
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
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit Runtime observation transaction: %w", err)
	}
	if changed {
		repository.recordEventAppend(ctx, ports.EventAgentRuntimeRestarted)
	}
	return nil
}

func lockRuntimeObservationCursor(
	ctx context.Context, transaction pgx.Tx,
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
	transaction pgx.Tx,
	agentID string,
	runtimeRevision string,
	observedExecutionID string,
	eventID string,
	failureCode string,
	observationSequence uint64,
) (bool, error) {
	var aggregateSequence int64
	err := transaction.QueryRow(ctx, `
UPDATE agent_controller.agents
SET lifecycle_state = 'unavailable',
    executable_execution_revision_id = '',
    runtime_execution_id = '',
    runtime_mcp_endpoint = '',
    failure_stage = 'runtime_observation',
    failure_code = $3,
    failure_detail = 'Runtime process identity changed outside an Agent lifecycle operation; rebuild is required',
    aggregate_sequence = aggregate_sequence + 1,
    updated_at = clock_timestamp()
WHERE id = $1
  AND runtime_revision = $2
  AND desired_state = 'enabled'
  AND lifecycle_state = 'available'
  AND active_operation_request_id = ''
  AND ($4 = '' OR runtime_execution_id <> $4)
RETURNING aggregate_sequence`, agentID, runtimeRevision, failureCode, observedExecutionID).Scan(&aggregateSequence)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("invalidate restarted Runtime execution: %w", err)
	}
	data, err := json.Marshal(map[string]any{
		"runtime_revision": runtimeRevision, "observation_sequence": observationSequence,
		"reason": failureCode,
	})
	if err != nil {
		return false, fmt.Errorf("encode Runtime restart event: %w", err)
	}
	var globalSequence int64
	if err := transaction.QueryRow(ctx, `
UPDATE agent_controller.event_journal_cursor
SET last_sequence = last_sequence + 1
WHERE singleton = TRUE
RETURNING last_sequence`).Scan(&globalSequence); err != nil {
		return false, fmt.Errorf("allocate Runtime restart event sequence: %w", err)
	}
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.agent_events (
    global_sequence, event_id, agent_id, aggregate_sequence, schema_version, event_type,
    data, occurred_at
) VALUES ($1, $2, $3, $4, 1, $5, $6, clock_timestamp())`,
		globalSequence, eventID, agentID, aggregateSequence,
		ports.EventAgentRuntimeRestarted, data,
	); err != nil {
		return false, fmt.Errorf("insert Runtime restart event: %w", err)
	}
	return true, nil
}

func runtimeReconciliationEventID(runtime ports.RuntimeEnvironmentSnapshot) string {
	digest := sha256.Sum256([]byte(
		runtime.AgentID + "\x00" + runtime.RuntimeRevision + "\x00" + runtime.RuntimeExecutionID,
	))
	return "runtime-reconcile-" + hex.EncodeToString(digest[:16])
}

var _ ports.RuntimeObservationStore = (*Repository)(nil)
