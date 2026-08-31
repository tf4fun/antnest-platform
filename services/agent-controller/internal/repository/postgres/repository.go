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

type Repository struct{ pool *pgxpool.Pool }

func Open(ctx context.Context, databaseURL string) (*Repository, error) {
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
	return &Repository{pool: pool}, nil
}

func (repository *Repository) Close() {
	if repository != nil && repository.pool != nil {
		repository.pool.Close()
	}
}

func (repository *Repository) Ping(ctx context.Context) error {
	return repository.pool.Ping(ctx)
}

func (repository *Repository) PutModelProfile(ctx context.Context, record ports.ModelProfileRecord) (ports.ModelProfileRecord, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("begin ModelProfile transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	replayed, found, err := loadModelProfileRequest(ctx, transaction, record.RequestID, record.RequestFingerprint)
	if err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if found {
		return replayed, nil
	}
	if err := insertModelProfile(ctx, transaction, record); err != nil {
		return ports.ModelProfileRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.ModelProfileRecord{}, fmt.Errorf("commit ModelProfile transaction: %w", err)
	}
	return record, nil
}

func (repository *Repository) GetModelProfileRevision(ctx context.Context, id string) (domain.ModelProfileRevision, error) {
	var snapshot domain.ModelProfileRevisionSnapshot
	var modelPayload []byte
	err := repository.pool.QueryRow(ctx, `
SELECT id, model_profile_id, organization_id, revision, model,
       credential_ref, credential_version
FROM agent_controller.model_profile_revisions
WHERE id = $1`, id).Scan(
		&snapshot.ID, &snapshot.ModelProfileID, &snapshot.OrganizationID,
		&snapshot.Revision, &modelPayload, &snapshot.CredentialRef,
		&snapshot.CredentialVersion,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.ModelProfileRevision{}, ports.ErrNotFound
	}
	if err != nil {
		return domain.ModelProfileRevision{}, fmt.Errorf("query ModelProfile revision: %w", err)
	}
	if err := json.Unmarshal(modelPayload, &snapshot.Model); err != nil {
		return domain.ModelProfileRevision{}, fmt.Errorf("decode ModelProfile revision: %w", err)
	}
	return domain.NewModelProfileRevision(domain.ModelProfileRevisionInput(snapshot))
}

func (repository *Repository) PutTemplate(ctx context.Context, record ports.TemplateRecord) (ports.TemplateRecord, error) {
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("begin Template transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	replayed, found, err := loadTemplateRequest(ctx, transaction, record.RequestID, record.RequestFingerprint)
	if err != nil {
		return ports.TemplateRecord{}, err
	}
	if found {
		return replayed, nil
	}
	if err := insertTemplate(ctx, transaction, record); err != nil {
		return ports.TemplateRecord{}, err
	}
	if err := transaction.Commit(ctx); err != nil {
		return ports.TemplateRecord{}, fmt.Errorf("commit Template transaction: %w", err)
	}
	return record, nil
}
