package postgres

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

const observationTransactionTimeout = 5 * time.Second

const observationRetentionSQL = `
CREATE TABLE runtime_controller.observation_leader (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    epoch BIGINT NOT NULL CHECK (epoch >= 0),
    holder TEXT NOT NULL
);
INSERT INTO runtime_controller.observation_leader (id, epoch, holder) VALUES (1, 0, '');
CREATE TABLE runtime_controller.observation_journal (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    pruned_through BIGINT NOT NULL CHECK (pruned_through >= 0)
);
INSERT INTO runtime_controller.observation_journal (id, pruned_through)
SELECT 1, GREATEST(COALESCE(MIN(sequence), 1) - 1, 0) FROM runtime_controller.observations;
`

// Database-side timeouts also release a fenced transaction when the client
// process is paused and cannot deliver its context cancellation.
func boundObservationTransaction(ctx context.Context, tx *sql.Tx) error {
	if _, err := tx.ExecContext(ctx, `SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '5s'`); err != nil {
		return fmt.Errorf("bound observation transaction: %w", err)
	}
	return nil
}

func verifyObservationEpoch(ctx context.Context, tx *sql.Tx, epoch repository.ObservationEpoch) error {
	if epoch <= 0 {
		return repository.ErrLeadershipLost
	}
	var current repository.ObservationEpoch
	if err := tx.QueryRowContext(ctx, `SELECT epoch FROM runtime_controller.observation_leader WHERE id=1 FOR SHARE`).Scan(&current); err != nil {
		return fmt.Errorf("read observation leadership epoch: %w", err)
	}
	if current != epoch {
		return repository.ErrLeadershipLost
	}
	return nil
}

// The caller holds the session advisory lock on this same dedicated connection.
func advanceObservationEpoch(ctx context.Context, connection *sql.Conn) (repository.ObservationEpoch, error) {
	ctx, cancel := context.WithTimeout(ctx, observationTransactionTimeout)
	defer cancel()
	tx, err := connection.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin observation leadership epoch: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := boundObservationTransaction(ctx, tx); err != nil {
		return 0, err
	}
	var epoch repository.ObservationEpoch
	if err := tx.QueryRowContext(ctx, `UPDATE runtime_controller.observation_leader SET epoch=epoch+1, holder=pg_backend_pid()::text WHERE id=1 RETURNING epoch`).Scan(&epoch); err != nil {
		return 0, fmt.Errorf("advance observation leadership epoch: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit observation leadership epoch: %w", err)
	}
	return epoch, nil
}

func (r *Repository) PruneObservationBatch(ctx context.Context, epoch repository.ObservationEpoch) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, observationTransactionTimeout)
	defer cancel()
	tx, err := r.database.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, fmt.Errorf("begin observation pruning: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := boundObservationTransaction(ctx, tx); err != nil {
		return 0, err
	}
	if err := verifyObservationEpoch(ctx, tx, epoch); err != nil {
		return 0, err
	}
	// Separate from the epoch row: cleanup never upgrades a leader shared lock
	// and never locks the journal sequence allocator or any operation row.
	var previous uint64
	if err := tx.QueryRowContext(ctx, `SELECT pruned_through FROM runtime_controller.observation_journal WHERE id=1 FOR UPDATE`).Scan(&previous); err != nil {
		return 0, fmt.Errorf("lock observation retention floor: %w", err)
	}
	var removed int64
	var through uint64
	if err := tx.QueryRowContext(ctx, pruneObservationBatchSQL, time.Now().UTC().Add(-r.retention), r.maxObservationRows).Scan(&removed, &through); err != nil {
		return 0, fmt.Errorf("prune observation prefix: %w", err)
	}
	if through > previous {
		if _, err := tx.ExecContext(ctx, `UPDATE runtime_controller.observation_journal SET pruned_through=$1 WHERE id=1`, through); err != nil {
			return 0, fmt.Errorf("advance observation retention floor: %w", err)
		}
	}
	if removed > 0 {
		if err := notifyObservation(ctx, tx); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit observation pruning: %w", err)
	}
	return removed, nil
}

const pruneObservationBatchSQL = `
WITH cutoff AS (
    SELECT GREATEST(
        COALESCE((SELECT MAX(sequence) FROM runtime_controller.observations WHERE recorded_at < $1), 0),
        COALESCE((SELECT sequence FROM runtime_controller.observations ORDER BY sequence DESC OFFSET $2 LIMIT 1), 0)
    ) AS through
), removed AS (
    DELETE FROM runtime_controller.observations
    WHERE sequence IN (
        SELECT sequence FROM runtime_controller.observations
        WHERE sequence <= (SELECT through FROM cutoff)
        ORDER BY sequence LIMIT 1000
    )
    RETURNING sequence
)
SELECT COUNT(*), COALESCE(MAX(sequence), 0) FROM removed`

var _ repository.ObservationPruner = (*Repository)(nil)
