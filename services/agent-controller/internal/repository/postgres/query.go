package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetAgent(
	ctx context.Context, agentID string,
) (ports.AgentRecord, error) {
	return loadAgentRecord(ctx, repository.pool, agentID)
}

func (repository *Repository) GetAgentConfiguration(
	ctx context.Context, agentID string, agentSpecRevisionID string,
) (ports.AgentConfigurationRecord, error) {
	var record ports.AgentConfigurationRecord
	var snapshotPayload []byte
	err := repository.pool.QueryRow(ctx, `
SELECT spec.agent_id, spec.id, template.name,
       model_profile.id, model_profile.display_name,
       spec.snapshot
FROM agent_controller.agent_spec_revisions AS spec
JOIN agent_controller.agent_templates AS template
  ON template.id = spec.template_id
JOIN agent_controller.model_profiles AS model_profile
  ON model_profile.id = spec.snapshot->>'model_profile_id'
WHERE spec.agent_id = $1 AND spec.id = $2`, agentID, agentSpecRevisionID).Scan(
		&record.AgentID, &record.AgentSpecRevisionID, &record.TemplateName,
		&record.ModelProfileID, &record.ModelProfileName,
		&snapshotPayload,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.AgentConfigurationRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.AgentConfigurationRecord{}, fmt.Errorf("query Agent configuration projection: %w", err)
	}
	var snapshot domain.AgentSpecSnapshot
	if err := json.Unmarshal(snapshotPayload, &snapshot); err != nil {
		return ports.AgentConfigurationRecord{}, fmt.Errorf("decode Agent configuration snapshot: %w", err)
	}
	record.Snapshot = snapshot
	record.ModelProfileRevision = snapshot.ModelProfileVersion
	return record, nil
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

func (repository *Repository) ListWorkspaceAgents(
	ctx context.Context, query ports.WorkspaceAgentQuery,
) ([]ports.WorkspaceAgentRecord, error) {
	statement, arguments, err := buildWorkspaceAgentQueryStatement(query)
	if err != nil {
		return nil, err
	}
	rows, err := repository.pool.Query(ctx, statement, arguments...)
	if err != nil {
		return nil, fmt.Errorf("query workspace Agent projections: %w", err)
	}
	defer rows.Close()
	records := make([]ports.WorkspaceAgentRecord, 0, query.Limit)
	for rows.Next() {
		var record ports.WorkspaceAgentRecord
		if err := rows.Scan(&record.AgentID, &record.Name, &record.CreatedAt,
			&record.LifecycleState, &record.ActivationState, &record.RuntimeState); err != nil {
			return nil, fmt.Errorf("scan workspace Agent projection: %w", err)
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace Agent projections: %w", err)
	}
	return records, nil
}

func buildWorkspaceAgentQueryStatement(query ports.WorkspaceAgentQuery) (string, []any, error) {
	if query.OrganizationID == "" || query.PrincipalID == "" || query.Limit < 1 {
		return "", nil, fmt.Errorf("query workspace Agent projections: scope and positive limit are required")
	}
	if query.AfterCreatedAt.IsZero() != (query.AfterAgentID == "") {
		return "", nil, fmt.Errorf("query workspace Agent projections: incomplete keyset cursor")
	}
	arguments := []any{query.OrganizationID, query.PrincipalID}
	cursor := ""
	if !query.AfterCreatedAt.IsZero() {
		arguments = append(arguments, query.AfterCreatedAt, query.AfterAgentID)
		cursor = "\n  AND (agent.created_at, agent.id) > ($3, $4)"
	}
	arguments = append(arguments, query.Limit)
	statement := fmt.Sprintf(`
SELECT agent.id, agent.name, agent.created_at,
       agent.lifecycle_state, agent.activation_state, agent.runtime_state
FROM agent_controller.agents AS agent
JOIN agent_controller.agent_access_bindings AS access
  ON access.agent_id = agent.id
 AND access.principal_id = $2
 AND access.active
WHERE agent.organization_id = $1
  AND agent.identity_revocation_sequence <= agent.owner_authorization_sequence
  AND agent.desired_state <> 'deleted'%s
ORDER BY agent.created_at, agent.id
LIMIT $%d`, cursor, len(arguments))
	return statement, arguments, nil
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
	if query.ActivationState != "" {
		addEquality("activation_state", query.ActivationState)
	}
	if query.RuntimeState != "" {
		addEquality("runtime_state", query.RuntimeState)
	}
	if !query.IncludeDeleted {
		conditions = append(conditions, "lifecycle_state <> 'deleted'")
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
       failure_detail, aggregate_sequence, created_at, updated_at,
       owner_authorization_sequence, identity_revocation_sequence,
       activation_state, runtime_state, runtime_reason, runtime_detail, runtime_observed_at
FROM agent_controller.agents`
	if len(conditions) != 0 {
		statement += "\nWHERE " + strings.Join(conditions, "\n  AND ")
	}
	arguments = append(arguments, query.Limit)
	statement += fmt.Sprintf("\nORDER BY created_at, id\nLIMIT $%d", len(arguments))
	return statement, arguments, nil
}

var _ ports.AgentQueryStore = (*Repository)(nil)
