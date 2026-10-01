package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const providerColumns = `id, organization_id, provider_key, display_name, base_url,
credential_method, current_credential_version, credential_revision, enabled, created_at, updated_at`

func scanProvider(scanner catalogRowScanner) (ports.ProviderConnectionRecord, error) {
	var record ports.ProviderConnectionRecord
	err := scanner.Scan(&record.ConnectionID, &record.OrganizationID, &record.ProviderKey, &record.DisplayName, &record.BaseURL,
		&record.CredentialMethod, &record.CredentialVersion, &record.CredentialRevision, &record.Enabled, &record.CreatedAt, &record.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return record, ports.ErrNotFound
	}
	if err != nil {
		return record, fmt.Errorf("scan Provider connection: %w", err)
	}
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	return record, nil
}

func (repository *Repository) GetProviderConnection(ctx context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	return scanProvider(repository.pool.QueryRow(ctx, `SELECT `+providerColumns+`
FROM agent_controller.provider_connections WHERE organization_id=$1 AND id=$2`, organizationID, connectionID))
}

func (repository *Repository) GetProviderAccess(ctx context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	var record ports.ProviderConnectionRecord
	err := repository.pool.QueryRow(ctx, `SELECT `+providerColumns+`, ciphertext, nonce, key_version
FROM agent_controller.provider_connections WHERE organization_id=$1 AND id=$2`, organizationID, connectionID).Scan(
		&record.ConnectionID, &record.OrganizationID, &record.ProviderKey, &record.DisplayName, &record.BaseURL,
		&record.CredentialMethod, &record.CredentialVersion, &record.CredentialRevision, &record.Enabled, &record.CreatedAt, &record.UpdatedAt,
		&record.SealedCredential.Ciphertext, &record.SealedCredential.Nonce, &record.SealedCredential.KeyVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return record, ports.ErrNotFound
	}
	if err != nil {
		return record, fmt.Errorf("read Provider access: %w", err)
	}
	record.CreatedAt, record.UpdatedAt = record.CreatedAt.UTC(), record.UpdatedAt.UTC()
	return record, nil
}

func (repository *Repository) ListProviderConnections(ctx context.Context, organizationID, afterID string, limit int) ([]ports.ProviderConnectionRecord, string, error) {
	rows, err := repository.pool.Query(ctx, `SELECT `+providerColumns+`
FROM agent_controller.provider_connections WHERE organization_id=$1 AND ($2='' OR id>$2) ORDER BY id LIMIT $3`, organizationID, afterID, limit+1)
	if err != nil {
		return nil, "", fmt.Errorf("list Provider connections: %w", err)
	}
	defer rows.Close()
	items := make([]ports.ProviderConnectionRecord, 0, limit+1)
	for rows.Next() {
		item, scanErr := scanProvider(rows)
		if scanErr != nil {
			return nil, "", scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, "", fmt.Errorf("read Provider connections: %w", err)
	}
	if len(items) > limit {
		return items[:limit], items[limit-1].ConnectionID, nil
	}
	return items, "", nil
}

func (repository *Repository) ReplayProviderRequest(ctx context.Context, kind ports.CatalogRequestKind, requestID, fingerprint string) (ports.ProviderConnectionRecord, bool, error) {
	return loadProviderRequest(ctx, repository.pool, kind, requestID, fingerprint)
}

func loadProviderRequest(ctx context.Context, queryer catalogQueryer, kind ports.CatalogRequestKind, requestID, fingerprint string) (ports.ProviderConnectionRecord, bool, error) {
	receipt, found, err := loadCatalogRequest(ctx, queryer, kind, requestID, fingerprint)
	if err != nil || !found {
		return ports.ProviderConnectionRecord{}, found, err
	}
	record, err := scanProvider(queryer.QueryRow(ctx, `SELECT `+providerColumns+`
FROM agent_controller.provider_connections WHERE id=$1`, receipt.resourceID))
	if err != nil {
		return record, true, err
	}
	// Command replay describes that command's credential version, not a later rotation.
	record.CredentialVersion, record.CredentialRevision = receipt.revisionID, receipt.revision
	record.UpdatedAt = receipt.createdAt.UTC()
	return record, true, nil
}

func (repository *Repository) PutProviderConnection(ctx context.Context, connection ports.ProviderConnectionRecord, models []ports.ModelProfileRecord) (ports.ProviderConnectionRecord, error) {
	connection.CreatedAt = connection.CreatedAt.UTC().Truncate(time.Microsecond)
	connection.UpdatedAt = connection.UpdatedAt.UTC().Truncate(time.Microsecond)
	return repository.persistProvider(ctx, ports.CreateProviderConnectionRequest, connection, func(tx *databaseTransaction, current *ports.ProviderConnectionRecord) error {
		if err := insertProviderConnection(ctx, tx, *current); err != nil {
			return err
		}
		for _, model := range models {
			if err := insertModelProfile(ctx, tx, model); err != nil {
				return err
			}
		}
		return nil
	})
}

func (repository *Repository) RotateProviderCredential(ctx context.Context, expectedVersion string, connection ports.ProviderConnectionRecord) (ports.ProviderConnectionRecord, error) {
	connection.CreatedAt = connection.CreatedAt.UTC().Truncate(time.Microsecond)
	connection.UpdatedAt = connection.UpdatedAt.UTC().Truncate(time.Microsecond)
	return repository.persistProvider(ctx, ports.RotateProviderCredentialRequest, connection, func(tx *databaseTransaction, current *ports.ProviderConnectionRecord) error {
		err := tx.QueryRow(ctx, `UPDATE agent_controller.provider_connections
SET current_credential_version=$3, credential_revision=credential_revision+1, updated_at=$4,
    ciphertext=$7, nonce=$8, key_version=$9
WHERE id=$1 AND organization_id=$2 AND current_credential_version=$5 AND credential_revision=$6 RETURNING enabled`,
			connection.ConnectionID, connection.OrganizationID, connection.CredentialVersion, connection.UpdatedAt,
			expectedVersion, connection.CredentialRevision-1,
			connection.SealedCredential.Ciphertext, connection.SealedCredential.Nonce, connection.SealedCredential.KeyVersion).Scan(&current.Enabled)
		if errors.Is(err, pgx.ErrNoRows) {
			return ports.ErrConcurrentChange
		}
		if err != nil {
			return fmt.Errorf("rotate Provider credential head: %w", err)
		}
		return nil
	})
}

func (repository *Repository) persistProvider(ctx context.Context, kind ports.CatalogRequestKind, connection ports.ProviderConnectionRecord, write func(*databaseTransaction, *ports.ProviderConnectionRecord) error) (ports.ProviderConnectionRecord, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return ports.ProviderConnectionRecord{}, fmt.Errorf("begin Provider transaction: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err := lockCatalogRequest(ctx, tx, connection.RequestID); err != nil {
		return ports.ProviderConnectionRecord{}, err
	}
	replayed, found, err := loadProviderRequest(ctx, tx, kind, connection.RequestID, connection.RequestFingerprint)
	if err != nil || found {
		return replayed, err
	}
	if err := lockExecutionOrganization(ctx, tx, connection.OrganizationID); err != nil {
		return ports.ProviderConnectionRecord{}, err
	}
	if err := write(tx, &connection); err != nil {
		return ports.ProviderConnectionRecord{}, catalogConflict(err)
	}
	if err := insertCatalogRequest(ctx, tx, kind, connection.RequestID, connection.RequestFingerprint,
		connection.ConnectionID, connection.CredentialVersion, connection.CredentialRevision, connection.UpdatedAt, nil); err != nil {
		return ports.ProviderConnectionRecord{}, err
	}
	if err := repository.advanceExecutionRevision(ctx, tx, connection.OrganizationID); err != nil {
		return ports.ProviderConnectionRecord{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ports.ProviderConnectionRecord{}, fmt.Errorf("commit Provider transaction: %w", err)
	}
	return connection, nil
}

func insertProviderConnection(ctx context.Context, tx *databaseTransaction, record ports.ProviderConnectionRecord) error {
	_, err := tx.Exec(ctx, `INSERT INTO agent_controller.provider_connections (`+providerColumns+`, ciphertext, nonce, key_version)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, record.ConnectionID, record.OrganizationID, record.ProviderKey,
		record.DisplayName, record.BaseURL, record.CredentialMethod, record.CredentialVersion, record.CredentialRevision,
		record.Enabled, record.CreatedAt, record.UpdatedAt,
		record.SealedCredential.Ciphertext, record.SealedCredential.Nonce, record.SealedCredential.KeyVersion)
	if err != nil {
		return fmt.Errorf("insert Provider connection: %w", err)
	}
	return nil
}

func catalogConflict(err error) error {
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) && postgresError.Code == "23505" {
		return fmt.Errorf("%w: duplicate catalog identity", ports.ErrRequestConflict)
	}
	return err
}
