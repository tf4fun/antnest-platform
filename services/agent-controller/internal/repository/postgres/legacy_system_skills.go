package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) LegacySystemSkillsMigrationRequired(ctx context.Context, agentID string) (bool, error) {
	var state string
	err := repository.pool.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1`, agentID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("read legacy system Skills migration gate: %w", err)
	}
	return state == "pending", nil
}

func (repository *Repository) GetLegacySkillMigration(ctx context.Context, organizationID, agentID string) (ports.LegacySkillMigrationRecord, error) {
	var record ports.LegacySkillMigrationRecord
	err := repository.pool.QueryRow(ctx, `SELECT agent_id,organization_id,state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2`, agentID, organizationID).Scan(&record.AgentID, &record.OrganizationID, &record.State)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacySkillMigrationRecord{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.LegacySkillMigrationRecord{}, fmt.Errorf("read legacy Skill migration: %w", err)
	}
	choice, err := loadLatestLegacySkillChoice(ctx, repository.pool, agentID)
	if err != nil {
		return ports.LegacySkillMigrationRecord{}, err
	}
	record.LatestChoice = choice
	return record, nil
}

func (repository *Repository) ReplayLegacySkillChoice(ctx context.Context, requestID, fingerprint, organizationID, agentID string) (ports.LegacySkillChoice, bool, error) {
	choice, err := loadLegacySkillChoice(ctx, repository.pool, requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacySkillChoice{}, false, nil
	}
	if err != nil {
		return ports.LegacySkillChoice{}, false, err
	}
	if choice.Fingerprint != fingerprint || choice.AgentID != agentID || choice.OrganizationID != organizationID {
		return ports.LegacySkillChoice{}, false, ports.ErrRequestConflict
	}
	return choice, true, nil
}

func (repository *Repository) RecordLegacySkillChoice(ctx context.Context, input ports.LegacySkillChoice) (ports.LegacySkillChoice, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.LegacySkillChoice{}, err
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if existing, err := loadLegacySkillChoice(ctx, transaction, input.RequestID); err == nil {
		if existing.AgentID != input.AgentID || existing.OrganizationID != input.OrganizationID || existing.Fingerprint != input.Fingerprint {
			return ports.LegacySkillChoice{}, ports.ErrRequestConflict
		}
		return existing, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacySkillChoice{}, err
	}
	var organizationID, lifecycle, activeOperation string
	err = transaction.QueryRow(ctx, `SELECT organization_id,lifecycle_state,active_operation_request_id FROM agent_controller.agents WHERE id=$1 FOR UPDATE`, input.AgentID).Scan(&organizationID, &lifecycle, &activeOperation)
	if errors.Is(err, pgx.ErrNoRows) || err == nil && organizationID != input.OrganizationID {
		return ports.LegacySkillChoice{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.LegacySkillChoice{}, err
	}
	if lifecycle == "deleted" || activeOperation != "" {
		return ports.LegacySkillChoice{}, ports.ErrConcurrentChange
	}
	var state string
	err = transaction.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2 FOR UPDATE`, input.AgentID, input.OrganizationID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacySkillChoice{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.LegacySkillChoice{}, err
	}
	if state != "pending" {
		return ports.LegacySkillChoice{}, ports.ErrConcurrentChange
	}
	if existing, err := loadLegacySkillChoice(ctx, transaction, input.RequestID); err == nil {
		if existing.AgentID != input.AgentID || existing.OrganizationID != input.OrganizationID || existing.Fingerprint != input.Fingerprint {
			return ports.LegacySkillChoice{}, ports.ErrRequestConflict
		}
		return existing, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return ports.LegacySkillChoice{}, err
	}
	var next int64
	if err := transaction.QueryRow(ctx, `SELECT COALESCE(MAX(sequence),0)+1 FROM agent_controller.legacy_system_skill_choices WHERE agent_id=$1`, input.AgentID).Scan(&next); err != nil {
		return ports.LegacySkillChoice{}, err
	}
	input.Sequence = next
	input.CreatedAt = input.CreatedAt.UTC().Truncate(time.Microsecond)
	_, err = transaction.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skill_choices
	(request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,sequence,kind,volume_name,inventory_digest,backup_ref,backup_digest,template_id,template_revision,created_at)
	VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
		input.RequestID, input.Fingerprint, input.AgentID, input.OrganizationID, input.ActorPrincipalID, input.Sequence, input.Kind,
		input.VolumeName, input.InventoryDigest, input.BackupRef, input.BackupDigest, input.TemplateID, input.TemplateRevision, input.CreatedAt)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return ports.LegacySkillChoice{}, ports.ErrRequestConflict
		}
		return ports.LegacySkillChoice{}, fmt.Errorf("record legacy Skill choice: %w", err)
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.LegacySkillChoice{}, err
	}
	return input, nil
}

type legacyChoiceQuery interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func loadLegacySkillChoice(ctx context.Context, query legacyChoiceQuery, requestID string) (ports.LegacySkillChoice, error) {
	return scanLegacySkillChoice(query.QueryRow(ctx, `SELECT request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,sequence,kind,volume_name,inventory_digest,backup_ref,backup_digest,template_id,template_revision,created_at FROM agent_controller.legacy_system_skill_choices WHERE request_id=$1`, requestID))
}

func loadLatestLegacySkillChoice(ctx context.Context, query legacyChoiceQuery, agentID string) (*ports.LegacySkillChoice, error) {
	choice, err := scanLegacySkillChoice(query.QueryRow(ctx, `SELECT request_id,request_fingerprint,agent_id,organization_id,actor_principal_id,sequence,kind,volume_name,inventory_digest,backup_ref,backup_digest,template_id,template_revision,created_at FROM agent_controller.legacy_system_skill_choices WHERE agent_id=$1 ORDER BY sequence DESC LIMIT 1`, agentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &choice, nil
}

func scanLegacySkillChoice(row pgx.Row) (ports.LegacySkillChoice, error) {
	var choice ports.LegacySkillChoice
	err := row.Scan(&choice.RequestID, &choice.Fingerprint, &choice.AgentID, &choice.OrganizationID, &choice.ActorPrincipalID,
		&choice.Sequence, &choice.Kind, &choice.VolumeName, &choice.InventoryDigest, &choice.BackupRef, &choice.BackupDigest,
		&choice.TemplateID, &choice.TemplateRevision, &choice.CreatedAt)
	return choice, err
}
