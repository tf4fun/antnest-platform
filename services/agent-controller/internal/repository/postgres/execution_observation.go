package postgres

import (
	"context"

	"github.com/jackc/pgx/v5"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const pendingObservationPredicate = `lifecycle_state='created' AND activation_state='enabled'
AND desired_state='enabled' AND executable_execution_revision_id='' AND active_operation_request_id=''`

func lockRuntimeExecutionAgents(ctx context.Context, tx *databaseTransaction, agentIDs []string, includePending bool) ([]ports.AgentRecord, error) {
	rows, err := tx.Query(ctx, `SELECT id, organization_id FROM agent_controller.agents
WHERE id=ANY($1::text[]) OR ($2 AND `+pendingObservationPredicate+`) ORDER BY id`, agentIDs, includePending)
	if err != nil {
		return nil, err
	}
	type reference struct{ id, organization string }
	references, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (reference, error) {
		var item reference
		err := row.Scan(&item.id, &item.organization)
		return item, err
	})
	if err != nil {
		return nil, err
	}
	organizations := make([]string, 0, len(references))
	for _, item := range references {
		organizations = append(organizations, item.organization)
	}
	if err := lockExecutionOrganizations(ctx, tx, organizations); err != nil {
		return nil, err
	}
	agents := make([]ports.AgentRecord, 0, len(references))
	for _, item := range references {
		agent, err := loadAgentRecordForUpdate(ctx, tx, item.id)
		if err != nil {
			return nil, err
		}
		agents = append(agents, agent)
	}
	return agents, nil
}

func (repository *Repository) advanceRuntimeExecutionChanges(ctx context.Context, tx *databaseTransaction, before []ports.AgentRecord) error {
	organizations := []string{}
	for _, previous := range before {
		current, err := loadAgentRecord(ctx, tx, previous.AgentID)
		if err != nil {
			return err
		}
		if runtimeExecutionChanged(previous, current) {
			organizations = append(organizations, current.OrganizationID)
		}
	}
	return repository.advanceExecutionOrganizations(ctx, tx, organizations)
}

func runtimeExecutionChanged(before, after ports.AgentRecord) bool {
	return before.ExecutionRevisionID != after.ExecutionRevisionID ||
		before.RuntimeExecutionID != after.RuntimeExecutionID ||
		before.RuntimeMCPEndpoint != after.RuntimeMCPEndpoint ||
		before.ExecutionReady() != after.ExecutionReady()
}
