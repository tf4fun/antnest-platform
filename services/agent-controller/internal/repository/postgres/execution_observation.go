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
		changed, err := runtimeExecutionChanged(ctx, tx, previous, current)
		if err != nil {
			return err
		}
		if changed {
			organizations = append(organizations, current.OrganizationID)
		}
	}
	return repository.advanceExecutionOrganizations(ctx, tx, organizations)
}

func runtimeExecutionChanged(ctx context.Context, tx *databaseTransaction, before, after ports.AgentRecord) (bool, error) {
	if before.ExecutionRevisionID != after.ExecutionRevisionID || before.RuntimeExecutionID != after.RuntimeExecutionID || before.RuntimeMCPEndpoint != after.RuntimeMCPEndpoint {
		return true, nil
	}
	if before.ExecutionReady() == after.ExecutionReady() {
		return false, nil
	}
	var modelAvailable bool
	err := tx.QueryRow(ctx, `SELECT EXISTS (
SELECT 1 FROM agent_controller.agent_spec_revisions s
JOIN agent_controller.model_profiles m ON m.id=s.snapshot->>'model_profile_id' AND m.organization_id=$3
JOIN agent_controller.provider_connections p ON p.id=m.provider_connection_id AND p.organization_id=m.organization_id
WHERE s.id=$1 AND s.agent_id=$2 AND m.enabled AND p.enabled)`,
		after.AgentSpecRevisionID, after.AgentID, after.OrganizationID).Scan(&modelAvailable)
	return modelAvailable, err
}
