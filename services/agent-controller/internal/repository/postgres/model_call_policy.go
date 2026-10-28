package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const modelCallPolicyRequestLockNamespace int32 = 0x4d435051

const modelCallPolicySelect = `SELECT organization_id, revision, policy FROM agent_controller.model_call_policies WHERE organization_id=$1`

var _ ports.ModelCallPolicyStore = (*Repository)(nil)

func (repository *Repository) GetModelCallPolicy(ctx context.Context, organizationID string) (domain.ModelCallPolicy, error) {
	if !domain.ValidModelCallPolicyIdentifier(organizationID) {
		return domain.ModelCallPolicy{}, fmt.Errorf("invalid model call policy organization")
	}
	stored, err := readStoredModelCallPolicy(repository.pool.QueryRow(ctx, modelCallPolicySelect, organizationID), organizationID)
	if err != nil {
		return domain.ModelCallPolicy{}, err
	}
	if stored == nil {
		return domain.DefaultModelCallPolicy(organizationID), nil
	}
	return *stored, nil
}

func readStoredModelCallPolicy(row pgx.Row, organizationID string) (*domain.ModelCallPolicy, error) {
	var storedOrganization string
	var revision int64
	var raw []byte
	err := row.Scan(&storedOrganization, &revision, &raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read model call policy: %w", err)
	}
	return decodeModelCallPolicyRow(storedOrganization, revision, raw, organizationID)
}

func decodeModelCallPolicyRow(storedOrganization string, revision int64, raw []byte, organizationID string) (*domain.ModelCallPolicy, error) {
	var policy domain.ModelCallPolicy
	if err := json.Unmarshal(raw, &policy); err != nil {
		return nil, fmt.Errorf("decode persisted model call policy: %w", err)
	}
	if storedOrganization != organizationID || policy.OrganizationID != organizationID ||
		revision < 1 || policy.Revision != revision || policy.Validate() != nil {
		return nil, fmt.Errorf("invalid persisted model call policy")
	}
	return &policy, nil
}

func modelCallPolicyUpdate(input ports.SetModelCallPolicy, revision int64) domain.ModelCallPolicy {
	return domain.ModelCallPolicy{OrganizationID: input.OrganizationID, OrganizationBudget: domain.OrganizationBudget{
		Revision: revision, UnknownCost: input.UnknownCost,
		RunCaps: *input.RunCaps.Clone(), Daily: *input.Daily.Clone(), Monthly: *input.Monthly.Clone(),
	}}
}

func (repository *Repository) SetModelCallPolicy(ctx context.Context, input ports.SetModelCallPolicy) (domain.ModelCallPolicy, error) {
	if err := input.Validate(); err != nil {
		return domain.ModelCallPolicy{}, err
	}
	stable, err := json.Marshal(input)
	if err != nil {
		return domain.ModelCallPolicy{}, err
	}
	digest := sha256.Sum256(stable)
	fingerprint := hex.EncodeToString(digest[:])
	requestScope, err := json.Marshal([2]string{input.OrganizationID, input.RequestID})
	if err != nil {
		return domain.ModelCallPolicy{}, err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("begin model call policy mutation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, modelCallPolicyRequestLockNamespace, string(requestScope)); err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("lock model call policy request: %w", err)
	}
	var savedFingerprint string
	var rawResult []byte
	err = tx.QueryRow(ctx, `SELECT request_fingerprint, result FROM agent_controller.model_call_policy_requests
WHERE organization_id=$1 AND request_id=$2`, input.OrganizationID, input.RequestID).Scan(&savedFingerprint, &rawResult)
	if err == nil {
		if savedFingerprint != fingerprint {
			return domain.ModelCallPolicy{}, ports.ErrRequestConflict
		}
		var original domain.ModelCallPolicy
		if err := json.Unmarshal(rawResult, &original); err != nil {
			return domain.ModelCallPolicy{}, fmt.Errorf("decode model call policy receipt: %w", err)
		}
		expected := modelCallPolicyUpdate(input, input.ExpectedRevision+1)
		if original.OrganizationID != input.OrganizationID || original.Validate() != nil ||
			!reflect.DeepEqual(original.OrganizationBudget, expected.OrganizationBudget) {
			return domain.ModelCallPolicy{}, fmt.Errorf("invalid model call policy receipt")
		}
		if err := tx.Commit(ctx); err != nil {
			return domain.ModelCallPolicy{}, fmt.Errorf("commit model call policy replay: %w", err)
		}
		return original, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.ModelCallPolicy{}, fmt.Errorf("read model call policy receipt: %w", err)
	}
	if err := lockExecutionOrganization(ctx, tx, input.OrganizationID); err != nil {
		return domain.ModelCallPolicy{}, err
	}
	stored, err := readStoredModelCallPolicy(tx.QueryRow(ctx, modelCallPolicySelect+` FOR UPDATE`, input.OrganizationID), input.OrganizationID)
	if err != nil {
		return domain.ModelCallPolicy{}, err
	}
	current := domain.DefaultModelCallPolicy(input.OrganizationID)
	if stored != nil {
		current = *stored
	}
	if current.Revision != input.ExpectedRevision || current.Revision == domain.MaximumModelBudget {
		return domain.ModelCallPolicy{}, ports.ErrConcurrentChange
	}
	updated := modelCallPolicyUpdate(input, current.Revision+1)
	rawPolicy, err := json.Marshal(updated)
	if err != nil {
		return domain.ModelCallPolicy{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.model_call_policies
(organization_id, revision, policy) VALUES ($1,$2,$3)
ON CONFLICT (organization_id) DO UPDATE SET revision=EXCLUDED.revision, policy=EXCLUDED.policy`,
		updated.OrganizationID, updated.Revision, rawPolicy)
	if err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("save model call policy: %w", err)
	}
	if err := repository.advanceExecutionRevision(ctx, tx, input.OrganizationID); err != nil {
		return domain.ModelCallPolicy{}, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.model_call_policy_requests
(organization_id, request_id, request_fingerprint, result) VALUES ($1,$2,$3,$4)`,
		input.OrganizationID, input.RequestID, fingerprint, rawPolicy)
	if err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("save model call policy receipt: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.ModelCallPolicy{}, fmt.Errorf("commit model call policy mutation: %w", err)
	}
	return updated, nil
}
