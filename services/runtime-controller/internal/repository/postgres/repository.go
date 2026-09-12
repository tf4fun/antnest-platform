package postgres

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/repository"
)

var _ repository.Port = (*Repository)(nil)

type Repository struct {
	database                *sql.DB
	lockDatabase            *sql.DB
	retention               time.Duration
	mutationProbeInterval   time.Duration
	leadershipProbeInterval time.Duration
}

func New(database, lockDatabase *sql.DB, retention time.Duration) (*Repository, error) {
	if database == nil || lockDatabase == nil {
		return nil, fmt.Errorf("database and dedicated Agent lock database are required")
	}
	if retention <= 0 {
		return nil, fmt.Errorf("observation retention must be positive")
	}
	return &Repository{
		database: database, lockDatabase: lockDatabase, retention: retention,
		mutationProbeInterval: time.Second, leadershipProbeInterval: time.Second,
	}, nil
}

func (r *Repository) Ready(ctx context.Context) error {
	if err := r.database.PingContext(ctx); err != nil {
		return fmt.Errorf("ping Runtime Controller database: %w", err)
	}
	if err := r.lockDatabase.PingContext(ctx); err != nil {
		return fmt.Errorf("ping Runtime Controller Agent lock database: %w", err)
	}
	return nil
}

func (r *Repository) ProbeObservationJournal(ctx context.Context) error {
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Runtime observation journal probe: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	const probeSource = "readiness_probe"
	if _, err := tx.ExecContext(ctx, probeObservationJournalSQL, probeSource, time.Now().UTC()); err != nil {
		return fmt.Errorf("write Runtime observation journal probe: %w", err)
	}
	var source string
	if err := tx.QueryRowContext(ctx,
		`SELECT source FROM runtime_controller.observations WHERE sequence = 0`,
	).Scan(&source); err != nil {
		return fmt.Errorf("read Runtime observation journal probe: %w", err)
	}
	if source != probeSource {
		return fmt.Errorf("runtime observation journal probe returned unexpected source")
	}
	if err := notifyObservation(ctx, tx); err != nil {
		return fmt.Errorf("exercise Runtime observation notification probe: %w", err)
	}
	if err := tx.Rollback(); err != nil && !errors.Is(err, sql.ErrTxDone) {
		return fmt.Errorf("rollback Runtime observation journal probe: %w", err)
	}
	return nil
}

func (r *Repository) ProbeObservationNotification(ctx context.Context, payload string) error {
	if !strings.HasPrefix(payload, "readiness_probe:") || len(payload) > 200 {
		return fmt.Errorf("invalid Runtime observation notification probe payload")
	}
	if _, err := r.database.ExecContext(ctx, probeObservationNotificationSQL, payload); err != nil {
		return fmt.Errorf("publish Runtime observation notification probe: %w", err)
	}
	return nil
}

func (r *Repository) BeginTransition(
	ctx context.Context, candidate deployment.Operation,
) (deployment.Operation, bool, error) {
	tx, err := r.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return deployment.Operation{}, false, fmt.Errorf("begin Runtime transition: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	stored, err := scanOperation(tx.QueryRowContext(ctx, selectOperationForUpdateSQL, candidate.RequestID))
	if err == nil {
		if stored.RequestDigest != candidate.RequestDigest || stored.Kind != candidate.Kind ||
			stored.AgentID != candidate.AgentID {
			return deployment.Operation{}, false, repository.ErrIdempotencyConflict
		}
		if stored.State == deployment.OperationRunning || stored.State == deployment.OperationUnknown {
			stored, err = scanOperation(tx.QueryRowContext(ctx, claimOperationAttemptSQL,
				candidate.RequestID, candidate.UpdatedAt,
			))
			if err != nil {
				return deployment.Operation{}, false, err
			}
			if err := verifyTransitionOwner(ctx, tx, stored); err != nil {
				return deployment.Operation{}, false, err
			}
		}
		if err := tx.Commit(); err != nil {
			return deployment.Operation{}, false, fmt.Errorf("commit Runtime operation replay: %w", err)
		}
		return stored, true, nil
	}
	if !errors.Is(err, repository.ErrNotFound) {
		return deployment.Operation{}, false, err
	}

	current, err := scanEnvironment(tx.QueryRowContext(ctx, selectEnvironmentForUpdateSQL, candidate.AgentID))
	if errors.Is(err, repository.ErrNotFound) {
		current = deployment.Environment{
			AgentID: candidate.AgentID, LifecycleState: deployment.LifecycleUninitialized,
		}
	} else if err != nil {
		return deployment.Operation{}, false, err
	}
	if err := matchOperationSource(candidate, current); err != nil {
		return deployment.Operation{}, false, err
	}
	transition := candidate.Transition
	if transition == "" {
		return deployment.Operation{}, false, repository.ErrTransitionConflict
	}
	candidate.Attempt = 1
	if _, err := tx.ExecContext(ctx, insertOperationSQL, operationArguments(candidate)...); err != nil {
		if strings.Contains(err.Error(), "operations_agent_nonterminal_unique") {
			return deployment.Operation{}, false, repository.ErrConcurrentMutation
		}
		return deployment.Operation{}, false, fmt.Errorf("insert Runtime operation: %w", err)
	}
	if err := writeTransitionEnvironment(ctx, tx, candidate, transition, current.LifecycleState); err != nil {
		return deployment.Operation{}, false, err
	}
	if candidate.CreatesCompute() {
		if err := claimGeneration(ctx, tx, candidate); err != nil {
			return deployment.Operation{}, false, err
		}
	}
	if err := tx.Commit(); err != nil {
		return deployment.Operation{}, false, fmt.Errorf("commit Runtime transition: %w", err)
	}
	return candidate, false, nil
}

func matchOperationSource(operation deployment.Operation, current deployment.Environment) error {
	if current.LifecycleState != operation.SourceState || current.Generation != operation.SourceGeneration ||
		current.SpecDigest != operation.SourceSpecDigest {
		return repository.ErrTransitionConflict
	}
	if current.RuntimeRevision != operation.SourceRevision {
		return repository.ErrRevisionConflict
	}
	if current.OperationID != "" {
		return repository.ErrConcurrentMutation
	}
	return nil
}

func verifyTransitionOwner(ctx context.Context, tx *sql.Tx, operation deployment.Operation) error {
	current, err := scanEnvironment(tx.QueryRowContext(ctx, selectEnvironmentForUpdateSQL, operation.AgentID))
	if err != nil {
		return err
	}
	if current.OperationID != operation.RequestID || current.RuntimeRevision != operation.RuntimeRevision {
		return repository.ErrInvariantConflict
	}
	return nil
}

func writeTransitionEnvironment(
	ctx context.Context,
	tx *sql.Tx,
	operation deployment.Operation,
	state deployment.LifecycleState,
	sourceState deployment.LifecycleState,
) error {
	if sourceState == deployment.LifecycleUninitialized {
		_, err := tx.ExecContext(ctx, insertEnvironmentSQL,
			operation.AgentID, operation.RuntimeRevision, state, operation.Generation,
			operation.SpecDigest, operation.RequestID, operation.UpdatedAt,
		)
		if err != nil {
			return fmt.Errorf("insert Runtime environment transition: %w", err)
		}
		return nil
	}
	result, err := tx.ExecContext(ctx, updateEnvironmentTransitionSQL,
		operation.RuntimeRevision, state, operation.Generation, operation.SpecDigest,
		operation.RequestID, operation.UpdatedAt, operation.AgentID,
		operation.SourceRevision, operation.SourceState, operation.SourceGeneration,
		operation.SourceSpecDigest,
	)
	if err != nil {
		return fmt.Errorf("update Runtime environment transition: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read Runtime environment transition result: %w", err)
	}
	if rows != 1 {
		return repository.ErrRevisionConflict
	}
	return nil
}

func claimGeneration(ctx context.Context, tx *sql.Tx, operation deployment.Operation) error {
	result, err := tx.ExecContext(ctx, insertGenerationClaimSQL,
		operation.AgentID, operation.Generation, operation.RuntimeRevision, operation.SpecDigest,
	)
	if err != nil {
		return fmt.Errorf("claim Runtime generation: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read Runtime generation claim result: %w", err)
	}
	if rows == 1 {
		return nil
	}
	claim, err := scanGenerationClaim(tx.QueryRowContext(ctx, selectGenerationClaimSQL,
		operation.AgentID, operation.Generation,
	))
	if err != nil {
		return err
	}
	if claim.RuntimeRevision != operation.RuntimeRevision || claim.SpecDigest != operation.SpecDigest {
		return deployment.ErrIdentityConflict
	}
	return nil
}

func (r *Repository) GenerationClaim(
	ctx context.Context, key deployment.Key,
) (repository.GenerationClaim, error) {
	return scanGenerationClaim(r.database.QueryRowContext(ctx, selectGenerationClaimSQL,
		key.AgentID, key.Generation,
	))
}

func scanGenerationClaim(row scanner) (repository.GenerationClaim, error) {
	var claim repository.GenerationClaim
	if err := row.Scan(&claim.RuntimeRevision, &claim.SpecDigest); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return repository.GenerationClaim{}, repository.ErrNotFound
		}
		return repository.GenerationClaim{}, fmt.Errorf("scan Runtime generation claim: %w", err)
	}
	return claim, nil
}

func (r *Repository) CompleteOperation(
	ctx context.Context,
	operation deployment.Operation,
	observation *deployment.Observation,
) (*deployment.Observation, error) {
	inspection, err := encodeEnvironment(operation.Inspection)
	if err != nil {
		return nil, err
	}
	tx, err := r.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return nil, fmt.Errorf("begin Runtime operation completion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stored, err := scanOperation(tx.QueryRowContext(ctx, selectOperationForUpdateSQL, operation.RequestID))
	if err != nil {
		return nil, err
	}
	if stored.Attempt != operation.Attempt ||
		(stored.State != deployment.OperationRunning && stored.State != deployment.OperationUnknown) {
		return nil, repository.ErrOperationFinalized
	}
	if err := verifyTransitionOwner(ctx, tx, operation); err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, updateOperationSQL,
		operation.State, operation.Effect, inspection, operation.ErrorCode,
		operation.ErrorDetail, operation.UpdatedAt, operation.RequestID, operation.Attempt,
	)
	if err != nil {
		return nil, fmt.Errorf("save Runtime operation: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return nil, fmt.Errorf("read Runtime operation update result: %w", err)
	}
	if rows != 1 {
		return nil, repository.ErrOperationFinalized
	}
	if err := completeEnvironment(ctx, tx, operation); err != nil {
		return nil, err
	}
	storedObservation, err := r.storeObservation(ctx, tx, observation)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit Runtime operation completion: %w", err)
	}
	return storedObservation, nil
}

func encodeEnvironment(environment *deployment.Environment) (any, error) {
	if environment == nil {
		return nil, nil
	}
	encoded, err := json.Marshal(environmentSnapshotFromDomain(*environment))
	if err != nil {
		return nil, fmt.Errorf("encode Runtime operation inspection: %w", err)
	}
	return encoded, nil
}

func completeEnvironment(ctx context.Context, tx *sql.Tx, operation deployment.Operation) error {
	switch operation.State {
	case deployment.OperationCompleted:
		return completeEnvironmentResult(ctx, tx, operation)
	case deployment.OperationUnknown:
		result, err := tx.ExecContext(ctx, markEnvironmentUnknownSQL,
			operation.RuntimeRevision, operation.Generation, operation.SpecDigest,
			operation.UpdatedAt, operation.AgentID, operation.RequestID,
		)
		return requireSingleEnvironmentUpdate(result, err, "mark unknown")
	case deployment.OperationFailed:
		if operation.SourceState == deployment.LifecycleUninitialized {
			if operation.Inspection == nil || operation.Inspection.LifecycleState != deployment.LifecycleFailed {
				return fmt.Errorf("failed Initialize must retain its Runtime environment")
			}
			return completeEnvironmentResult(ctx, tx, operation)
		}
		result, err := tx.ExecContext(ctx, restoreEnvironmentSQL,
			operation.SourceRevision, operation.SourceState, operation.SourceGeneration,
			operation.SourceSpecDigest, operation.UpdatedAt, operation.AgentID, operation.RequestID,
		)
		return requireSingleEnvironmentUpdate(result, err, "restore")
	default:
		return fmt.Errorf("cannot complete Runtime environment with operation state %q", operation.State)
	}
}

func completeEnvironmentResult(ctx context.Context, tx *sql.Tx, operation deployment.Operation) error {
	if operation.Inspection == nil {
		return fmt.Errorf("terminal Runtime operation is missing its environment result")
	}
	result, err := tx.ExecContext(ctx, completeEnvironmentSQL,
		operation.Inspection.RuntimeRevision, operation.Inspection.LifecycleState,
		operation.Inspection.Generation, operation.Inspection.SpecDigest,
		operation.UpdatedAt, operation.AgentID, operation.RequestID,
	)
	return requireSingleEnvironmentUpdate(result, err, "complete")
}

func requireSingleEnvironmentUpdate(result sql.Result, err error, action string) error {
	if err != nil {
		return fmt.Errorf("%s Runtime environment: %w", action, err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read %s Runtime environment result: %w", action, err)
	}
	if rows != 1 {
		return repository.ErrOperationFinalized
	}
	return nil
}

func (r *Repository) storeObservation(
	ctx context.Context, tx *sql.Tx, observation *deployment.Observation,
) (*deployment.Observation, error) {
	if observation == nil {
		return nil, nil
	}
	if err := observation.Validate(); err != nil {
		return nil, err
	}
	value := *observation
	if err := insertObservation(ctx, tx, &value); err != nil {
		return nil, err
	}
	if err := notifyObservation(ctx, tx); err != nil {
		return nil, err
	}
	if _, err := tx.ExecContext(ctx, pruneObservationsSQL, time.Now().UTC().Add(-r.retention)); err != nil {
		return nil, fmt.Errorf("prune Runtime observations: %w", err)
	}
	return &value, nil
}

func (r *Repository) GetOperation(
	ctx context.Context, requestID string,
) (deployment.Operation, error) {
	return scanOperation(r.database.QueryRowContext(ctx, selectOperationSQL, requestID))
}

func (r *Repository) GetEnvironment(
	ctx context.Context, agentID string,
) (deployment.Environment, error) {
	return scanEnvironment(r.database.QueryRowContext(ctx, selectEnvironmentSQL, agentID))
}

func (r *Repository) ListEnvironments(
	ctx context.Context,
) (result []deployment.Environment, resultErr error) {
	rows, err := r.database.QueryContext(ctx, listEnvironmentsSQL)
	if err != nil {
		return nil, fmt.Errorf("list Runtime environments: %w", err)
	}
	defer joinCloseError(&resultErr, "Runtime environment rows", rows.Close)
	result = make([]deployment.Environment, 0)
	for rows.Next() {
		value, scanErr := scanEnvironment(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, value)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Runtime environments: %w", err)
	}
	return result, nil
}

func (r *Repository) AppendObservation(
	ctx context.Context, observation deployment.Observation,
) (deployment.Observation, error) {
	if err := observation.Validate(); err != nil {
		return deployment.Observation{}, err
	}
	tx, err := r.database.BeginTx(ctx, nil)
	if err != nil {
		return deployment.Observation{}, fmt.Errorf("begin Runtime observation append: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	stored, err := r.storeObservation(ctx, tx, &observation)
	if err != nil {
		return deployment.Observation{}, err
	}
	if err := tx.Commit(); err != nil {
		return deployment.Observation{}, fmt.Errorf("commit Runtime observation: %w", err)
	}
	return *stored, nil
}

type queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func insertObservation(
	ctx context.Context, queryer queryer, observation *deployment.Observation,
) error {
	if err := queryer.QueryRowContext(ctx, insertObservationSQL,
		observation.AgentID, observation.RuntimeRevision, observation.Generation,
		observation.SpecDigest, observation.PlatformResourceID, observation.RuntimeExecutionID,
		observation.Kind, observation.Source, observation.DiagnosticSummary, observation.ObservedAt,
	).Scan(&observation.Sequence); err != nil {
		return fmt.Errorf("append Runtime observation: %w", err)
	}
	return nil
}

type executer interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func notifyObservation(ctx context.Context, executer executer) error {
	if _, err := executer.ExecContext(ctx, notifyObservationSQL); err != nil {
		return fmt.Errorf("notify Runtime observation listeners: %w", err)
	}
	return nil
}

func (r *Repository) ListObservations(
	ctx context.Context, after uint64, limit int,
) (deployment.ObservationWindow, error) {
	tx, err := r.database.BeginTx(ctx, &sql.TxOptions{
		Isolation: sql.LevelRepeatableRead,
		ReadOnly:  true,
	})
	if err != nil {
		return deployment.ObservationWindow{}, fmt.Errorf("begin Runtime observation window read: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var window deployment.ObservationWindow
	if err := tx.QueryRowContext(ctx, selectObservationBoundsSQL).Scan(
		&window.OldestSequence, &window.LatestSequence,
	); err != nil {
		return deployment.ObservationWindow{}, fmt.Errorf("read Runtime observation bounds: %w", err)
	}
	rows, err := tx.QueryContext(ctx, selectObservationsSQL, after, limit)
	if err != nil {
		return deployment.ObservationWindow{}, fmt.Errorf("list Runtime observations: %w", err)
	}
	window.Observations = make([]deployment.Observation, 0, limit)
	for rows.Next() {
		observation, scanErr := scanObservation(rows)
		if scanErr != nil {
			return deployment.ObservationWindow{}, scanErr
		}
		window.Observations = append(window.Observations, observation)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return deployment.ObservationWindow{}, fmt.Errorf("iterate Runtime observations: %w", err)
	}
	if err := rows.Close(); err != nil {
		return deployment.ObservationWindow{}, fmt.Errorf("close Runtime observation rows: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return deployment.ObservationWindow{}, fmt.Errorf("commit Runtime observation window read: %w", err)
	}
	return window, nil
}

type environmentSnapshot struct {
	AgentID            string                     `json:"agent_id"`
	RuntimeRevision    deployment.RuntimeRevision `json:"runtime_revision"`
	LifecycleState     deployment.LifecycleState  `json:"lifecycle_state"`
	Health             deployment.HealthState     `json:"health"`
	MCPEndpoint        string                     `json:"mcp_endpoint,omitempty"`
	RuntimeExecutionID string                     `json:"runtime_execution_id,omitempty"`
	RestartCount       uint64                     `json:"restart_count"`
	ObservedAt         time.Time                  `json:"observed_at"`
}

func environmentSnapshotFromDomain(value deployment.Environment) environmentSnapshot {
	return environmentSnapshot{
		AgentID: value.AgentID, RuntimeRevision: value.RuntimeRevision,
		LifecycleState: value.LifecycleState, Health: value.Health,
		MCPEndpoint: value.MCPEndpoint, RuntimeExecutionID: value.RuntimeExecutionID,
		RestartCount: value.RestartCount, ObservedAt: value.ObservedAt,
	}
}

func (s environmentSnapshot) domain() deployment.Environment {
	return deployment.Environment{
		AgentID: s.AgentID, RuntimeRevision: s.RuntimeRevision,
		LifecycleState: s.LifecycleState, Health: s.Health,
		MCPEndpoint: s.MCPEndpoint, RuntimeExecutionID: s.RuntimeExecutionID,
		RestartCount: s.RestartCount, ObservedAt: s.ObservedAt,
	}
}

type scanner interface {
	Scan(...any) error
}

func scanOperation(row scanner) (deployment.Operation, error) {
	var operation deployment.Operation
	var inspection []byte
	err := row.Scan(
		&operation.RequestID, &operation.RequestDigest, &operation.Kind, &operation.AgentID,
		&operation.RuntimeRevision, &operation.ExpectedRevision,
		&operation.SourceState, &operation.SourceRevision, &operation.SourceGeneration,
		&operation.SourceSpecDigest, &operation.Generation, &operation.SpecDigest,
		&operation.Attempt, &operation.State, &operation.Effect, &inspection,
		&operation.ErrorCode, &operation.ErrorDetail, &operation.CreatedAt, &operation.UpdatedAt,
		&operation.ImageReference, &operation.ImageID,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deployment.Operation{}, repository.ErrNotFound
		}
		return deployment.Operation{}, fmt.Errorf("scan Runtime operation: %w", err)
	}
	if len(inspection) > 0 {
		var snapshot environmentSnapshot
		if err := json.Unmarshal(inspection, &snapshot); err != nil {
			return deployment.Operation{}, fmt.Errorf("decode Runtime operation inspection: %w", err)
		}
		environment := snapshot.domain()
		operation.Inspection = &environment
	}
	return operation, nil
}

func scanEnvironment(row scanner) (deployment.Environment, error) {
	var environment deployment.Environment
	var operationID sql.NullString
	if err := row.Scan(
		&environment.AgentID, &environment.RuntimeRevision, &environment.LifecycleState,
		&environment.Generation, &environment.SpecDigest, &operationID, &environment.ObservedAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deployment.Environment{}, repository.ErrNotFound
		}
		return deployment.Environment{}, fmt.Errorf("scan Runtime environment: %w", err)
	}
	environment.OperationID = operationID.String
	switch environment.LifecycleState {
	case deployment.LifecycleDisabled, deployment.LifecycleDeleted:
		environment.Health = deployment.HealthAbsent
	default:
		environment.Health = deployment.HealthUnknown
	}
	return environment, nil
}

func scanObservation(row scanner) (deployment.Observation, error) {
	var observation deployment.Observation
	if err := row.Scan(
		&observation.Sequence, &observation.AgentID, &observation.RuntimeRevision,
		&observation.Generation, &observation.SpecDigest, &observation.PlatformResourceID,
		&observation.RuntimeExecutionID, &observation.Kind, &observation.Source,
		&observation.DiagnosticSummary, &observation.ObservedAt,
	); err != nil {
		return deployment.Observation{}, fmt.Errorf("scan Runtime observation: %w", err)
	}
	return observation, nil
}

func operationArguments(operation deployment.Operation) []any {
	return []any{
		operation.RequestID, operation.RequestDigest, operation.Kind, operation.AgentID,
		operation.RuntimeRevision, operation.ExpectedRevision,
		operation.SourceState, operation.SourceRevision, operation.SourceGeneration,
		operation.SourceSpecDigest, operation.Generation, operation.SpecDigest,
		operation.Attempt, operation.State, operation.Effect,
		operation.ErrorCode, operation.ErrorDetail, operation.CreatedAt, operation.UpdatedAt,
		operation.ImageReference, operation.ImageID,
	}
}

const insertOperationSQL = `
INSERT INTO runtime_controller.operations (
    request_id, request_digest, kind, agent_id, runtime_revision, expected_revision,
    source_state, source_revision, source_generation, source_spec_digest,
    target_generation, target_spec_digest, attempt, state, effect,
    error_code, error_detail, created_at, updated_at, image_reference, image_id
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`

const claimOperationAttemptSQL = `
UPDATE runtime_controller.operations
SET attempt = attempt + 1, updated_at = $2
WHERE request_id = $1 AND state IN ('running', 'unknown')
RETURNING ` + operationColumns

const updateOperationSQL = `
UPDATE runtime_controller.operations
SET state = $1, effect = $2, inspection = $3, error_code = $4,
    error_detail = $5, updated_at = $6
WHERE request_id = $7 AND attempt = $8 AND state IN ('running', 'unknown')`

const operationColumns = `request_id, request_digest, kind, agent_id, runtime_revision,
expected_revision, source_state, source_revision, source_generation, source_spec_digest,
target_generation, target_spec_digest, attempt, state, effect, inspection,
error_code, error_detail, created_at, updated_at, image_reference, image_id`

const selectOperationSQL = `SELECT ` + operationColumns + `
FROM runtime_controller.operations WHERE request_id = $1`

const selectOperationForUpdateSQL = selectOperationSQL + ` FOR UPDATE`

const environmentColumns = `agent_id, runtime_revision, lifecycle_state, generation,
spec_digest, operation_id, updated_at`

const selectEnvironmentSQL = `SELECT ` + environmentColumns + `
FROM runtime_controller.runtime_environments WHERE agent_id = $1`

const selectEnvironmentForUpdateSQL = selectEnvironmentSQL + ` FOR UPDATE`

const listEnvironmentsSQL = `SELECT ` + environmentColumns + `
FROM runtime_controller.runtime_environments
WHERE lifecycle_state <> 'deleted'
ORDER BY agent_id`

const insertEnvironmentSQL = `
INSERT INTO runtime_controller.runtime_environments (
    agent_id, runtime_revision, lifecycle_state, generation, spec_digest, operation_id, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)`

const updateEnvironmentTransitionSQL = `
UPDATE runtime_controller.runtime_environments
SET runtime_revision = $1, lifecycle_state = $2, generation = $3,
    spec_digest = $4, operation_id = $5, updated_at = $6
WHERE agent_id = $7 AND runtime_revision = $8 AND lifecycle_state = $9
  AND generation = $10 AND spec_digest = $11 AND operation_id IS NULL`

const completeEnvironmentSQL = `
UPDATE runtime_controller.runtime_environments
SET runtime_revision = $1, lifecycle_state = $2, generation = $3,
    spec_digest = $4, operation_id = NULL, updated_at = $5
WHERE agent_id = $6 AND operation_id = $7`

const markEnvironmentUnknownSQL = `
UPDATE runtime_controller.runtime_environments
SET runtime_revision = $1, lifecycle_state = 'unknown', generation = $2,
    spec_digest = $3, updated_at = $4
WHERE agent_id = $5 AND operation_id = $6`

const restoreEnvironmentSQL = `
UPDATE runtime_controller.runtime_environments
SET runtime_revision = $1, lifecycle_state = $2, generation = $3,
    spec_digest = $4, operation_id = NULL, updated_at = $5
WHERE agent_id = $6 AND operation_id = $7`

const insertGenerationClaimSQL = `
INSERT INTO runtime_controller.generation_claims (
    agent_id, generation, runtime_revision, spec_digest
) VALUES ($1, $2, $3, $4)
ON CONFLICT (agent_id, generation) DO NOTHING`

const selectGenerationClaimSQL = `
SELECT runtime_revision, spec_digest FROM runtime_controller.generation_claims
WHERE agent_id = $1 AND generation = $2`

const insertObservationSQL = `
INSERT INTO runtime_controller.observations (
    agent_id, runtime_revision, generation, spec_digest, platform_resource_id,
    runtime_execution_id, kind, source, diagnostic_summary, observed_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING sequence`

const notifyObservationSQL = `SELECT pg_notify('runtime_controller_observation', '')`

const probeObservationNotificationSQL = `SELECT pg_notify('runtime_controller_observation', $1)`

const probeObservationJournalSQL = `
INSERT INTO runtime_controller.observations (
    sequence, agent_id, runtime_revision, generation, spec_digest, kind, source, observed_at
)
VALUES (0, '', '', 0, '', 'reconciled', $1, $2)`

const pruneObservationsSQL = `
DELETE FROM runtime_controller.observations WHERE recorded_at < $1`

const observationColumns = `sequence, agent_id, runtime_revision, generation, spec_digest,
platform_resource_id, runtime_execution_id, kind, source, diagnostic_summary, observed_at`

const selectObservationsSQL = `SELECT ` + observationColumns + `
FROM runtime_controller.observations
WHERE sequence > $1 ORDER BY sequence ASC LIMIT $2`

const selectObservationBoundsSQL = `
SELECT COALESCE(MIN(sequence), 0), COALESCE(MAX(sequence), 0)
FROM runtime_controller.observations`
