package postgres

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

var (
	_ application.Repository  = (*Repository)(nil)
	_ application.Transaction = (*transaction)(nil)
)

type Repository struct {
	database *sql.DB
}

const (
	maxTransactionAttempts = 5
	initialRetryDelay      = 5 * time.Millisecond
)

func New(database *sql.DB) (*Repository, error) {
	if database == nil {
		return nil, fmt.Errorf("database is required")
	}
	return &Repository{database: database}, nil
}

func (r *Repository) Transact(
	ctx context.Context, apply func(application.Transaction) error,
) error {
	delay := initialRetryDelay
	for attempt := 1; attempt <= maxTransactionAttempts; attempt++ {
		err := r.transactOnce(ctx, apply)
		if err == nil || !isRetryableTransactionError(err) || attempt == maxTransactionAttempts {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return context.Cause(ctx)
		case <-timer.C:
		}
		delay *= 2
	}
	return nil
}

func (r *Repository) transactOnce(
	ctx context.Context, apply func(application.Transaction) error,
) error {
	tx, err := r.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable})
	if err != nil {
		return fmt.Errorf("begin runtime transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := apply(&transaction{tx: tx}); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit runtime transaction: %w", err)
	}
	return nil
}

func isRetryableTransactionError(err error) bool {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return false
	}
	return postgresError.Code == "40001" || postgresError.Code == "40P01"
}

func (r *Repository) GetRuntime(ctx context.Context, agentID string) (domain.Runtime, error) {
	return scanRuntime(r.database.QueryRowContext(ctx, selectRuntimeSQL, agentID))
}

func (r *Repository) GetGeneration(
	ctx context.Context, agentID string, generation uint64,
) (domain.RuntimeGeneration, error) {
	return scanGeneration(r.database.QueryRowContext(ctx, selectGenerationSQL, agentID, generation))
}

func (r *Repository) GetOpenOperation(
	ctx context.Context, agentID string, generation uint64,
) (domain.Operation, error) {
	return scanOperation(r.database.QueryRowContext(ctx, selectOpenOperationSQL, agentID, generation))
}

func (r *Repository) GetOperation(ctx context.Context, operationID string) (domain.Operation, error) {
	return scanOperation(r.database.QueryRowContext(ctx, selectOperationSQL, operationID))
}

func (r *Repository) FindGenerationByInstanceID(
	ctx context.Context, runtimeInstanceID string,
) (domain.RuntimeGeneration, error) {
	return scanGeneration(r.database.QueryRowContext(ctx, selectGenerationByInstanceSQL, runtimeInstanceID))
}

func (r *Repository) ListReadyRuntimeIDs(ctx context.Context) ([]string, error) {
	rows, err := r.database.QueryContext(ctx, selectReadyRuntimeIDsSQL)
	if err != nil {
		return nil, fmt.Errorf("list ready Runtime records: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var agentID string
		if err := rows.Scan(&agentID); err != nil {
			return nil, fmt.Errorf("scan ready Runtime: %w", err)
		}
		result = append(result, agentID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ready Runtime records: %w", err)
	}
	return result, nil
}

func (r *Repository) ListReconcileCandidates(
	ctx context.Context, now time.Time, limit int,
) ([]string, error) {
	if limit <= 0 {
		return nil, fmt.Errorf("reconcile candidate limit must be positive")
	}
	rows, err := r.database.QueryContext(ctx, selectReconcileCandidatesSQL, now, limit)
	if err != nil {
		return nil, fmt.Errorf("list reconcile candidates: %w", err)
	}
	defer rows.Close()
	result := make([]string, 0)
	for rows.Next() {
		var agentID string
		if err := rows.Scan(&agentID); err != nil {
			return nil, fmt.Errorf("scan reconcile candidate: %w", err)
		}
		result = append(result, agentID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate reconcile candidates: %w", err)
	}
	return result, nil
}

type transaction struct {
	tx *sql.Tx
}

func (t *transaction) GetRuntime(ctx context.Context, agentID string) (domain.Runtime, error) {
	return scanRuntime(t.tx.QueryRowContext(ctx, selectRuntimeForUpdateSQL, agentID))
}

func (t *transaction) GetGeneration(
	ctx context.Context, agentID string, generation uint64,
) (domain.RuntimeGeneration, error) {
	return scanGeneration(t.tx.QueryRowContext(ctx, selectGenerationForUpdateSQL, agentID, generation))
}

func (t *transaction) GetOpenOperation(
	ctx context.Context, agentID string, generation uint64,
) (domain.Operation, error) {
	return scanOperation(t.tx.QueryRowContext(ctx, selectOpenOperationForUpdateSQL, agentID, generation))
}

func (t *transaction) GetOperationByIdempotencyKey(
	ctx context.Context, kind domain.OperationKind, agentID, key string,
) (domain.Operation, error) {
	return scanOperation(t.tx.QueryRowContext(ctx, selectOperationByKeySQL, kind, agentID, key))
}

func (t *transaction) NextNetworkOffset(ctx context.Context) (uint64, uint64, error) {
	var offset uint64
	var epoch uint64
	if err := t.tx.QueryRowContext(ctx, nextNetworkOffsetSQL).Scan(&offset, &epoch); err != nil {
		return 0, 0, fmt.Errorf("allocate runtime tunnel address: %w", err)
	}
	return offset, epoch, nil
}

func (t *transaction) SaveRuntime(ctx context.Context, runtime domain.Runtime) error {
	result, err := t.tx.ExecContext(ctx, saveRuntimeSQL,
		runtime.AgentID, runtime.ImageRef, runtime.NetworkMode, runtime.DesiredState, runtime.Status,
		runtime.DesiredGeneration, runtime.ObservedGeneration, runtime.ConnectionEpoch,
		runtime.NetworkPolicyEpoch, runtime.ObservedPolicyEpoch, runtime.SpecDigest,
		runtime.FailureCode, runtime.FailureDetail, runtime.ResourceVersion,
		runtime.CreatedAt, runtime.UpdatedAt,
	)
	return checkWrite(result, err, "runtime")
}

func (t *transaction) SaveGeneration(ctx context.Context, generation domain.RuntimeGeneration) error {
	var nextAttemptAt any
	if !generation.NextAttemptAt.IsZero() {
		nextAttemptAt = generation.NextAttemptAt
	}
	result, err := t.tx.ExecContext(ctx, saveGenerationSQL,
		generation.AgentID, generation.Number, generation.ImageRef, generation.SpecDigest,
		generation.NetworkPolicyEpoch, generation.TunnelIPv4, generation.AllocatorEpoch,
		generation.Status, generation.ContainerID,
		generation.RuntimeInstanceID, generation.ConnectionEpoch,
		generation.WorkEpochFloor, generation.LastWorkID, generation.LastWorkEpoch,
		generation.LastWorkSessionID, generation.FailureCode,
		generation.FailureDetail, generation.RetryCount, nextAttemptAt,
		generation.ResourceVersion, generation.CreatedAt, generation.UpdatedAt,
	)
	return checkWrite(result, err, "runtime generation")
}

func (t *transaction) SaveOperation(ctx context.Context, operation domain.Operation) error {
	_, err := t.tx.ExecContext(ctx, saveOperationSQL,
		operation.ID, operation.AgentID, operation.Kind, operation.Status, operation.Generation,
		operation.IdempotencyKey, operation.RequestDigest, operation.ErrorCode,
		operation.ErrorDetail, operation.CreatedAt, operation.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("save runtime operation: %w", err)
	}
	return nil
}

type scanner interface {
	Scan(...any) error
}

func scanRuntime(row scanner) (domain.Runtime, error) {
	var runtime domain.Runtime
	err := row.Scan(
		&runtime.AgentID, &runtime.ImageRef, &runtime.NetworkMode, &runtime.DesiredState,
		&runtime.Status, &runtime.DesiredGeneration, &runtime.ObservedGeneration,
		&runtime.ConnectionEpoch, &runtime.NetworkPolicyEpoch, &runtime.ObservedPolicyEpoch,
		&runtime.SpecDigest, &runtime.FailureCode, &runtime.FailureDetail,
		&runtime.ResourceVersion, &runtime.CreatedAt, &runtime.UpdatedAt,
	)
	if err != nil {
		return domain.Runtime{}, translateReadError(err, "runtime")
	}
	return runtime, nil
}

func scanGeneration(row scanner) (domain.RuntimeGeneration, error) {
	var generation domain.RuntimeGeneration
	var nextAttemptAt sql.NullTime
	err := row.Scan(
		&generation.AgentID, &generation.Number, &generation.ImageRef, &generation.SpecDigest,
		&generation.NetworkPolicyEpoch, &generation.TunnelIPv4, &generation.AllocatorEpoch,
		&generation.Status, &generation.ContainerID,
		&generation.RuntimeInstanceID, &generation.ConnectionEpoch,
		&generation.WorkEpochFloor, &generation.LastWorkID, &generation.LastWorkEpoch,
		&generation.LastWorkSessionID, &generation.FailureCode,
		&generation.FailureDetail, &generation.RetryCount, &nextAttemptAt,
		&generation.ResourceVersion, &generation.CreatedAt, &generation.UpdatedAt,
	)
	if err != nil {
		return domain.RuntimeGeneration{}, translateReadError(err, "runtime generation")
	}
	if nextAttemptAt.Valid {
		generation.NextAttemptAt = nextAttemptAt.Time
	}
	return generation, nil
}

func scanOperation(row scanner) (domain.Operation, error) {
	var operation domain.Operation
	err := row.Scan(
		&operation.ID, &operation.AgentID, &operation.Kind, &operation.Status,
		&operation.Generation, &operation.IdempotencyKey, &operation.RequestDigest,
		&operation.ErrorCode, &operation.ErrorDetail, &operation.CreatedAt, &operation.UpdatedAt,
	)
	if err != nil {
		return domain.Operation{}, translateReadError(err, "runtime operation")
	}
	return operation, nil
}

func translateReadError(err error, subject string) error {
	if errors.Is(err, sql.ErrNoRows) {
		return application.ErrNotFound
	}
	return fmt.Errorf("read %s: %w", subject, err)
}

func checkWrite(result sql.Result, err error, subject string) error {
	if err != nil {
		return fmt.Errorf("save %s: %w", subject, err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read %s write result: %w", subject, err)
	}
	if rows != 1 {
		return domain.ErrConcurrentWrite
	}
	return nil
}

const runtimeColumns = `agent_id, image_ref, network_mode, desired_state, status,
desired_generation, observed_generation, connection_epoch, network_policy_epoch,
observed_policy_epoch, spec_digest, failure_code, failure_detail, resource_version,
created_at, updated_at`

const generationColumns = `agent_id, generation, image_ref, spec_digest,
network_policy_epoch, tunnel_ipv4, allocator_epoch, status, container_id, runtime_instance_id, connection_epoch,
work_epoch_floor, last_work_id, last_work_epoch, last_work_session_id,
failure_code, failure_detail, retry_count, next_attempt_at, resource_version,
created_at, updated_at`

const operationColumns = `operation_id, agent_id, kind, status, generation,
idempotency_key, request_digest, error_code, error_detail, created_at, updated_at`

const selectRuntimeSQL = `SELECT ` + runtimeColumns + ` FROM runtimes WHERE agent_id = $1`
const selectRuntimeForUpdateSQL = selectRuntimeSQL + ` FOR UPDATE`
const selectGenerationSQL = `SELECT ` + generationColumns + ` FROM runtime_generations WHERE agent_id = $1 AND generation = $2`
const selectGenerationForUpdateSQL = selectGenerationSQL + ` FOR UPDATE`
const selectGenerationByInstanceSQL = `SELECT ` + generationColumns + ` FROM runtime_generations WHERE runtime_instance_id = $1`
const selectOperationSQL = `SELECT ` + operationColumns + ` FROM runtime_operations WHERE operation_id = $1`
const selectOperationByKeySQL = `SELECT ` + operationColumns + ` FROM runtime_operations
WHERE kind = $1 AND agent_id = $2 AND idempotency_key = $3 FOR UPDATE`
const selectReadyRuntimeIDsSQL = `SELECT agent_id FROM runtimes
WHERE desired_state = 'active' AND status = 'ready'
  AND observed_generation = desired_generation
  AND observed_policy_epoch = network_policy_epoch
ORDER BY agent_id`
const selectOpenOperationSQL = `SELECT ` + operationColumns + ` FROM runtime_operations
WHERE agent_id = $1 AND generation = $2 AND status IN ('pending', 'running', 'unknown')
ORDER BY created_at DESC LIMIT 1`
const selectOpenOperationForUpdateSQL = selectOpenOperationSQL + ` FOR UPDATE`
const selectReconcileCandidatesSQL = `SELECT r.agent_id
FROM runtimes r
JOIN runtime_generations g
  ON g.agent_id = r.agent_id AND g.generation = r.desired_generation
WHERE r.status <> 'failed'
  AND NOT (
    (r.desired_state = 'active' AND r.status = 'ready'
      AND r.observed_generation = r.desired_generation
      AND r.observed_policy_epoch = r.network_policy_epoch)
    OR (r.desired_state = 'stopped' AND r.status = 'stopped')
    OR (r.desired_state = 'retired' AND r.status = 'retired')
    OR (r.desired_state = 'purged' AND r.status = 'purged')
  )
  AND (g.next_attempt_at IS NULL OR g.next_attempt_at <= $1)
ORDER BY COALESCE(g.next_attempt_at, r.updated_at), r.agent_id
LIMIT $2`

const saveRuntimeSQL = `INSERT INTO runtimes (` + runtimeColumns + `)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
ON CONFLICT (agent_id) DO UPDATE SET
image_ref=EXCLUDED.image_ref, network_mode=EXCLUDED.network_mode,
desired_state=EXCLUDED.desired_state, status=EXCLUDED.status,
desired_generation=EXCLUDED.desired_generation, observed_generation=EXCLUDED.observed_generation,
connection_epoch=EXCLUDED.connection_epoch, network_policy_epoch=EXCLUDED.network_policy_epoch,
observed_policy_epoch=EXCLUDED.observed_policy_epoch, spec_digest=EXCLUDED.spec_digest,
failure_code=EXCLUDED.failure_code, failure_detail=EXCLUDED.failure_detail,
resource_version=EXCLUDED.resource_version, updated_at=EXCLUDED.updated_at
WHERE runtimes.resource_version = EXCLUDED.resource_version - 1`

const saveGenerationSQL = `INSERT INTO runtime_generations (` + generationColumns + `)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
ON CONFLICT (agent_id, generation) DO UPDATE SET
image_ref=EXCLUDED.image_ref, spec_digest=EXCLUDED.spec_digest,
network_policy_epoch=EXCLUDED.network_policy_epoch, tunnel_ipv4=EXCLUDED.tunnel_ipv4,
allocator_epoch=EXCLUDED.allocator_epoch, status=EXCLUDED.status,
container_id=EXCLUDED.container_id, runtime_instance_id=EXCLUDED.runtime_instance_id,
connection_epoch=EXCLUDED.connection_epoch, work_epoch_floor=EXCLUDED.work_epoch_floor,
last_work_id=EXCLUDED.last_work_id, last_work_epoch=EXCLUDED.last_work_epoch,
last_work_session_id=EXCLUDED.last_work_session_id, failure_code=EXCLUDED.failure_code,
failure_detail=EXCLUDED.failure_detail, retry_count=EXCLUDED.retry_count,
next_attempt_at=EXCLUDED.next_attempt_at, resource_version=EXCLUDED.resource_version,
updated_at=EXCLUDED.updated_at
WHERE runtime_generations.resource_version = EXCLUDED.resource_version - 1`

const nextNetworkOffsetSQL = `UPDATE network_allocator
SET high_watermark = high_watermark + 1, resource_version = resource_version + 1
WHERE allocator_id = TRUE
RETURNING high_watermark, resource_version`

const saveOperationSQL = `INSERT INTO runtime_operations (` + operationColumns + `)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
ON CONFLICT (operation_id) DO UPDATE SET
status=EXCLUDED.status, error_code=EXCLUDED.error_code,
error_detail=EXCLUDED.error_detail, updated_at=EXCLUDED.updated_at`
