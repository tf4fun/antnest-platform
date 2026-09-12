package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func applyRunConfiguration(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord,
	overrides domain.SessionConfigurationOverrides, snapshot *ports.RunExecutionSnapshot,
) error {
	if err := overrides.Validate(); err != nil {
		return err
	}
	var inheritedModel string
	if err := tx.QueryRow(ctx, `SELECT snapshot->>'model_profile_id' FROM agent_controller.agent_spec_revisions
WHERE id = $1 AND agent_id = $2`, agent.AgentSpecRevisionID, agent.AgentID).Scan(&inheritedModel); err != nil {
		return fmt.Errorf("read inherited model identity: %w", err)
	}
	model, err := lockRunModel(ctx, tx, agent.OrganizationID, inheritedModel, overrides.ModelProfileID)
	if err != nil {
		return err
	}
	defaults, authorizationRevision, err := loadAgentAuthorization(ctx, tx, agent.AgentID)
	if err != nil {
		return err
	}
	authorization, err := domain.ResolveAuthorization(defaults, overrides)
	if err != nil {
		return err
	}
	provider, err := loadRunProvider(ctx, tx, agent.OrganizationID, model.ProviderConnectionID)
	if err != nil {
		return err
	}
	selected := model.Revision.Snapshot()
	digest, err := domain.ExecutionConfigurationDigest(selected, authorization)
	if err != nil {
		return err
	}
	snapshot.ExecutionSpec.Model = selected.Model
	snapshot.ExecutionSpec.Provider = provider
	snapshot.ExecutionSpec.Configuration = &ports.AdmittedConfiguration{
		ModelProfileID: selected.ModelProfileID, ModelProfileRevisionID: selected.ID,
		Authorization: authorization, AuthorizationRevision: authorizationRevision, Digest: digest,
	}
	return nil
}

func lockRunModel(ctx context.Context, tx *databaseTransaction, organizationID, inheritedModel string, selected *string) (ports.ModelProfileRecord, error) {
	profileID := inheritedModel
	if selected != nil {
		profileID = *selected
	}
	// Lock before reading the revision: a joined read can retain a stale head while waiting.
	var connectionID string
	err := tx.QueryRow(ctx, `SELECT p.provider_connection_id
FROM agent_controller.model_profiles p WHERE p.organization_id = $1 AND p.enabled
AND p.id = $2 FOR SHARE OF p`, organizationID, profileID).Scan(&connectionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ModelProfileRecord{}, ports.ErrModelUnavailable
	}
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if err := lockProviderForRun(ctx, tx, organizationID, connectionID); err != nil {
		return ports.ModelProfileRecord{}, err
	}
	record, err := loadModelProfileRecord(ctx, tx, profileID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.ModelProfileRecord{}, ports.ErrModelUnavailable
	}
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	return record, nil
}
