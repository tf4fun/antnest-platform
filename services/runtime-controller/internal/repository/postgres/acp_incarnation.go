package postgres

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/acpincarnation"
)

var _ acpincarnation.Store = (*Repository)(nil)

const acpIncarnationColumns = `controller_scope,registration_id,member_id,incarnation_id,
nonce_digest,engine_id,container_id,started_at,stop_receipt_id,stop_reason,stopped_at`

func (r *Repository) FindRegistration(ctx context.Context, scope, member, incarnation string) (*acpincarnation.Record, error) {
	return readAcpIncarnation(ctx, r.database.QueryRowContext(ctx,
		`SELECT `+acpIncarnationColumns+` FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND member_id=$2 AND incarnation_id=$3`, scope, member, incarnation))
}

func (r *Repository) GetRegistration(ctx context.Context, scope, id string) (*acpincarnation.Record, error) {
	return readAcpIncarnation(ctx, r.database.QueryRowContext(ctx,
		`SELECT `+acpIncarnationColumns+` FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND registration_id=$2`, scope, id))
}

func (r *Repository) RegisterVerified(ctx context.Context, candidate acpincarnation.Record) (acpincarnation.Record, error) {
	if candidate.Stop != nil {
		return acpincarnation.Record{}, fmt.Errorf("registration cannot supply a stop receipt")
	}
	started, err := canonicalAcpStart(candidate.Binding.StartedAt)
	if err != nil {
		return acpincarnation.Record{}, err
	}
	candidate.Binding.StartedAt = started
	return r.acpIncarnationTransaction(ctx, func(tx *sql.Tx) (acpincarnation.Record, error) {
		// A member's history position is assigned only under its durable head
		// lock. Registration and head advancement share this transaction, so a
		// snapshot can never expose a revision with an uncommitted earlier hole.
		if err := ensureAcpHistoryHead(ctx, tx, candidate.Scope, candidate.Registration.MemberID); err != nil {
			return acpincarnation.Record{}, err
		}
		var revision int64
		if err := tx.QueryRowContext(ctx, "SELECT revision FROM runtime_controller.acp_incarnation_histories WHERE controller_scope=$1 AND member_id=$2 FOR UPDATE", candidate.Scope, candidate.Registration.MemberID).Scan(&revision); err != nil {
			return acpincarnation.Record{}, err
		}
		existing, err := readAcpIncarnation(ctx, tx.QueryRowContext(ctx, `SELECT `+acpIncarnationColumns+` FROM runtime_controller.acp_incarnation_registrations WHERE controller_scope=$1 AND member_id=$2 AND incarnation_id=$3`, candidate.Scope, candidate.Registration.MemberID, candidate.Registration.IncarnationID))
		if err != nil {
			return acpincarnation.Record{}, err
		}
		if existing != nil {
			if existing.Binding != candidate.Binding || subtle.ConstantTimeCompare(existing.NonceDigest[:], candidate.NonceDigest[:]) != 1 {
				return acpincarnation.Record{}, acpincarnation.ErrConflict
			}
			return *existing, nil
		}
		if revision == math.MaxInt64 {
			return acpincarnation.Record{}, fmt.Errorf("ACP member history sequence is exhausted")
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO runtime_controller.acp_incarnation_registrations
(controller_scope,registration_id,member_id,incarnation_id,nonce_digest,engine_id,container_id,started_at,history_sequence)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
			candidate.Scope, candidate.Registration.RegistrationID, candidate.Registration.MemberID,
			candidate.Registration.IncarnationID, candidate.NonceDigest[:], candidate.Binding.EngineID,
			candidate.Binding.ContainerID, candidate.Binding.StartedAt, revision+1)
		if err != nil {
			var constraint *pgconn.PgError
			if errors.As(err, &constraint) && constraint.Code == "23505" &&
				constraint.SchemaName == "runtime_controller" && constraint.TableName == "acp_incarnation_registrations" &&
				constraint.ConstraintName == "acp_incarnation_registrations_pkey" {
				return acpincarnation.Record{}, acpincarnation.ErrConflict
			}
			return acpincarnation.Record{}, err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE runtime_controller.acp_incarnation_histories SET revision=$3 WHERE controller_scope=$1 AND member_id=$2", candidate.Scope, candidate.Registration.MemberID, revision+1); err != nil {
			return acpincarnation.Record{}, err
		}
		// Read the original stored binding, never reconstruct an idempotency
		// receipt from a caller's candidate or increment a retry's revision.
		stored, err := readAcpIncarnation(ctx, tx.QueryRowContext(ctx,
			`SELECT `+acpIncarnationColumns+` FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND member_id=$2 AND incarnation_id=$3`,
			candidate.Scope, candidate.Registration.MemberID, candidate.Registration.IncarnationID))
		if err != nil {
			return acpincarnation.Record{}, err
		}
		if stored == nil || stored.Binding != candidate.Binding ||
			subtle.ConstantTimeCompare(stored.NonceDigest[:], candidate.NonceDigest[:]) != 1 {
			return acpincarnation.Record{}, acpincarnation.ErrConflict
		}
		return *stored, nil
	})
}

func (r *Repository) RecordStopped(ctx context.Context, scope, id string, expected acpincarnation.Binding, candidate acpincarnation.StopReceipt) (acpincarnation.Record, error) {
	started, err := canonicalAcpStart(expected.StartedAt)
	if err != nil {
		return acpincarnation.Record{}, err
	}
	expected.StartedAt = started
	return r.acpIncarnationTransaction(ctx, func(tx *sql.Tx) (acpincarnation.Record, error) {
		stored, err := readAcpIncarnation(ctx, tx.QueryRowContext(ctx,
			`SELECT `+acpIncarnationColumns+` FROM runtime_controller.acp_incarnation_registrations
WHERE controller_scope=$1 AND registration_id=$2 FOR UPDATE`, scope, id))
		if err != nil {
			return acpincarnation.Record{}, err
		}
		if stored == nil || stored.Binding != expected {
			return acpincarnation.Record{}, acpincarnation.ErrConflict
		}
		if stored.Stop != nil {
			return *stored, nil
		}
		if candidate.ObservedAt.IsZero() {
			return acpincarnation.Record{}, fmt.Errorf("stop observation time is required")
		}
		// RETURNING reads PostgreSQL's actual timestamp precision on the first
		// response, so all concurrent and later callers receive the same receipt.
		stored, err = readAcpIncarnation(ctx, tx.QueryRowContext(ctx,
			`UPDATE runtime_controller.acp_incarnation_registrations
SET stop_receipt_id=$3,stop_reason=$4,stopped_at=$5
WHERE controller_scope=$1 AND registration_id=$2 AND stop_receipt_id IS NULL
RETURNING `+acpIncarnationColumns, scope, id, candidate.ReceiptID, candidate.Reason, candidate.ObservedAt.UTC()))
		if err != nil {
			return acpincarnation.Record{}, err
		}
		if stored == nil {
			return acpincarnation.Record{}, acpincarnation.ErrConflict
		}
		return *stored, nil
	})
}

func readAcpIncarnation(ctx context.Context, row *sql.Row) (*acpincarnation.Record, error) {
	var value acpincarnation.Record
	var digest []byte
	var receiptID, reason sql.NullString
	var stoppedAt sql.NullTime
	err := row.Scan(&value.Scope, &value.Registration.RegistrationID,
		&value.Registration.MemberID, &value.Registration.IncarnationID, &digest,
		&value.Binding.EngineID, &value.Binding.ContainerID, &value.Binding.StartedAt,
		&receiptID, &reason, &stoppedAt)
	if ctx.Err() != nil {
		return nil, errors.Join(err, ctx.Err())
	}
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if len(digest) != len(value.NonceDigest) || receiptID.Valid != reason.Valid || receiptID.Valid != stoppedAt.Valid {
		return nil, fmt.Errorf("stored incarnation receipt is invalid")
	}
	copy(value.NonceDigest[:], digest)
	if receiptID.Valid {
		value.Stop = &acpincarnation.StopReceipt{ReceiptID: receiptID.String, Reason: reason.String, ObservedAt: stoppedAt.Time.UTC()}
	}
	return &value, nil
}

// Own the connection until transaction cleanup has actually completed.
// sql.Tx.Rollback returning ErrTxDone can precede its cancellation goroutine's
// driver rollback. sql.Conn.Close waits for the transaction's connection release.
func (r *Repository) acpIncarnationTransaction(ctx context.Context, operation func(*sql.Tx) (acpincarnation.Record, error)) (acpincarnation.Record, error) {
	return acpRegistryTransaction(ctx, r.database, operation)
}

func acpRegistryTransaction[T any](ctx context.Context, database *sql.DB, operation func(*sql.Tx) (T, error)) (value T, err error) {
	var zero T
	connection, err := database.Conn(ctx)
	if err != nil {
		return zero, err
	}
	defer func() {
		err = errors.Join(err, connection.Close(), ctx.Err())
		if err != nil {
			value = zero
		}
	}()
	tx, err := connection.BeginTx(ctx, nil)
	if err != nil {
		return zero, err
	}
	defer func() {
		if rollbackErr := tx.Rollback(); rollbackErr != nil && !errors.Is(rollbackErr, sql.ErrTxDone) {
			err = errors.Join(err, rollbackErr)
		}
	}()
	value, err = operation(tx)
	if err != nil {
		return zero, err
	}
	if err = ctx.Err(); err != nil {
		return zero, err
	}
	if err = tx.Commit(); err != nil {
		return zero, err
	}
	return value, nil
}

func canonicalAcpStart(value string) (string, error) {
	started, err := time.Parse(time.RFC3339Nano, value)
	if err != nil || started.IsZero() {
		return "", fmt.Errorf("invalid incarnation start identity")
	}
	return started.UTC().Format(time.RFC3339Nano), nil
}
