package postgres

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const modelProfileUsageQuery = `WITH scoped_model AS (
 SELECT id FROM agent_controller.model_profiles WHERE organization_id=$1 AND id=$2
), effective_specs AS (
 SELECT a.id AS agent_id,s.snapshot FROM agent_controller.agents a
 LEFT JOIN agent_controller.execution_revisions e ON e.id=a.last_successful_execution_revision_id AND e.agent_id=a.id
 JOIN agent_controller.agent_spec_revisions s ON s.agent_id=a.id AND
 (s.id=a.executable_spec_revision_id OR (a.executable_spec_revision_id='' AND
 ((a.last_successful_execution_revision_id<>'' AND s.id=e.agent_spec_revision_id) OR (a.last_successful_execution_revision_id='' AND s.revision=1))))
 WHERE a.organization_id=$1 AND a.lifecycle_state<>'deleted'
 UNION ALL
 SELECT a.id,s.snapshot FROM agent_controller.agents a
 JOIN agent_controller.agent_lifecycle_operations o ON o.agent_id=a.id AND o.request_id=a.active_operation_request_id
 JOIN agent_controller.agent_spec_revisions s ON s.agent_id=a.id AND s.id=o.target_spec_revision_id
 WHERE a.organization_id=$1 AND a.lifecycle_state<>'deleted' AND o.state='running'
)
SELECT (SELECT count(DISTINCT t.id) FROM agent_controller.agent_templates t
 JOIN agent_controller.agent_template_revisions r ON r.template_id=t.id AND r.organization_id=t.organization_id AND r.revision=t.current_revision
 WHERE t.organization_id=$1 AND (r.model_profile_id=$2 OR $2=ANY(r.fallback_model_profile_ids))),
 (SELECT count(DISTINCT agent_id) FROM effective_specs WHERE snapshot->>'model_profile_id'=$2 OR snapshot->'fallback_model_profile_ids' ? $2)
FROM scoped_model`

func (repository *Repository) GetModelProfileUsage(
	ctx context.Context, organizationID string, modelID string,
) (ports.ModelProfileUsage, error) {
	var usage ports.ModelProfileUsage
	err := repository.pool.QueryRow(ctx, modelProfileUsageQuery, organizationID, modelID).Scan(&usage.Templates, &usage.Agents)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ModelProfileUsage{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.ModelProfileUsage{}, fmt.Errorf("query ModelProfile usage: %w", err)
	}
	return usage, nil
}

func (repository *Repository) ListModelProfileEvents(
	ctx context.Context, organizationID string, modelID string, afterRevision int64, limit int,
) ([]ports.ModelProfileRevisedEvent, error) {
	var exists int
	err := repository.pool.QueryRow(ctx, `SELECT 1 FROM agent_controller.model_profiles WHERE organization_id=$1 AND id=$2`, organizationID, modelID).Scan(&exists)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ports.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("check ModelProfile scope: %w", err)
	}
	rows, err := repository.pool.Query(ctx, `
SELECT request_id,organization_id,model_profile_id,revision_id,previous_revision,revision,occurred_at
FROM agent_controller.model_profile_events WHERE organization_id=$1 AND model_profile_id=$2 AND revision>$3 ORDER BY revision LIMIT $4`,
		organizationID, modelID, afterRevision, limit+1)
	if err != nil {
		return nil, fmt.Errorf("query ModelProfile events: %w", err)
	}
	defer rows.Close()
	events := make([]ports.ModelProfileRevisedEvent, 0, limit+1)
	for rows.Next() {
		var event ports.ModelProfileRevisedEvent
		if err := rows.Scan(
			&event.RequestID, &event.OrganizationID, &event.ModelProfileID, &event.RevisionID,
			&event.PreviousRevision, &event.Revision, &event.OccurredAt,
		); err != nil {
			return nil, fmt.Errorf("scan ModelProfile event: %w", err)
		}
		event.EventType = ports.EventModelProfileRevised
		event.OccurredAt = event.OccurredAt.UTC()
		events = append(events, event)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ModelProfile events: %w", err)
	}
	return events, nil
}

func insertModelProfileEvent(
	ctx context.Context, transaction *databaseTransaction, previousRevision int64, record ports.ModelProfileRecord,
) error {
	if _, err := transaction.Exec(ctx, `
INSERT INTO agent_controller.model_profile_events (
    organization_id, model_profile_id, revision, previous_revision, revision_id, request_id, occurred_at
) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		record.OrganizationID, record.ModelProfileID, record.Revision.Revision(), previousRevision,
		record.Revision.ID(), record.RequestID, record.UpdatedAt,
	); err != nil {
		return fmt.Errorf("insert ModelProfile event: %w", err)
	}
	return nil
}
