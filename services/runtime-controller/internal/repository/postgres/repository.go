package postgres

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
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
	if candidate.PreparedReference != nil {
		if !candidate.CreatesCompute() || candidate.PreparedReference.AgentID != candidate.AgentID {
			return deployment.Operation{}, false, repository.ErrPreparedSkillSetInvalidated
		}
		prepared, err := resolvePreparedSkillSet(ctx, tx, *candidate.PreparedReference, true)
		if err != nil {
			return deployment.Operation{}, false, err
		}
		candidate.PreparedSetID = prepared.SetID
		candidate.PreparedVolumeName = prepared.VolumeName
		candidate.PreparedMaterialization = prepared.Key.Materialization
		candidate.PreparedManifestDigest = prepared.ManifestDigest
		candidate.PreparedReferenceID = candidate.PreparedReference.ReferenceID
	}
	candidate.Attempt = 1
	arguments, err := operationArguments(candidate)
	if err != nil {
		return deployment.Operation{}, false, err
	}
	if _, err := tx.ExecContext(ctx, insertOperationSQL, arguments...); err != nil {
		if strings.Contains(err.Error(), "operations_agent_nonterminal_unique") {
			return deployment.Operation{}, false, repository.ErrConcurrentMutation
		}
		if strings.Contains(err.Error(), "operations_compute_generation_unique") {
			return deployment.Operation{}, false, repository.ErrInvariantConflict
		}
		return deployment.Operation{}, false, fmt.Errorf("insert Runtime operation: %w", err)
	}
	if candidate.PreparedSetID > 0 {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO runtime_controller.skill_lifecycle_references
  (operation_request_id,set_id,materialization,volume_name,manifest_digest)
VALUES ($1,$2,$3,$4,$5)`, candidate.RequestID, candidate.PreparedSetID, candidate.PreparedMaterialization,
			candidate.PreparedVolumeName, candidate.PreparedManifestDigest); err != nil {
			return deployment.Operation{}, false, fmt.Errorf("retain Skill lifecycle reference: %w", err)
		}
	}
	if err := writeTransitionEnvironment(ctx, tx, candidate, transition, current.LifecycleState); err != nil {
		return deployment.Operation{}, false, err
	}
	if candidate.Kind == deployment.OperationDeleteRuntime {
		if err := closeAgentSkillPreparations(ctx, tx, candidate.AgentID); err != nil {
			return deployment.Operation{}, false, err
		}
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

func closeAgentSkillPreparations(ctx context.Context, tx *sql.Tx, agentID string) error {
	if _, err := tx.ExecContext(ctx, `
UPDATE runtime_controller.skill_preparations p SET released=TRUE,updated_at=NOW()
FROM runtime_controller.skill_sets s WHERE p.set_id=s.set_id AND s.agent_id=$1 AND NOT p.released`, agentID); err != nil {
		return fmt.Errorf("release deleted Agent Skill preparations: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE runtime_controller.skill_sets SET state='invalidated',lease_owner='',lease_until=NULL,
  retry_after=NULL,error_code='agent_deleted',updated_at=NOW()
WHERE agent_id=$1 AND state IN ('queued','preparing','retry_wait','paused','rejected')`, agentID); err != nil {
		return fmt.Errorf("cancel deleted Agent Skill preparation work: %w", err)
	}
	return nil
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

func (r *Repository) MaxClaimedGeneration(ctx context.Context, agentID string) (uint64, error) {
	var generation uint64
	if err := r.database.QueryRowContext(ctx, `SELECT COALESCE(MAX(generation),0) FROM runtime_controller.generation_claims WHERE agent_id=$1`, agentID).Scan(&generation); err != nil {
		return 0, fmt.Errorf("read maximum Runtime generation claim: %w", err)
	}
	return generation, nil
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
	if err := settleSkillLifecycleReferences(ctx, tx, stored, operation.State, operation.UpdatedAt); err != nil {
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

func settleSkillLifecycleReferences(ctx context.Context, tx *sql.Tx, stored deployment.Operation, state deployment.OperationState, updatedAt time.Time) error {
	if state == deployment.OperationUnknown {
		return nil // The accepted operation may still need its exact prepared volume on replay.
	}
	if state == deployment.OperationCompleted {
		switch stored.Kind {
		case deployment.OperationInitializeRuntime, deployment.OperationUpdateRuntime, deployment.OperationEnableRuntime:
			if stored.PreparedSetID > 0 {
				if _, err := tx.ExecContext(ctx, `
INSERT INTO runtime_controller.skill_current_references
  (agent_id,set_id,materialization,volume_name,manifest_digest,updated_at)
VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (agent_id) DO UPDATE SET
  set_id=EXCLUDED.set_id,materialization=EXCLUDED.materialization,
  volume_name=EXCLUDED.volume_name,manifest_digest=EXCLUDED.manifest_digest,
  updated_at=EXCLUDED.updated_at`, stored.AgentID, stored.PreparedSetID, stored.PreparedMaterialization,
					stored.PreparedVolumeName, stored.PreparedManifestDigest, updatedAt); err != nil {
					return fmt.Errorf("transfer current Skill reference: %w", err)
				}
			} else if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_current_references WHERE agent_id=$1`, stored.AgentID); err != nil {
				return fmt.Errorf("clear legacy Runtime Skill reference: %w", err)
			}
		case deployment.OperationDeleteRuntime:
			if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_current_references WHERE agent_id=$1`, stored.AgentID); err != nil {
				return fmt.Errorf("release deleted Runtime Skill reference: %w", err)
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM runtime_controller.skill_lifecycle_references WHERE operation_request_id=$1`, stored.RequestID); err != nil {
		return fmt.Errorf("release settled Skill operation reference: %w", err)
	}
	return nil
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
	Phase              deployment.PlatformPhase   `json:"phase"`
	Reason             string                     `json:"reason,omitempty"`
	DiagnosticSummary  string                     `json:"diagnostic_summary,omitempty"`
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
		Phase: value.Phase, Reason: value.Reason, DiagnosticSummary: value.DiagnosticSummary,
		AgentID: value.AgentID, RuntimeRevision: value.RuntimeRevision,
		LifecycleState: value.LifecycleState, Health: value.Health,
		MCPEndpoint: value.MCPEndpoint, RuntimeExecutionID: value.RuntimeExecutionID,
		RestartCount: value.RestartCount, ObservedAt: value.ObservedAt,
	}
}

func (s environmentSnapshot) domain() deployment.Environment {
	return deployment.Environment{
		Phase: s.Phase, Reason: s.Reason, DiagnosticSummary: s.DiagnosticSummary,
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
	var maintenanceVerifiers []byte
	var instanceAuthentication []byte
	var preparedSetID sql.NullInt64
	err := row.Scan(
		&operation.RequestID, &operation.RequestDigest, &operation.Kind, &operation.AgentID,
		&operation.RuntimeRevision, &operation.ExpectedRevision,
		&operation.SourceState, &operation.SourceRevision, &operation.SourceGeneration,
		&operation.SourceSpecDigest, &operation.Generation, &operation.SpecDigest,
		&operation.Attempt, &operation.State, &operation.Effect, &inspection,
		&operation.ErrorCode, &operation.ErrorDetail, &operation.CreatedAt, &operation.UpdatedAt,
		&operation.ImageReference, &operation.ImageID,
		&preparedSetID, &operation.PreparedVolumeName, &operation.PreparedMaterialization,
		&operation.PreparedManifestDigest, &operation.PreparedReferenceID,
		&maintenanceVerifiers,
		&instanceAuthentication,
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
	operation.PreparedSetID = preparedSetID.Int64
	if len(instanceAuthentication) > 0 {
		accepted, err := instanceauth.Decode(instanceAuthentication)
		if err != nil {
			return deployment.Operation{}, err
		}
		operation.InstanceAuthentication = accepted
	}
	if len(maintenanceVerifiers) > 0 {
		decoder := json.NewDecoder(bytes.NewReader(maintenanceVerifiers))
		decoder.DisallowUnknownFields()
		var snapshot deployment.MaintenanceVerifiers
		if err := decoder.Decode(&snapshot); err != nil {
			return deployment.Operation{}, fmt.Errorf("decode maintenance verifier snapshot: %w", err)
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			return deployment.Operation{}, fmt.Errorf("maintenance verifier snapshot contains trailing data")
		}
		canonical, err := snapshot.Normalize()
		if err != nil || !slices.Equal(snapshot.Keys, canonical.Keys) {
			return deployment.Operation{}, fmt.Errorf("maintenance verifier snapshot is invalid or unsorted")
		}
		operation.MaintenanceVerifiers = &canonical
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

func operationArguments(operation deployment.Operation) ([]any, error) {
	var instanceSnapshot any
	if operation.InstanceAuthentication != nil {
		encoded, err := json.Marshal(operation.InstanceAuthentication)
		if err != nil {
			return nil, fmt.Errorf("encode accepted instance authority failed")
		}
		if _, err := instanceauth.Decode(encoded); err != nil {
			return nil, err
		}
		if !operation.CreatesCompute() {
			return nil, fmt.Errorf("instance authority belongs only to a compute creator")
		}
		instanceSnapshot = encoded
	}
	var verifierSnapshot any
	if operation.MaintenanceVerifiers != nil {
		canonical, err := operation.MaintenanceVerifiers.Normalize()
		if err != nil || !slices.Equal(operation.MaintenanceVerifiers.Keys, canonical.Keys) {
			return nil, fmt.Errorf("invalid accepted maintenance verifier snapshot")
		}
		encoded, err := json.Marshal(canonical)
		if err != nil {
			return nil, fmt.Errorf("encode maintenance verifier snapshot: %w", err)
		}
		verifierSnapshot = encoded
	} else if operation.CreatesCompute() {
		return nil, fmt.Errorf("accepted maintenance verifier snapshot is missing")
	}
	return []any{
		operation.RequestID, operation.RequestDigest, operation.Kind, operation.AgentID,
		operation.RuntimeRevision, operation.ExpectedRevision,
		operation.SourceState, operation.SourceRevision, operation.SourceGeneration,
		operation.SourceSpecDigest, operation.Generation, operation.SpecDigest,
		operation.Attempt, operation.State, operation.Effect,
		operation.ErrorCode, operation.ErrorDetail, operation.CreatedAt, operation.UpdatedAt,
		operation.ImageReference, operation.ImageID,
		nullablePreparedSetID(operation.PreparedSetID), operation.PreparedVolumeName,
		operation.PreparedMaterialization, operation.PreparedManifestDigest, operation.PreparedReferenceID,
		verifierSnapshot,
		instanceSnapshot,
	}, nil
}

func nullablePreparedSetID(value int64) any {
	if value == 0 {
		return nil
	}
	return value
}

const insertOperationSQL = `
INSERT INTO runtime_controller.operations (
    request_id, request_digest, kind, agent_id, runtime_revision, expected_revision,
    source_state, source_revision, source_generation, source_spec_digest,
    target_generation, target_spec_digest, attempt, state, effect,
    error_code, error_detail, created_at, updated_at, image_reference, image_id,
    skill_set_id,skill_volume_name,skill_materialization,skill_manifest_digest,skill_reference_id,
    maintenance_verifiers, instance_authentication
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28)`

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
error_code, error_detail, created_at, updated_at, image_reference, image_id,
skill_set_id,skill_volume_name,skill_materialization,skill_manifest_digest,skill_reference_id,
maintenance_verifiers, instance_authentication`

const selectOperationSQL = `SELECT ` + operationColumns + `
FROM runtime_controller.operations WHERE request_id = $1`

const selectOperationForUpdateSQL = selectOperationSQL + ` FOR UPDATE`

func (r *Repository) GenerationOperation(ctx context.Context, key deployment.Key) (deployment.Operation, error) {
	if err := key.Validate(); err != nil {
		return deployment.Operation{}, err
	}
	return scanOperation(r.database.QueryRowContext(ctx, `SELECT `+operationColumns+`
FROM runtime_controller.operations WHERE agent_id = $1 AND target_generation = $2
AND kind IN ('initialize_runtime', 'update_runtime', 'enable_runtime')`, key.AgentID, key.Generation))
}

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
