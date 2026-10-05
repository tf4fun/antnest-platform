package repository

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

var ErrRekeyInProgress = errors.New("encryption rotation is already running")

const rekeyLockID int64 = 0x41544e4553544b49

type oidcRotationTable struct{ name, prefix, identityColumns string }

var oidcRotationTables = []oidcRotationTable{
	{name: "oidc_providers", prefix: "client_secret", identityColumns: "organization_id, name"},
	{name: "oidc_auth_sessions", prefix: "secret", identityColumns: "id, ''"},
}

func (store *Store) RekeyOIDCSecrets(ctx context.Context, box credentials.Rekeyer, batchSize int, progress func(secretencryption.Progress) error) (resultErr error) {
	if batchSize < 1 || batchSize > secretencryption.MaxBatchSize {
		return secretencryption.ErrBatchSize
	}
	if box == nil {
		return secretencryption.ErrConfiguration
	}
	connection, err := store.pool.Acquire(ctx)
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
	for _, table := range oidcRotationTables {
		for {
			count, err := rekeyOIDCBatch(ctx, connection, table, box, batchSize)
			if err != nil {
				return err
			}
			var remaining int64
			query := fmt.Sprintf("SELECT count(*) FROM %s WHERE %s_key_id<>$1 OR %s_wrapped_data_key IS NULL", table.name, table.prefix, table.prefix)
			if err := connection.QueryRow(ctx, query, box.ActiveKeyID()).Scan(&remaining); err != nil {
				return err
			}
			if progress != nil {
				if err := progress(secretencryption.Progress{Table: table.name, ActiveKID: box.ActiveKeyID(), Updated: count, Remaining: remaining}); err != nil {
					return err
				}
			}
			if count == 0 && remaining == 0 {
				break
			}
		}
	}
	return nil
}

type oidcRotationRecord struct {
	id, firstIdentity, secondIdentity string
	sealed                            credentials.SealedSecret
}

func rekeyOIDCBatch(ctx context.Context, connection *pgxpool.Conn, table oidcRotationTable, box credentials.Rekeyer, batchSize int) (int64, error) {
	tx, err := connection.Begin(ctx)
	if err != nil {
		return 0, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		_ = tx.Rollback(cleanup)
	}()
	// Identifiers come only from the two fixed service-owned descriptors above.
	query := fmt.Sprintf("SELECT id, %s, %s_ciphertext, %s_nonce, %s_key_id, %s_wrapped_data_key FROM %s WHERE %s_key_id<>$1 OR %s_wrapped_data_key IS NULL ORDER BY id LIMIT $2 FOR UPDATE", table.identityColumns, table.prefix, table.prefix, table.prefix, table.prefix, table.name, table.prefix, table.prefix)
	rows, err := tx.Query(ctx, query, box.ActiveKeyID(), batchSize)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	var records []oidcRotationRecord
	for rows.Next() {
		var record oidcRotationRecord
		if err := rows.Scan(&record.id, &record.firstIdentity, &record.secondIdentity, &record.sealed.Ciphertext, &record.sealed.Nonce, &record.sealed.KeyID, &record.sealed.WrappedDataKey); err != nil {
			return 0, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	rows.Close()
	update := fmt.Sprintf("UPDATE %s SET %s_ciphertext=$2, %s_nonce=$3, %s_key_id=$4, %s_wrapped_data_key=$5 WHERE id=$1", table.name, table.prefix, table.prefix, table.prefix, table.prefix)
	for _, record := range records {
		identity := record.firstIdentity
		if table.name == "oidc_providers" {
			identity = oidcflow.ProviderSecretIdentity(record.firstIdentity, record.secondIdentity)
		}
		sealed, err := box.Rekey(ctx, record.sealed, identity)
		if err != nil {
			return 0, err
		}
		command, err := tx.Exec(ctx, update, record.id, sealed.Ciphertext, sealed.Nonce, sealed.KeyID, sealed.WrappedDataKey)
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
