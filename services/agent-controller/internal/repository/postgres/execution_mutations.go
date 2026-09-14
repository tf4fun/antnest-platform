package postgres

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func agentExecutionOrganization(ctx context.Context, tx *databaseTransaction, agentID string) (string, error) {
	var organization string
	err := tx.QueryRow(ctx, `SELECT organization_id FROM agent_controller.agents WHERE id=$1`, agentID).Scan(&organization)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ports.ErrNotFound
	}
	if err != nil {
		return "", fmt.Errorf("read Agent execution organization: %w", err)
	}
	return organization, nil
}

func lockAgentExecutionConfiguration(ctx context.Context, tx *databaseTransaction, agentID string) error {
	organization, err := agentExecutionOrganization(ctx, tx, agentID)
	if err != nil {
		return err
	}
	return lockExecutionOrganization(ctx, tx, organization)
}

// The request and organization are locked before either lifecycle or Agent rows.
func loadLifecycleExecutionMutation(ctx context.Context, tx *databaseTransaction, requestID string) (ports.LifecycleOperationRecord, error) {
	if err := lockLifecycleRequest(ctx, tx, requestID); err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	operation, err := loadLifecycleOperation(ctx, tx, requestID, "")
	if err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	if err := lockAgentExecutionConfiguration(ctx, tx, operation.AgentID); err != nil {
		return ports.LifecycleOperationRecord{}, err
	}
	return loadLifecycleOperation(ctx, tx, requestID, "FOR UPDATE")
}

func (repository *Repository) advanceAgentExecutionRevision(ctx context.Context, tx *databaseTransaction, agentID string) error {
	organization, err := agentExecutionOrganization(ctx, tx, agentID)
	if err != nil {
		return err
	}
	return repository.advanceExecutionRevision(ctx, tx, organization)
}

func lockExecutionOrganizations(ctx context.Context, tx *databaseTransaction, organizations []string) error {
	rows, err := tx.Query(ctx, `SELECT DISTINCT hashtext(organization_id) AS key
FROM unnest($1::text[]) AS organization_id ORDER BY key`, organizations)
	if err != nil {
		return err
	}
	keys, err := pgx.CollectRows(rows, pgx.RowTo[int32])
	if err != nil {
		return err
	}
	for _, key := range keys {
		if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, $2)`, executionOrganizationLockNamespace, key); err != nil {
			return err
		}
	}
	return nil
}

func (repository *Repository) advanceExecutionOrganizations(ctx context.Context, tx *databaseTransaction, organizations []string) error {
	slices.Sort(organizations)
	for _, organization := range slices.Compact(organizations) {
		if err := repository.advanceExecutionRevision(ctx, tx, organization); err != nil {
			return err
		}
	}
	return nil
}
