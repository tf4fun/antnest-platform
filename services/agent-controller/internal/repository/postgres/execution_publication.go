package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const executionOrganizationLockNamespace int32 = 0x41455850

const executionRevisionQuery = `SELECT revision FROM agent_controller.execution_configuration_sync WHERE organization_id=$1`

var _ ports.ExecutionPublicationStore = (*Repository)(nil)

func lockExecutionOrganization(ctx context.Context, tx *databaseTransaction, organizationID string) error {
	if organizationID == "" {
		return ports.ErrInvalidExecutionConfiguration
	}
	_, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, executionOrganizationLockNamespace, organizationID)
	if err != nil {
		return fmt.Errorf("lock execution configuration organization: %w", err)
	}
	return nil
}

func advanceExecutionRevision(ctx context.Context, tx *databaseTransaction, organizationID string) error {
	result, err := tx.Exec(ctx, `INSERT INTO agent_controller.execution_configuration_sync (organization_id, revision)
VALUES ($1, 1)
ON CONFLICT (organization_id) DO UPDATE
SET revision=execution_configuration_sync.revision+1, updated_at=NOW()
WHERE execution_configuration_sync.revision < $2`, organizationID, ports.MaximumExecutionRevision)
	if err != nil {
		return fmt.Errorf("advance execution configuration revision: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func (repository *Repository) ReadExecutionSource(ctx context.Context, organizationID string) (ports.ExecutionSource, error) {
	tx, err := repository.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return ports.ExecutionSource{}, fmt.Errorf("begin execution source read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var revision int64
	if err := tx.QueryRow(ctx, executionRevisionQuery, organizationID).Scan(&revision); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.ExecutionSource{}, ports.ErrNotFound
		}
		return ports.ExecutionSource{}, fmt.Errorf("read execution configuration revision: %w", err)
	}
	source, err := readExecutionSource(ctx, tx, organizationID, revision)
	if err != nil {
		return ports.ExecutionSource{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.ExecutionSource{}, fmt.Errorf("finish execution source read: %w", err)
	}
	return source, nil
}

func (repository *Repository) GetExecutionSynchronization(ctx context.Context, organizationID string) (ports.ExecutionSynchronization, error) {
	var state ports.ExecutionSynchronization
	err := repository.pool.QueryRow(ctx, `SELECT organization_id, revision, applied_revision, updated_at, applied_at
FROM agent_controller.execution_configuration_sync WHERE organization_id=$1`, organizationID).Scan(
		&state.OrganizationID, &state.Revision, &state.AppliedRevision, &state.UpdatedAt, &state.AppliedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ExecutionSynchronization{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.ExecutionSynchronization{}, fmt.Errorf("read execution synchronization state: %w", err)
	}
	state.UpdatedAt = state.UpdatedAt.UTC()
	if state.AppliedAt != nil {
		value := state.AppliedAt.UTC()
		state.AppliedAt = &value
	}
	return state, nil
}

func (repository *Repository) ListExecutionOrganizations(ctx context.Context, after string, limit int) ([]string, error) {
	if limit < 1 || limit > 200 {
		return nil, ports.ErrInvalidExecutionConfiguration
	}
	rows, err := repository.pool.Query(ctx, `SELECT organization_id FROM agent_controller.execution_configuration_sync
WHERE organization_id > $1 ORDER BY organization_id LIMIT $2`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list execution organizations: %w", err)
	}
	defer rows.Close()
	organizations := make([]string, 0, limit)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan execution organization: %w", err)
		}
		organizations = append(organizations, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read execution organizations: %w", err)
	}
	return organizations, nil
}

func (repository *Repository) RecordExecutionApplied(ctx context.Context, acknowledgement ports.ExecutionAcknowledgement) error {
	if acknowledgement.OrganizationID == "" || acknowledgement.AppliedRevision < 1 || acknowledgement.AppliedRevision > ports.MaximumExecutionRevision {
		return ports.ErrInvalidExecutionConfiguration
	}
	result, err := repository.pool.Exec(ctx, `UPDATE agent_controller.execution_configuration_sync
SET applied_revision=GREATEST(applied_revision, $2),
    applied_at=CASE WHEN $2 >= applied_revision THEN NOW() ELSE applied_at END
WHERE organization_id=$1 AND revision >= $2`, acknowledgement.OrganizationID, acknowledgement.AppliedRevision)
	if err != nil {
		return fmt.Errorf("record applied execution revision: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}
