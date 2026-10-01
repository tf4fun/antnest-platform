package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type EventAppendObserver func(context.Context, string)

type Option func(*Repository)

func WithEventAppendObserver(observer EventAppendObserver) Option {
	return func(repository *Repository) { repository.eventAppended = observer }
}

type Repository struct {
	pool              *databasePool
	eventAppended     EventAppendObserver
	executionCapacity ports.ExecutionCapacityGuard
	executionChanged  func(context.Context, string)
}

const catalogRequestLockNamespace int32 = 0x414e544e

func Open(ctx context.Context, databaseURL string, options ...Option) (*Repository, error) {
	configuration, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse Agent Controller database URL: %w", err)
	}
	configuration.ConnConfig.Tracer = newDatabaseTracer()
	configuration.ConnConfig.RuntimeParams["search_path"] = "agent_controller,public"
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	if err != nil {
		return nil, fmt.Errorf("open Agent Controller database: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping Agent Controller database: %w", err)
	}
	repository := &Repository{pool: &databasePool{pool}}
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
	record.CreatedAt = record.CreatedAt.UTC().Truncate(time.Microsecond)
	record.UpdatedAt = record.UpdatedAt.UTC().Truncate(time.Microsecond)
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
	if err := lockExecutionOrganization(ctx, transaction, record.OrganizationID); err != nil {
		return ports.ModelProfileRecord{}, err
	}
	executionChanged := true
	if kind == ports.CreateModelProfileRequest {
		err = insertModelProfile(ctx, transaction, record)
	} else {
		executionChanged, err = reviseModelProfile(ctx, transaction, expectedRevision, &record)
	}
	if err != nil {
		return ports.ModelProfileRecord{}, catalogConflict(err)
	}
	response, err := encodeModelReceipt(record)
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if err := insertCatalogRequest(
		ctx, transaction, kind, record.RequestID, record.RequestFingerprint,
		record.ModelProfileID, record.Revision.ID(), record.Revision.Revision(), record.UpdatedAt, response,
	); err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if executionChanged {
		if err := repository.advanceExecutionRevision(ctx, transaction, record.OrganizationID); err != nil {
			return ports.ModelProfileRecord{}, err
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("commit ModelProfile transaction: %w", err)
	}
	return record, nil
}

func (repository *Repository) GetModelProfile(
	ctx context.Context, id string,
) (ports.ModelProfileRecord, error) {
	return loadModelProfileRecord(ctx, repository.pool, id)
}

func (repository *Repository) ListModelProfiles(
	ctx context.Context,
	organizationID string,
	afterID string,
	limit int,
) ([]ports.ModelProfileRecord, string, error) {
	rows, err := repository.pool.Query(ctx, `SELECT `+modelProfileColumns+modelProfileFrom+`
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
	record.CreatedAt = record.CreatedAt.UTC().Truncate(time.Microsecond)
	record.UpdatedAt = record.UpdatedAt.UTC().Truncate(time.Microsecond)
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
	if err := lockExecutionOrganization(ctx, transaction, record.OrganizationID); err != nil {
		return ports.TemplateRecord{}, err
	}
	if err := validateTemplateModelCandidates(ctx, transaction, record.OrganizationID, record.Revision.Snapshot()); err != nil {
		return ports.TemplateRecord{}, err
	}
	if kind == ports.CreateTemplateRequest {
		err = insertTemplate(ctx, transaction, record)
	} else {
		err = reviseTemplate(ctx, transaction, expectedRevision, &record)
	}
	if err != nil {
		return ports.TemplateRecord{}, err
	}
	if err := insertCatalogRequest(
		ctx, transaction, kind, record.RequestID, record.RequestFingerprint,
		record.TemplateID, "", record.Revision.Revision(), record.UpdatedAt, nil,
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
       r.revision, r.model_profile_id, r.system_prompt,
       r.max_model_requests, r.context_policy_version, r.runtime_input, r.fallback_model_profile_ids, r.skill_refs
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
       r.revision, r.model_profile_id, r.system_prompt,
       r.max_model_requests, r.context_policy_version, r.runtime_input, r.fallback_model_profile_ids, r.skill_refs
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
