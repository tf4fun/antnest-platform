package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var ErrRekeyInProgress = errors.New("encryption rotation is already running")

const rekeyLockID int64 = 0x41544e4553544b43

func (repository *Repository) RekeyProviderCredentials(ctx context.Context, box ports.CredentialRekeyer, batchSize int, progress func(secretencryption.Progress) error) (resultErr error) {
	if batchSize < 1 || batchSize > secretencryption.MaxBatchSize {
		return secretencryption.ErrBatchSize
	}
	if box == nil {
		return secretencryption.ErrConfiguration
	}
	connection, err := repository.pool.Acquire(ctx)
	if err != nil {
		return err
	}
	defer connection.Release()
	var locked bool
	if err := connection.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, rekeyLockID).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return ErrRekeyInProgress
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		var unlocked bool
		err := connection.QueryRow(cleanup, `SELECT pg_advisory_unlock($1)`, rekeyLockID).Scan(&unlocked)
		if err != nil || !unlocked {
			resultErr = errors.Join(resultErr, errors.New("release encryption rotation lock failed"))
			_ = connection.Conn().Close(cleanup)
		}
	}()
	for {
		count, err := rekeyProviderBatch(ctx, connection, box, batchSize)
		if err != nil {
			return err
		}
		var remaining int64
		if err := connection.QueryRow(ctx, `SELECT count(*) FROM agent_controller.provider_connections WHERE key_version<>$1 OR wrapped_data_key IS NULL`, box.ActiveKeyID()).Scan(&remaining); err != nil {
			return err
		}
		if progress != nil {
			if err := progress(secretencryption.Progress{Table: "provider_connections", ActiveKID: box.ActiveKeyID(), Updated: count, Remaining: remaining}); err != nil {
				return err
			}
		}
		if count == 0 && remaining == 0 {
			return nil
		}
	}
}

func rekeyProviderBatch(ctx context.Context, connection *pgxpool.Conn, box ports.CredentialRekeyer, batchSize int) (int64, error) {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	rows, err := tx.Query(ctx, `SELECT id, organization_id, current_credential_version, ciphertext, nonce, key_version, wrapped_data_key
FROM agent_controller.provider_connections WHERE key_version<>$1 OR wrapped_data_key IS NULL ORDER BY id LIMIT $2 FOR UPDATE`, box.ActiveKeyID(), batchSize)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var records []ports.ProviderConnectionRecord
	for rows.Next() {
		var record ports.ProviderConnectionRecord
		if err := rows.Scan(&record.ConnectionID, &record.OrganizationID, &record.CredentialVersion, &record.SealedCredential.Ciphertext, &record.SealedCredential.Nonce, &record.SealedCredential.KeyVersion, &record.SealedCredential.WrappedDataKey); err != nil {
			return 0, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	for _, record := range records {
		identity := ports.CredentialIdentity{OrganizationID: record.OrganizationID, CredentialRef: record.ConnectionID, CredentialVersion: record.CredentialVersion}
		sealed, err := box.Rekey(ctx, identity, record.SealedCredential)
		if err != nil {
			return 0, err
		}
		command, err := tx.Exec(ctx, `UPDATE agent_controller.provider_connections SET ciphertext=$2, nonce=$3, key_version=$4, wrapped_data_key=$5 WHERE id=$1`, record.ConnectionID, sealed.Ciphertext, sealed.Nonce, sealed.KeyVersion, sealed.WrappedDataKey)
		if err != nil {
			return 0, err
		}
		if command.RowsAffected() != 1 {
			return 0, fmt.Errorf("rotation row disappeared")
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, err
	}
	return int64(len(records)), nil
}
