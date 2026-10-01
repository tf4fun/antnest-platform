package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const learningPolicyRequestLockNamespace int32 = 0x4c524e47

func (repository *Repository) GetSkillLearningPolicy(ctx context.Context, scope ports.SkillLearningPolicyScope) (domain.SkillLearningPolicy, error) {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("begin Skill learning policy read: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	agent, err := lockLearningPolicyOwner(ctx, tx, scope)
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	policy, _, err := ensureLearningPolicy(ctx, tx, agent)
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("commit Skill learning policy read: %w", err)
	}
	return policy, nil
}

func (repository *Repository) SetSkillLearningPolicy(ctx context.Context, input ports.SetSkillLearningPolicy) (domain.SkillLearningPolicy, error) {
	if input.RequestID == "" || input.ExpectedRevision == "" || input.Policy.Revision != input.ExpectedRevision ||
		input.Policy.OrganizationID != input.Scope.OrganizationID || input.Policy.AgentID != input.Scope.AgentID ||
		input.Policy.OwnerPrincipalID != input.Scope.OwnerPrincipalID {
		return domain.SkillLearningPolicy{}, fmt.Errorf("invalid Skill learning policy mutation")
	}
	if err := input.Policy.ValidateMutation(); err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	// Revocation and access revisions are authorization proof, not part of the
	// stable user intent. A retry may carry fresher proof for the same request.
	stable, err := json.Marshal(struct {
		RequestID        string                     `json:"request_id"`
		ExpectedRevision string                     `json:"expected_revision"`
		Policy           domain.SkillLearningPolicy `json:"policy"`
	}{input.RequestID, input.ExpectedRevision, input.Policy})
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	fingerprintBytes := sha256.Sum256(stable)
	fingerprint := hex.EncodeToString(fingerprintBytes[:])
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("begin Skill learning policy mutation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, learningPolicyRequestLockNamespace, input.RequestID); err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("lock Skill learning policy request: %w", err)
	}
	agent, err := lockLearningPolicyOwner(ctx, tx, input.Scope)
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	var savedAgent, savedFingerprint string
	var receipt []byte
	err = tx.QueryRow(ctx, `SELECT agent_id, fingerprint, result FROM agent_controller.skill_learning_policy_requests WHERE request_id=$1`, input.RequestID).Scan(&savedAgent, &savedFingerprint, &receipt)
	if err == nil {
		if savedAgent != agent.AgentID || savedFingerprint != fingerprint {
			return domain.SkillLearningPolicy{}, ports.ErrRequestConflict
		}
		var result domain.SkillLearningPolicy
		if err := json.Unmarshal(receipt, &result); err != nil || result.Validate() != nil {
			return domain.SkillLearningPolicy{}, fmt.Errorf("invalid saved Skill learning policy receipt")
		}
		if err := tx.Commit(ctx); err != nil {
			return domain.SkillLearningPolicy{}, err
		}
		return result, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return domain.SkillLearningPolicy{}, fmt.Errorf("read Skill learning policy receipt: %w", err)
	}
	current, sequence, err := ensureLearningPolicy(ctx, tx, agent)
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	if current.Revision != input.ExpectedRevision {
		return domain.SkillLearningPolicy{}, ports.ErrConcurrentChange
	}
	updated := input.Policy
	updated.ActivationCutAt = current.ActivationCutAt
	if current.Mode == domain.LearningOff && updated.Mode == domain.LearningAutomatic {
		updated.ActivationCutAt = time.Now().UTC().Truncate(time.Microsecond)
	}
	updated.Revision, err = updated.RevisionForSequence(uint64(sequence + 1))
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	payload, err := json.Marshal(updated)
	if err != nil {
		return domain.SkillLearningPolicy{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE agent_controller.skill_learning_policies SET sequence=$2,revision=$3,policy=$4,updated_at=NOW()
WHERE agent_id=$1`, agent.AgentID, sequence+1, updated.Revision, payload)
	if err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("update Skill learning policy: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.skill_learning_policy_requests
(request_id,agent_id,fingerprint,result) VALUES ($1,$2,$3,$4)`, input.RequestID, agent.AgentID, fingerprint, payload)
	if err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("save Skill learning policy receipt: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.SkillLearningPolicy{}, fmt.Errorf("commit Skill learning policy mutation: %w", err)
	}
	return updated, nil
}

func lockLearningPolicyOwner(ctx context.Context, tx *databaseTransaction, scope ports.SkillLearningPolicyScope) (ports.AgentRecord, error) {
	if err := lockIdentityAdmission(ctx, tx); err != nil {
		return ports.AgentRecord{}, err
	}
	return lockAgentConfigurationOwner(ctx, tx, ports.SetAgentAuthorization{
		OrganizationID: scope.OrganizationID, Query: ports.AgentOwnerScope{
			AgentID: scope.AgentID, PrincipalID: scope.OwnerPrincipalID, ExpectedAccessRevision: scope.AccessRevision,
		}, OwnerRevocationSequence: scope.OwnerRevocationSequence,
	})
}

func ensureLearningPolicy(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord) (domain.SkillLearningPolicy, int64, error) {
	var sequence int64
	var revision string
	var payload []byte
	err := tx.QueryRow(ctx, `SELECT sequence, revision, policy FROM agent_controller.skill_learning_policies WHERE agent_id=$1 FOR UPDATE`, agent.AgentID).Scan(&sequence, &revision, &payload)
	if errors.Is(err, pgx.ErrNoRows) {
		policy := domain.DefaultSkillLearningPolicy(agent.OrganizationID, agent.AgentID, agent.OwnerUserID, agent.CreatedAt)
		if err := policy.Validate(); err != nil {
			return domain.SkillLearningPolicy{}, 0, err
		}
		payload, err = json.Marshal(policy)
		if err != nil {
			return domain.SkillLearningPolicy{}, 0, err
		}
		_, err = tx.Exec(ctx, `INSERT INTO agent_controller.skill_learning_policies
(agent_id,organization_id,owner_principal_id,sequence,revision,policy) VALUES ($1,$2,$3,1,$4,$5)`,
			agent.AgentID, agent.OrganizationID, agent.OwnerUserID, policy.Revision, payload)
		if err != nil {
			return domain.SkillLearningPolicy{}, 0, fmt.Errorf("create default Skill learning policy: %w", err)
		}
		return policy, 1, nil
	}
	if err != nil {
		return domain.SkillLearningPolicy{}, 0, fmt.Errorf("read Skill learning policy: %w", err)
	}
	var policy domain.SkillLearningPolicy
	if err := json.Unmarshal(payload, &policy); err != nil {
		return domain.SkillLearningPolicy{}, 0, fmt.Errorf("decode Skill learning policy: %w", err)
	}
	computed, err := policy.RevisionForSequence(uint64(sequence))
	if err != nil || policy.Validate() != nil || revision != policy.Revision || computed != revision ||
		policy.OrganizationID != agent.OrganizationID || policy.AgentID != agent.AgentID || policy.OwnerPrincipalID != agent.OwnerUserID {
		return domain.SkillLearningPolicy{}, 0, fmt.Errorf("skill learning policy persistence invariant failed")
	}
	return policy, sequence, nil
}
