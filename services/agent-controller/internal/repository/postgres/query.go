package postgres

import (
	"context"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetAgent(
	ctx context.Context, agentID string,
) (ports.AgentRecord, error) {
	return loadAgentRecord(ctx, repository.pool, agentID)
}

func (repository *Repository) ListAgents(
	ctx context.Context, query ports.AgentQuery,
) ([]ports.AgentRecord, error) {
	statement, arguments, err := buildAgentQueryStatement(query)
	if err != nil {
		return nil, err
	}
	rows, err := repository.pool.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, fmt.Errorf("query Agent projections: %w", err)
	}
	defer rows.Close()
	records := make([]ports.AgentRecord, 0, query.Limit)
	for rows.Next() {
		record, scanErr := scanAgentRecord(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate Agent projections: %w", err)
	}
	return records, nil
}

func buildAgentQueryStatement(query ports.AgentQuery) (string, []any, error) {
	if query.Limit < 1 {
		return "", nil, fmt.Errorf("query Agent projections: limit must be positive")
	}
	if query.AfterCreatedAt.IsZero() != (query.AfterAgentID == "") {
		return "", nil, fmt.Errorf("query Agent projections: incomplete keyset cursor")
	}
	conditions := make([]string, 0, 5)
	arguments := make([]any, 0, 6)
	addEquality := func(column string, value any) {
		arguments = append(arguments, value)
		conditions = append(conditions, fmt.Sprintf("%s = $%d", column, len(arguments)))
	}
	if query.OrganizationID != "" {
		addEquality("organization_id", query.OrganizationID)
	}
	if query.OwnerUserID != "" {
		addEquality("owner_user_id", query.OwnerUserID)
	}
	if query.LifecycleState != "" {
		addEquality("lifecycle_state", query.LifecycleState)
	}
	if !query.IncludeDeleted {
		conditions = append(conditions, "desired_state <> 'deleted'")
	}
	if !query.AfterCreatedAt.IsZero() {
		arguments = append(arguments, query.AfterCreatedAt, query.AfterAgentID)
		conditions = append(conditions, fmt.Sprintf(
			"(created_at, id) > ($%d, $%d)", len(arguments)-1, len(arguments),
		))
	}
	statement := `
SELECT id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
       access_revision, executable_spec_revision_id, executable_execution_revision_id,
       last_successful_execution_revision_id, runtime_revision, runtime_execution_id,
       runtime_mcp_endpoint, active_operation_request_id, failure_stage, failure_code,
       failure_detail, aggregate_sequence, created_at, updated_at
FROM agent_controller.agents`
	if len(conditions) != 0 {
		statement += "\nWHERE " + strings.Join(conditions, "\n  AND ")
	}
	arguments = append(arguments, query.Limit)
	statement += fmt.Sprintf("\nORDER BY created_at, id\nLIMIT $%d", len(arguments))
	return statement, arguments, nil
}

var _ ports.AgentQueryStore = (*Repository)(nil)
