package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type EventAppendObserver func(context.Context, string)

type Option func(*Repository)

func WithEventAppendObserver(observer EventAppendObserver) Option {
	return func(repository *Repository) { repository.eventAppended = observer }
}

type Repository struct {
	pool          *pgxpool.Pool
	eventAppended EventAppendObserver
}

const catalogRequestLockNamespace int32 = 0x414e544e

func Open(ctx context.Context, databaseURL string, options ...Option) (*Repository, error) {
	configuration, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Agent Controller database URL: %w", err)
	}
	configuration.ConnConfig.RuntimeParams["search_path"] = "agent_controller,public"
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		return nil, fmt.Errorf("open Agent Controller database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping Agent Controller database: %w", err)
	}
	repository := &Repository{pool: pool}
	for _, option := range options {
		if option != nil {
			option(repository)
		}
	}
	return repository, nil
}

func (repository *Repository) Close() {
	if repository != nil && repository.pool != nil {
		repository.pool.Close()
	}
}

func (repository *Repository) Ping(ctx context.Context) error {
	return repository.pool.Ping(ctx)
}

func (repository *Repository) ReplayModelProfileRequest(
	ctx context.Context,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
) (ports.ModelProfileRecord, bool, error) {
	return loadModelProfileRequest(ctx, repository.pool, kind, requestID, fingerprint)
}

func (repository *Repository) PutModelProfile(
	ctx context.Context, record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	return repository.persistModelProfile(ctx, ports.CreateModelProfileRequest, 0, record)
}

func (repository *Repository) ReviseModelProfile(
	ctx context.Context, expectedRevision int64, record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	return repository.persistModelProfile(ctx, ports.ReviseModelProfileRequest, expectedRevision, record)
}

func (repository *Repository) persistModelProfile(
	ctx context.Context,
	kind ports.CatalogRequestKind,
	expectedRevision int64,
	record ports.ModelProfileRecord,
) (ports.ModelProfileRecord, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("begin ModelProfile transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockCatalogRequest(ctx, transaction, record.RequestID); err != nil {
		return ports.ModelProfileRecord{}, err
	}
	replayed, found, err := loadModelProfileRequest(
		ctx, transaction, kind, record.RequestID, record.RequestFingerprint,
	)
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if found {
		return replayed, nil
	}
	if kind == ports.CreateModelProfileRequest {
		err = insertModelProfile(ctx, transaction, record)
	} else {
		err = reviseModelProfile(ctx, transaction, expectedRevision, record)
	}
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if err := insertCatalogRequest(
		ctx, transaction, kind, record.RequestID, record.RequestFingerprint,
		record.ModelProfileID, record.Revision.ID(), record.Revision.Revision(), record.UpdatedAt,
	); err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("commit ModelProfile transaction: %w", err)
	}
	return record, nil
}

func (repository *Repository) GetModelProfile(
	ctx context.Context, id string,
) (ports.ModelProfileRecord, error) {
	row := repository.pool.QueryRow(ctx, `
SELECT p.id, p.organization_id, p.profile_key, p.display_name,
       p.enabled, p.created_at, p.updated_at,
       r.id, r.revision, r.model, r.credential_ref, r.credential_version
FROM agent_controller.model_profiles p
JOIN agent_controller.model_profile_revisions r
  ON r.id = p.current_revision_id
 AND r.model_profile_id = p.id
 AND r.organization_id = p.organization_id
 AND r.revision = p.current_revision
JOIN agent_controller.provider_credentials c
  ON c.credential_ref = r.credential_ref
 AND c.organization_id = r.organization_id
 AND c.credential_version = r.credential_version
WHERE p.id = $1`, id)
	return scanModelProfileRecord(row)
}

func (repository *Repository) GetModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error) {
	var snapshot domain.ModelProfileRevisionSnapshot
	var modelPayload []byte
	var enabled bool
	err := repository.pool.QueryRow(ctx, `
SELECT r.id, r.model_profile_id, r.organization_id, r.revision, r.model,
       r.credential_ref, r.credential_version, p.enabled
FROM agent_controller.model_profile_revisions r
JOIN agent_controller.model_profiles p
  ON p.id = r.model_profile_id
 AND p.organization_id = r.organization_id
WHERE r.id = $1`, id).Scan(
		&snapshot.ID, &snapshot.ModelProfileID, &snapshot.OrganizationID,
		&snapshot.Revision, &modelPayload, &snapshot.CredentialRef,
		&snapshot.CredentialVersion, &enabled,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ModelProfileRevision{}, ports.ErrNotFound
	}
	if err != nil {
		return domain.ModelProfileRevision{}, fmt.Errorf("query ModelProfile revision: %w", err)
	}
	if !enabled {
		return domain.ModelProfileRevision{}, ports.ErrDisabledReference
	}
	if err := json.Unmarshal(modelPayload, &snapshot.Model); err != nil {
		return domain.ModelProfileRevision{}, fmt.Errorf("decode ModelProfile revision: %w", err)
	}
	return domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
}

func (repository *Repository) ListModelProfiles(
	ctx context.Context,
	organizationID string,
	afterID string,
	limit int,
) ([]ports.ModelProfileRecord, string, error) {
	rows, err := repository.pool.Query(ctx, `
SELECT p.id, p.organization_id, p.profile_key, p.display_name,
       p.enabled, p.created_at, p.updated_at,
       r.id, r.revision, r.model, r.credential_ref, r.credential_version
FROM agent_controller.model_profiles p
JOIN agent_controller.model_profile_revisions r
  ON r.id = p.current_revision_id
 AND r.model_profile_id = p.id
 AND r.organization_id = p.organization_id
 AND r.revision = p.current_revision
JOIN agent_controller.provider_credentials c
  ON c.credential_ref = r.credential_ref
 AND c.organization_id = r.organization_id
 AND c.credential_version = r.credential_version
WHERE p.organization_id = $1
  AND ($2 = '' OR p.id > $2)
ORDER BY p.id
LIMIT $3`, organizationID, afterID, limit+1)
	if err != nil {
		return nil, "", fmt.Errorf("query ModelProfiles: %w", err)
	}
	defer rows.Close()
	records := make([]ports.ModelProfileRecord, 0, limit+1)
	for rows.Next() {
		record, scanErr := scanModelProfileRecord(rows)
		if scanErr != nil {
			return nil, "", scanErr
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("iterate ModelProfiles: %w", err)
	}
	return modelProfilePage(records, limit)
}

func modelProfilePage(
	records []ports.ModelProfileRecord, limit int,
) ([]ports.ModelProfileRecord, string, error) {
	if len(records) <= limit {
		return records, "", nil
	}
	records = records[:limit]
	return records, records[len(records)-1].ModelProfileID, nil
}

func (repository *Repository) ReplayTemplateRequest(
	ctx context.Context,
	kind ports.CatalogRequestKind,
	requestID string,
	fingerprint string,
) (ports.TemplateRecord, bool, error) {
	return loadTemplateRequest(ctx, repository.pool, kind, requestID, fingerprint)
}

func (repository *Repository) PutTemplate(
	ctx context.Context, record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	return repository.persistTemplate(ctx, ports.CreateTemplateRequest, 0, record)
}

func (repository *Repository) ReviseTemplate(
	ctx context.Context, expectedRevision int64, record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	return repository.persistTemplate(ctx, ports.ReviseTemplateRequest, expectedRevision, record)
}

func (repository *Repository) persistTemplate(
	ctx context.Context,
	kind ports.CatalogRequestKind,
	expectedRevision int64,
	record ports.TemplateRecord,
) (ports.TemplateRecord, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("begin Template transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if err := lockCatalogRequest(ctx, transaction, record.RequestID); err != nil {
		return ports.TemplateRecord{}, err
	}
	replayed, found, err := loadTemplateRequest(
		ctx, transaction, kind, record.RequestID, record.RequestFingerprint,
	)
	if err != nil {
		return ports.TemplateRecord{}, err
	}
	if found {
		return replayed, nil
	}
	if kind == ports.CreateTemplateRequest {
		err = insertTemplate(ctx, transaction, record)
	} else {
		err = reviseTemplate(ctx, transaction, expectedRevision, record)
	}
	if err != nil {
		return ports.TemplateRecord{}, err
	}
	if err := insertCatalogRequest(
		ctx, transaction, kind, record.RequestID, record.RequestFingerprint,
		record.TemplateID, "", record.Revision.Revision(), record.UpdatedAt,
	); err != nil {
		return ports.TemplateRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("commit Template transaction: %w", err)
	}
	return record, nil
}

func (repository *Repository) GetTemplate(
	ctx context.Context, id string,
) (ports.TemplateRecord, error) {
	row := repository.pool.QueryRow(ctx, `
SELECT t.id, t.organization_id, t.template_key, t.name,
       t.enabled, t.created_at, t.updated_at,
       r.revision, r.model_profile_revision_id, r.system_prompt,
       r.max_model_requests, r.context_policy_version, r.runtime_input
FROM agent_controller.agent_templates t
JOIN agent_controller.agent_template_revisions r
  ON r.template_id = t.id
 AND r.organization_id = t.organization_id
 AND r.revision = t.current_revision
WHERE t.id = $1`, id)
	return scanTemplateRecord(row)
}

func (repository *Repository) GetTemplateRevision(
	ctx context.Context, id string, revision int64,
) (domain.TemplateRevision, error) {
	record, err := loadTemplateRecord(ctx, repository.pool, id, revision)
	if err != nil {
		return domain.TemplateRevision{}, err
	}
	if !record.Enabled {
		return domain.TemplateRevision{}, ports.ErrDisabledReference
	}
	return record.Revision, nil
}

func (repository *Repository) ListTemplates(
	ctx context.Context,
	organizationID string,
	afterID string,
	limit int,
) ([]ports.TemplateRecord, string, error) {
	rows, err := repository.pool.Query(ctx, `
SELECT t.id, t.organization_id, t.template_key, t.name,
       t.enabled, t.created_at, t.updated_at,
       r.revision, r.model_profile_revision_id, r.system_prompt,
       r.max_model_requests, r.context_policy_version, r.runtime_input
FROM agent_controller.agent_templates t
JOIN agent_controller.agent_template_revisions r
  ON r.template_id = t.id
 AND r.organization_id = t.organization_id
 AND r.revision = t.current_revision
WHERE t.organization_id = $1
  AND ($2 = '' OR t.id > $2)
ORDER BY t.id
LIMIT $3`, organizationID, afterID, limit+1)
	if err != nil {
		return nil, "", fmt.Errorf("query Templates: %w", err)
	}
	defer rows.Close()
	records := make([]ports.TemplateRecord, 0, limit+1)
	for rows.Next() {
		record, scanErr := scanTemplateRecord(rows)
		if scanErr != nil {
			return nil, "", scanErr
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("iterate Templates: %w", err)
	}
	if len(records) <= limit {
		return records, "", nil
	}
	records = records[:limit]
	return records, records[len(records)-1].TemplateID, nil
}
