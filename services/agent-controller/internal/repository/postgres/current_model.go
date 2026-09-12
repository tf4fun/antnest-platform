package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetCurrentModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error) {
	row := repository.pool.QueryRow(ctx, `SELECT p.id, p.organization_id, p.profile_key, p.display_name,
 p.enabled AND c.enabled, p.created_at, p.updated_at, p.configuration_id, p.version,
 p.model || jsonb_build_object('base_url', c.base_url), p.provider_connection_id
 FROM agent_controller.model_profiles p
 JOIN agent_controller.provider_connections c ON c.id=p.provider_connection_id AND c.organization_id=p.organization_id
 WHERE p.id=$1`, id)
	record, err := scanModelProfileRecord(row)
	if err != nil {
		return domain.ModelProfileRevision{}, err
	}
	if !record.Enabled {
		return domain.ModelProfileRevision{}, ports.ErrDisabledReference
	}
	return record.Revision, nil
}

func loadRunProvider(ctx context.Context, query catalogQueryer, organizationID, connectionID string) (domain.ProviderExecution, error) {
	var provider domain.ProviderExecution
	err := query.QueryRow(ctx, `SELECT id, provider_key, credential_method FROM agent_controller.provider_connections
 WHERE id=$1 AND organization_id=$2 AND enabled`, connectionID, organizationID).Scan(&provider.ConnectionID, &provider.ProviderKey, &provider.CredentialMethod)
	if errors.Is(err, pgx.ErrNoRows) {
		return provider, ports.ErrModelUnavailable
	}
	if err != nil {
		return provider, fmt.Errorf("read Run Provider: %w", err)
	}
	support, _ := domain.SupportedProvider(provider.ProviderKey)
	provider.RequestProtocol = support.RequestProtocol
	return provider, provider.Validate()
}

func lockProviderForRun(ctx context.Context, tx *databaseTransaction, organizationID, connectionID string) error {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT enabled FROM agent_controller.provider_connections WHERE id=$1 AND organization_id=$2 FOR SHARE`, connectionID, organizationID).Scan(&enabled)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && !enabled {
		return ports.ErrModelUnavailable
	}
	if err != nil {
		return fmt.Errorf("lock Run Provider: %w", err)
	}
	return nil
}
