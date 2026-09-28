package postgres

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"fmt"
	"regexp"
	"time"
)

var verifierKeyIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)

// ReconcileLegacyVerifierKeys permanently revokes keys removed from startup
// configuration. Historical IDs and bytes are never reassigned.
func (repository *Repository) ReconcileLegacyVerifierKeys(ctx context.Context, configured map[string]ed25519.PublicKey) error {
	if len(configured) > 2 {
		return fmt.Errorf("at most two legacy verifier keys may be active")
	}
	for id, key := range configured {
		if !verifierKeyIDPattern.MatchString(id) || len(key) != ed25519.PublicKeySize {
			return fmt.Errorf("invalid legacy verifier key")
		}
		for otherID, otherKey := range configured {
			if otherID != id && bytes.Equal(key, otherKey) {
				return fmt.Errorf("duplicate legacy verifier public key")
			}
		}
	}
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin legacy verifier reconciliation: %w", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, `LOCK TABLE agent_controller.legacy_export_verifier_keys IN SHARE ROW EXCLUSIVE MODE`); err != nil {
		return fmt.Errorf("lock legacy verifier history: %w", err)
	}
	rows, err := transaction.Query(ctx, `SELECT key_id,public_key,revoked_at FROM agent_controller.legacy_export_verifier_keys`)
	if err != nil {
		return fmt.Errorf("read legacy verifier history: %w", err)
	}
	type history struct {
		key     []byte
		revoked *time.Time
	}
	existing := map[string]history{}
	for rows.Next() {
		var id string
		var entry history
		if err := rows.Scan(&id, &entry.key, &entry.revoked); err != nil {
			rows.Close()
			return fmt.Errorf("scan legacy verifier history: %w", err)
		}
		existing[id] = entry
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate legacy verifier history: %w", err)
	}
	rows.Close()
	for id, key := range configured {
		if entry, found := existing[id]; found {
			if entry.revoked != nil || !bytes.Equal(entry.key, key) {
				return fmt.Errorf("legacy verifier key %q is revoked or changed", id)
			}
			continue
		}
		if _, err := transaction.Exec(ctx, `INSERT INTO agent_controller.legacy_export_verifier_keys(key_id,public_key) VALUES($1,$2)`, id, []byte(key)); err != nil {
			return fmt.Errorf("register legacy verifier key: %w", err)
		}
	}
	for id, entry := range existing {
		if _, active := configured[id]; active || entry.revoked != nil {
			continue
		}
		if _, err := transaction.Exec(ctx, `UPDATE agent_controller.legacy_export_verifier_keys SET revoked_at=NOW() WHERE key_id=$1 AND revoked_at IS NULL`, id); err != nil {
			return fmt.Errorf("revoke legacy verifier key: %w", err)
		}
	}
	if err := transaction.Commit(ctx); err != nil {
		return fmt.Errorf("commit legacy verifier reconciliation: %w", err)
	}
	return nil
}

func (repository *Repository) LegacyVerifierKeyActive(ctx context.Context, id string, key ed25519.PublicKey) (bool, error) {
	if !verifierKeyIDPattern.MatchString(id) || len(key) != ed25519.PublicKeySize {
		return false, nil
	}
	var active bool
	err := repository.pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_controller.legacy_export_verifier_keys WHERE key_id=$1 AND public_key=$2 AND revoked_at IS NULL)`, id, []byte(key)).Scan(&active)
	if err != nil {
		return false, fmt.Errorf("check legacy verifier key: %w", err)
	}
	return active, nil
}
