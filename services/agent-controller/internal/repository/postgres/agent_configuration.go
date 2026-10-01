package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) SetAgentAuthorization(ctx context.Context, input ports.SetAgentAuthorization) (int64, error) {
	if input.OrganizationID == "" || input.ExpectedRevision < 1 || input.EventID == "" || input.Now.IsZero() || input.OwnerRevocationSequence < 0 {
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
	if err := lockIdentityAdmission(ctx, tx); err != nil {
		return 0, err
	}
	if err := lockAgentExecutionConfiguration(ctx, tx, input.Query.AgentID); err != nil {
		return 0, err
	}
	agent, err := lockAgentConfigurationOwner(ctx, tx, input)
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
	if err := repository.advanceExecutionRevision(ctx, tx, agent.OrganizationID); err != nil {
		return 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit authorization update: %w", err)
	}
	repository.recordEventAppend(ctx, ports.EventAgentAuthorizationUpdated)
	return revision, nil
}

func lockAgentConfigurationOwner(ctx context.Context, tx *databaseTransaction, input ports.SetAgentAuthorization) (ports.AgentRecord, error) {
	scope := input.Query
	agent, err := loadAgentRecordForUpdate(ctx, tx, scope.AgentID)
	if err != nil {
		return ports.AgentRecord{}, err
	}
	if agent.IdentityRevoked() || agent.OwnerUserID != scope.PrincipalID || agent.OrganizationID != input.OrganizationID ||
		agent.DesiredState == domain.DesiredDeleted || agent.AccessRevision != scope.ExpectedAccessRevision ||
		agent.OwnerAuthorizationSequence != input.OwnerRevocationSequence {
		return ports.AgentRecord{}, ports.ErrAgentAccessDenied
	}
	if err := validateOwnerWatermark(ctx, tx, scope.PrincipalID, input.OrganizationID, input.OwnerRevocationSequence); err != nil {
		if errors.Is(err, ports.ErrConcurrentChange) {
			return ports.AgentRecord{}, ports.ErrAgentAccessDenied
		}
		return ports.AgentRecord{}, err
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT active FROM agent_controller.agent_access_bindings
 WHERE agent_id = $1 AND principal_id = $2 AND access_revision = $3
 FOR UPDATE`,
		scope.AgentID, scope.PrincipalID, scope.ExpectedAccessRevision).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !active {
		return ports.AgentRecord{}, ports.ErrAgentAccessDenied
	}
	if err != nil {
		return ports.AgentRecord{}, fmt.Errorf("check Agent configuration access: %w", err)
	}
	return agent, nil
}
