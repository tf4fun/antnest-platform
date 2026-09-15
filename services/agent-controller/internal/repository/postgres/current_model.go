package postgres

import (
	"context"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetCurrentModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error) {
	row := repository.pool.QueryRow(ctx, `SELECT p.id, p.organization_id, p.profile_key, p.display_name,
 p.enabled, p.created_at, p.updated_at, p.configuration_id, p.version,
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
