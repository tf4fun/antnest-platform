package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetSessionConfiguration(ctx context.Context, input ports.SessionConfigurationQuery) (ports.SessionConfiguration, error) {
	if input.Limit < 1 || input.Limit > 200 {
		return ports.SessionConfiguration{}, fmt.Errorf("invalid model page size")
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.SessionConfiguration{}, fmt.Errorf("begin configuration read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	agent, err := lockSessionConfigurationAgent(ctx, tx, input)
	if err != nil {
		return ports.SessionConfiguration{}, err
	}
	spec, err := loadAgentSpec(ctx, tx, agent.AgentSpecRevisionID)
	if err != nil {
		return ports.SessionConfiguration{}, err
	}
	var result ports.SessionConfiguration
	result.DefaultAuthorization, result.AuthorizationRevision, err = loadAgentAuthorization(ctx, tx, agent.AgentID)
	if err != nil {
		return ports.SessionConfiguration{}, err
	}
	result.DefaultModel, err = loadDefaultSessionModel(ctx, tx, agent.OrganizationID, spec.Snapshot.ModelProfileID)
	if err != nil {
		return ports.SessionConfiguration{}, err
	}
	result.Models, result.NextCursor, err = listSessionModels(ctx, tx, agent.OrganizationID, input)
	if err != nil {
		return ports.SessionConfiguration{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.SessionConfiguration{}, fmt.Errorf("commit configuration read: %w", err)
	}
	return result, nil
}

func lockSessionConfigurationAgent(ctx context.Context, tx *databaseTransaction, input ports.SessionConfigurationQuery) (ports.AgentRecord, error) {
	if err := lockIdentityAdmission(ctx, tx); err != nil {
		return ports.AgentRecord{}, err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, input.AgentID)
	if err != nil {
		return ports.AgentRecord{}, err
	}
	if agent.IdentityRevoked() || agent.OwnerUserID != input.PrincipalID || agent.DesiredState == domain.DesiredDeleted {
		return ports.AgentRecord{}, ports.ErrRunAccessDenied
	}
	if err := validateRunAccess(ctx, tx, agent, ports.AcquireRunRecord{AgentID: input.AgentID,
		PrincipalID: input.PrincipalID, ExpectedAccessRevision: input.ExpectedAccessRevision}); err != nil {
		return ports.AgentRecord{}, err
	}
	return agent, nil
}

func loadAgentAuthorization(ctx context.Context, query catalogQueryer, agentID string) (domain.Authorization, int64, error) {
	var payload []byte
	var revision int64
	if err := query.QueryRow(ctx, `SELECT default_authorization, authorization_revision FROM agent_controller.agents WHERE id = $1`, agentID).Scan(&payload, &revision); err != nil {
		return domain.Authorization{}, 0, fmt.Errorf("read Agent authorization: %w", err)
	}
	var value domain.Authorization
	if err := json.Unmarshal(payload, &value); err != nil {
		return value, 0, fmt.Errorf("decode Agent authorization: %w", err)
	}
	if err := value.Validate(); err != nil {
		return value, 0, err
	}
	return value, revision, nil
}

const sessionModelColumns = `p.id, r.id, p.display_name, r.model->>'model',
    (r.model->>'context_window')::bigint, (r.model->>'max_output_tokens')::bigint,
    (r.model->>'supports_images')::boolean`

func loadDefaultSessionModel(ctx context.Context, query catalogQueryer, organizationID, profileID string) (ports.DefaultSessionModel, error) {
	var model ports.DefaultSessionModel
	err := query.QueryRow(ctx, `SELECT `+sessionModelColumns+`, p.enabled AND c.enabled
FROM agent_controller.model_profile_revisions r
JOIN agent_controller.model_profiles p ON p.id = r.model_profile_id AND p.organization_id = r.organization_id
JOIN agent_controller.provider_connections c ON c.id=p.provider_connection_id AND c.organization_id=p.organization_id
WHERE p.id = $1 AND r.id=p.current_revision_id AND r.organization_id = $2`, profileID, organizationID).Scan(
		&model.ModelProfileID, &model.RevisionID, &model.DisplayName, &model.Model,
		&model.ContextWindow, &model.MaxOutputTokens, &model.SupportsImages, &model.Available)
	if err != nil {
		return model, fmt.Errorf("read default Session model: %w", err)
	}
	return model, nil
}

func listSessionModels(ctx context.Context, tx *databaseTransaction, organizationID string, input ports.SessionConfigurationQuery) ([]ports.SessionModelOption, string, error) {
	rows, err := tx.Query(ctx, `SELECT `+sessionModelColumns+`
FROM agent_controller.model_profiles p
JOIN agent_controller.model_profile_revisions r ON r.id = p.current_revision_id AND r.organization_id = p.organization_id
JOIN agent_controller.provider_connections c ON c.id=p.provider_connection_id AND c.organization_id=p.organization_id
WHERE p.organization_id = $1 AND p.enabled AND c.enabled AND p.id > $2 ORDER BY p.id LIMIT $3`, organizationID, input.AfterID, input.Limit+1)
	if err != nil {
		return nil, "", fmt.Errorf("list Session models: %w", err)
	}
	defer rows.Close()
	models := make([]ports.SessionModelOption, 0)
	for rows.Next() {
		var model ports.SessionModelOption
		if err := rows.Scan(&model.ModelProfileID, &model.RevisionID, &model.DisplayName, &model.Model,
			&model.ContextWindow, &model.MaxOutputTokens, &model.SupportsImages); err != nil {
			return nil, "", err
		}
		models = append(models, model)
	}
	if err := rows.Err(); err != nil {
		return nil, "", err
	}
	if len(models) > input.Limit {
		return models[:input.Limit], models[input.Limit-1].ModelProfileID, nil
	}
	return models, "", nil
}

func (repository *Repository) SetAgentAuthorization(ctx context.Context, input ports.SetAgentAuthorization) (int64, error) {
	if input.ExpectedRevision < 1 || input.EventID == "" || input.Now.IsZero() {
		return 0, fmt.Errorf("invalid authorization update")
	}
	if err := input.Authorization.Validate(); err != nil {
		return 0, err
	}
	if len(input.Authorization.ToolRules) > 128 {
		return 0, fmt.Errorf("too many default tool authorization rules")
	}
	payload, err := json.Marshal(input.Authorization)
	if err != nil {
		return 0, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin authorization update: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	agent, err := lockSessionConfigurationAgent(ctx, tx, input.Query)
	if err != nil {
		return 0, err
	}
	var revision int64
	err = tx.QueryRow(ctx, `UPDATE agent_controller.agents
SET default_authorization = $2, authorization_revision = authorization_revision + 1,
    aggregate_sequence = aggregate_sequence + 1, updated_at = $3
WHERE id = $1 AND authorization_revision = $4 RETURNING authorization_revision`,
		agent.AgentID, payload, input.Now, input.ExpectedRevision).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, ports.ErrConcurrentChange
	}
	if err != nil {
		return 0, fmt.Errorf("update Agent authorization: %w", err)
	}
	if err := repository.insertAgentEvent(ctx, tx, ports.AgentEventRecord{
		EventID: input.EventID, AgentID: agent.AgentID, AggregateSequence: agent.AggregateSequence + 1,
		SchemaVersion: 1, EventType: ports.EventAgentAuthorizationUpdated, TraceID: input.TraceID, OccurredAt: input.Now,
		Data: map[string]any{"authorization_revision": revision, "actor_principal_id": input.Query.PrincipalID},
	}); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit authorization update: %w", err)
	}
	repository.recordEventAppend(ctx, ports.EventAgentAuthorizationUpdated)
	return revision, nil
}
