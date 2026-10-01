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

func catalogAvailabilityTable(kind ports.CatalogResourceKind) (string, error) {
	switch kind {
	case ports.CatalogProvider:
		return "agent_controller.provider_connections", nil
	case ports.CatalogModel:
		return "agent_controller.model_profiles", nil
	case ports.CatalogTemplate:
		return "agent_controller.agent_templates", nil
	default:
		return "", ports.ErrNotFound
	}
}

func (repository *Repository) SetCatalogAvailability(ctx context.Context, input ports.CatalogAvailabilityChange) (ports.CatalogAvailability, error) {
	table, err := catalogAvailabilityTable(input.Kind)
	if err != nil {
		return ports.CatalogAvailability{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.CatalogAvailability{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockCatalogRequest(ctx, tx, input.RequestID); err != nil {
		return ports.CatalogAvailability{}, err
	}
	receipt, found, err := loadCatalogRequest(ctx, tx, ports.SetCatalogAvailabilityRequest, input.RequestID, input.Fingerprint)
	if err != nil {
		return ports.CatalogAvailability{}, err
	}
	if found {
		var result ports.CatalogAvailability
		err := json.Unmarshal(receipt.response, &result)
		return result, err
	}
	if err := lockExecutionOrganization(ctx, tx, input.OrganizationID); err != nil {
		return ports.CatalogAvailability{}, err
	}
	var current ports.CatalogAvailability
	err = tx.QueryRow(ctx, `SELECT id, enabled, updated_at FROM `+table+` WHERE id=$1 AND organization_id=$2 FOR UPDATE`, input.ResourceID, input.OrganizationID).Scan(&current.ResourceID, &current.Enabled, &current.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return current, ports.ErrNotFound
	}
	if err != nil {
		return current, err
	}
	current.UpdatedAt = current.UpdatedAt.UTC()
	if current.Enabled != input.ExpectedEnabled {
		return current, ports.ErrConcurrentChange
	}
	if current.Enabled != input.Enabled {
		current, err = repository.changeCatalogAvailability(ctx, tx, input, table)
		if err != nil {
			return ports.CatalogAvailability{}, err
		}
	}
	payload, err := json.Marshal(current)
	if err != nil {
		return ports.CatalogAvailability{}, err
	}
	if err := insertCatalogRequest(ctx, tx, ports.SetCatalogAvailabilityRequest, input.RequestID, input.Fingerprint,
		input.ResourceID, "", 1, input.Now, payload); err != nil {
		return ports.CatalogAvailability{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.CatalogAvailability{}, err
	}
	return current, nil
}

func (repository *Repository) changeCatalogAvailability(ctx context.Context, tx *databaseTransaction, input ports.CatalogAvailabilityChange, table string) (ports.CatalogAvailability, error) {
	if input.Enabled {
		if err := validateCatalogEnable(ctx, tx, input); err != nil {
			return ports.CatalogAvailability{}, err
		}
	} else if input.Kind == ports.CatalogModel {
		if err := requireUnreferencedCatalogResource(ctx, tx, input); err != nil {
			return ports.CatalogAvailability{}, err
		}
	}
	var result ports.CatalogAvailability
	err := tx.QueryRow(ctx, `UPDATE `+table+` SET enabled=$3, updated_at=$4 WHERE id=$1 AND organization_id=$2 RETURNING id, enabled, updated_at`, input.ResourceID, input.OrganizationID, input.Enabled, input.Now).Scan(&result.ResourceID, &result.Enabled, &result.UpdatedAt)
	if err != nil {
		return result, err
	}
	result.UpdatedAt = result.UpdatedAt.UTC()
	if input.Kind != ports.CatalogTemplate {
		if err := repository.advanceExecutionRevision(ctx, tx, input.OrganizationID); err != nil {
			return ports.CatalogAvailability{}, err
		}
	}
	return result, nil
}

func validateCatalogEnable(ctx context.Context, tx *databaseTransaction, input ports.CatalogAvailabilityChange) error {
	switch input.Kind {
	case ports.CatalogProvider:
		return nil
	case ports.CatalogModel:
		var enabled bool
		err := tx.QueryRow(ctx, `SELECT c.enabled FROM agent_controller.model_profiles m
JOIN agent_controller.provider_connections c ON c.id=m.provider_connection_id AND c.organization_id=m.organization_id
WHERE m.id=$1 AND m.organization_id=$2`, input.ResourceID, input.OrganizationID).Scan(&enabled)
		return requireEnabledCatalogDependency(enabled, err)
	case ports.CatalogTemplate:
		var model string
		err := tx.QueryRow(ctx, `SELECT r.model_profile_id FROM agent_controller.agent_templates t
JOIN agent_controller.agent_template_revisions r ON r.template_id=t.id AND r.organization_id=t.organization_id AND r.revision=t.current_revision
WHERE t.id=$1 AND t.organization_id=$2`, input.ResourceID, input.OrganizationID).Scan(&model)
		if err != nil {
			return err
		}
		return requireEnabledModel(ctx, tx, input.OrganizationID, model)
	default:
		return ports.ErrNotFound
	}
}

func requireEnabledCatalogDependency(enabled bool, err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("read catalog dependency: %w", err)
	}
	if !enabled {
		return ports.ErrDisabledReference
	}
	return nil
}

func requireEnabledModel(ctx context.Context, tx *databaseTransaction, organization, model string) error {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT m.enabled FROM agent_controller.model_profiles m
JOIN agent_controller.provider_connections c ON c.id=m.provider_connection_id AND c.organization_id=m.organization_id
WHERE m.id=$1 AND m.organization_id=$2`, model, organization).Scan(&enabled)
	return requireEnabledCatalogDependency(enabled, err)
}

// The caller holds the organization lock shared with catalog retirement.
// Historical template revisions may be used only while their template is enabled.
func requireEnabledTemplateSpec(ctx context.Context, tx *databaseTransaction, organization string, spec domain.AgentSpecSnapshot) error {
	var enabled bool
	err := tx.QueryRow(ctx, `SELECT t.enabled AND m.enabled
FROM agent_controller.agent_templates t
JOIN agent_controller.agent_template_revisions r ON r.template_id=t.id AND r.organization_id=t.organization_id AND r.revision=$3
JOIN agent_controller.model_profiles m ON m.id=r.model_profile_id AND m.organization_id=t.organization_id
JOIN agent_controller.provider_connections c ON c.id=m.provider_connection_id AND c.organization_id=m.organization_id
WHERE t.id=$1 AND t.organization_id=$2 AND m.id=$4`, spec.TemplateID, organization, spec.TemplateRevision, spec.ModelProfileID).Scan(&enabled)
	return requireEnabledCatalogDependency(enabled, err)
}

func requireUnreferencedCatalogResource(ctx context.Context, tx *databaseTransaction, input ports.CatalogAvailabilityChange) error {
	rows, err := tx.Query(ctx, catalogReferencesQuery, input.OrganizationID, input.ResourceID, input.Kind)
	if err != nil {
		return fmt.Errorf("read catalog references: %w", err)
	}
	references, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ports.CatalogReference, error) {
		var reference ports.CatalogReference
		err := row.Scan(&reference.Kind, &reference.ResourceID, &reference.AgentID, &reference.OperationID)
		return reference, err
	})
	if err != nil {
		return err
	}
	if len(references) == 0 {
		return nil
	}
	return &ports.CatalogReferenceConflict{References: references[:min(len(references), 100)], Truncated: len(references) > 100}
}

const catalogReferencesQuery = `WITH selected_models AS (
 SELECT id FROM agent_controller.model_profiles
 WHERE organization_id=$1 AND (($3='model' AND id=$2) OR ($3='provider' AND provider_connection_id=$2))
), current_agent_specs AS (
 SELECT a.id AS agent_id, s.snapshot FROM agent_controller.agents a
 LEFT JOIN agent_controller.execution_revisions e ON e.id=a.last_successful_execution_revision_id AND e.agent_id=a.id
 JOIN agent_controller.agent_spec_revisions s ON s.agent_id=a.id AND
 (s.id=a.executable_spec_revision_id OR (a.executable_spec_revision_id='' AND
 ((a.last_successful_execution_revision_id<>'' AND s.id=e.agent_spec_revision_id) OR (a.last_successful_execution_revision_id='' AND s.revision=1))))
 WHERE a.organization_id=$1 AND a.lifecycle_state<>'deleted'
)
SELECT 'template' AS kind, t.id AS resource_id, '' AS agent_id, '' AS operation_id
FROM agent_controller.agent_templates t JOIN agent_controller.agent_template_revisions r
ON r.template_id=t.id AND r.organization_id=t.organization_id AND r.revision=t.current_revision
WHERE t.organization_id=$1 AND t.enabled AND (r.model_profile_id IN (SELECT id FROM selected_models)
 OR r.fallback_model_profile_ids && ARRAY(SELECT id FROM selected_models))
UNION ALL
SELECT 'agent', agent_id, agent_id, '' FROM current_agent_specs WHERE snapshot->>'model_profile_id' IN (SELECT id FROM selected_models)
 OR snapshot->'fallback_model_profile_ids' ?| ARRAY(SELECT id FROM selected_models)
UNION ALL
SELECT 'lifecycle_operation', o.request_id, a.id, o.request_id
FROM agent_controller.agents a JOIN agent_controller.agent_lifecycle_operations o ON o.agent_id=a.id AND o.request_id=a.active_operation_request_id
JOIN agent_controller.agent_spec_revisions s ON s.agent_id=a.id AND s.id=o.target_spec_revision_id
WHERE a.organization_id=$1 AND a.lifecycle_state<>'deleted' AND o.state='running' AND (s.snapshot->>'model_profile_id' IN (SELECT id FROM selected_models)
 OR s.snapshot->'fallback_model_profile_ids' ?| ARRAY(SELECT id FROM selected_models))
ORDER BY kind, resource_id LIMIT 101`
