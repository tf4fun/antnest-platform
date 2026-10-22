package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const (
	runtimeBarrierPolicyRequestLockNamespace      int32 = 0x42525051
	runtimeBarrierPolicyOrganizationLockNamespace int32 = 0x4252504f
)

const runtimeBarrierPolicySelect = `SELECT organization_id, revision, mode, cooldown_ms
FROM agent_controller.runtime_barrier_recovery_policies WHERE organization_id=$1`

var _ ports.RuntimeBarrierRecoveryPolicyStore = (*Repository)(nil)

func (repository *Repository) GetRuntimeBarrierRecoveryPolicy(ctx context.Context, organizationID string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	if !domain.ValidRuntimeBarrierPolicyIdentifier(organizationID) {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("invalid Runtime barrier recovery organization")
	}
	return readRuntimeBarrierPolicy(repository.pool.QueryRow(ctx, runtimeBarrierPolicySelect, organizationID), organizationID)
}

func readRuntimeBarrierPolicy(row pgx.Row, organizationID string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	var policy domain.RuntimeBarrierRecoveryPolicy
	err := row.Scan(&policy.OrganizationID, &policy.Revision, &policy.Mode, &policy.CooldownMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.DefaultRuntimeBarrierRecoveryPolicy(organizationID), nil
	}
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("read Runtime barrier recovery policy: %w", err)
	}
	if policy.Validate() != nil || policy.OrganizationID != organizationID || policy.Revision == 0 {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("invalid persisted Runtime barrier recovery policy")
	}
	return policy, nil
}

func (repository *Repository) SetRuntimeBarrierRecoveryPolicy(ctx context.Context, input ports.SetRuntimeBarrierRecoveryPolicy) (domain.RuntimeBarrierRecoveryPolicy, error) {
	if err := input.Validate(); err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, err
	}
	// Only the stable six-field intent is fingerprinted. Each HTTP attempt must
	// independently pass current workload and caller-context authorization.
	stable, err := json.Marshal(input)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, err
	}
	digest := sha256.Sum256(stable)
	fingerprint := hex.EncodeToString(digest[:])
	requestScope, err := json.Marshal([2]string{input.OrganizationID, input.RequestID})
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("begin Runtime barrier recovery policy mutation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, runtimeBarrierPolicyRequestLockNamespace, string(requestScope)); err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("lock Runtime barrier recovery request: %w", err)
	}
	var savedFingerprint string
	var original domain.RuntimeBarrierRecoveryPolicy
	err = tx.QueryRow(ctx, `SELECT organization_id, request_fingerprint, result_revision, result_mode, result_cooldown_ms
FROM agent_controller.runtime_barrier_recovery_policy_requests WHERE organization_id=$1 AND request_id=$2`,
		input.OrganizationID, input.RequestID).Scan(&original.OrganizationID, &savedFingerprint, &original.Revision, &original.Mode, &original.CooldownMS)
	if err == nil {
		// Intent conflicts take precedence over current CAS. A matching replay
		// returns the original snapshot, even after a later policy mutation.
		if savedFingerprint != fingerprint {
			return domain.RuntimeBarrierRecoveryPolicy{}, ports.ErrRequestConflict
		}
		if original.Validate() != nil || original.OrganizationID != input.OrganizationID ||
			original.Revision != input.ExpectedRevision+1 || original.Mode != input.Mode || original.CooldownMS != input.CooldownMS {
			return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("invalid Runtime barrier recovery policy receipt")
		}
		if err := tx.Commit(ctx); err != nil {
			return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("commit Runtime barrier recovery policy replay: %w", err)
		}
		return original, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("read Runtime barrier recovery policy receipt: %w", err)
	}
	// The organization lock also covers the absent-row case. Lock order is
	// always request then organization, and every mutation holds only one of each.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, runtimeBarrierPolicyOrganizationLockNamespace, input.OrganizationID); err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("lock Runtime barrier recovery organization: %w", err)
	}
	current, err := readRuntimeBarrierPolicy(tx.QueryRow(ctx, runtimeBarrierPolicySelect+` FOR UPDATE`, input.OrganizationID), input.OrganizationID)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, err
	}
	if current.Revision != input.ExpectedRevision || current.Revision == domain.RuntimeBarrierRecoveryMaxRevision {
		return domain.RuntimeBarrierRecoveryPolicy{}, ports.ErrConcurrentChange
	}
	updated := domain.RuntimeBarrierRecoveryPolicy{OrganizationID: input.OrganizationID,
		Revision: current.Revision + 1, Mode: input.Mode, CooldownMS: input.CooldownMS}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_policies
(organization_id, revision, mode, cooldown_ms) VALUES ($1,$2,$3,$4)
ON CONFLICT (organization_id) DO UPDATE SET revision=EXCLUDED.revision, mode=EXCLUDED.mode, cooldown_ms=EXCLUDED.cooldown_ms`,
		updated.OrganizationID, updated.Revision, updated.Mode, updated.CooldownMS)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("save Runtime barrier recovery policy: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_policy_requests
(organization_id, request_id, request_fingerprint, result_revision, result_mode, result_cooldown_ms)
VALUES ($1,$2,$3,$4,$5,$6)`, input.OrganizationID, input.RequestID, fingerprint, updated.Revision, updated.Mode, updated.CooldownMS)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("save Runtime barrier recovery policy receipt: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("commit Runtime barrier recovery policy mutation: %w", err)
	}
	return updated, nil
}
