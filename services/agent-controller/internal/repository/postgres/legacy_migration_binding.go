package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func validateLegacyMigrationBinding(binding *ports.LegacySkillMigrationBinding, now time.Time) error {
	if binding == nil {
		return nil
	}
	if binding.ChoiceRequestID == "" || binding.ChoiceSequence < 1 || !verifierKeyIDPattern.MatchString(binding.KeyID) ||
		len(binding.Attestation) < 1 || len(binding.Attestation) > 8192 || !binding.ExpiresAt.After(now) {
		return ports.ErrConcurrentChange
	}
	digest := sha256.Sum256(binding.Attestation)
	if binding.AttestationDigest != hex.EncodeToString(digest[:]) {
		return ports.ErrConcurrentChange
	}
	var fields struct {
		Version   int    `json:"version"`
		KeyID     string `json:"key_id"`
		ExpiresAt string `json:"expires_at"`
	}
	if err := json.Unmarshal(binding.Attestation, &fields); err != nil || fields.Version != 1 || fields.KeyID != binding.KeyID {
		return ports.ErrConcurrentChange
	}
	expires, err := time.Parse(time.RFC3339Nano, fields.ExpiresAt)
	if err != nil || !expires.After(now) || !sameStoredLegacyExpiry(expires, binding.ExpiresAt) {
		return ports.ErrConcurrentChange
	}
	return nil
}

// PostgreSQL timestamps retain microseconds; the signed RFC3339Nano proof is
// authoritative for expiry while the stored column is a bounded lookup value.
func sameStoredLegacyExpiry(signed, stored time.Time) bool {
	delta := signed.Sub(stored)
	return delta > -time.Microsecond && delta < time.Microsecond
}

func checkLegacyLifecycleAdmission(ctx context.Context, transaction *databaseTransaction, agent ports.AgentRecord, binding *ports.LegacySkillMigrationBinding, now time.Time) error {
	if err := validateLegacyMigrationBinding(binding, now); err != nil {
		return err
	}
	var state string
	err := transaction.QueryRow(ctx, `SELECT state FROM agent_controller.legacy_system_skills_migrations WHERE agent_id=$1 AND organization_id=$2 FOR UPDATE`, agent.AgentID, agent.OrganizationID).Scan(&state)
	if errors.Is(err, pgx.ErrNoRows) {
		if binding == nil {
			return nil
		}
		return ports.ErrConcurrentChange
	}
	if err != nil {
		return fmt.Errorf("read legacy migration marker: %w", err)
	}
	if state != "pending" || binding == nil {
		if state == "resolved" && binding == nil {
			return nil
		}
		return ports.ErrConcurrentChange
	}
	choice, err := loadLatestLegacySkillChoice(ctx, transaction, agent.AgentID)
	if err != nil {
		return err
	}
	if choice == nil || choice.RequestID != binding.ChoiceRequestID || choice.Sequence != binding.ChoiceSequence || choice.OrganizationID != agent.OrganizationID {
		return ports.ErrConcurrentChange
	}
	var active bool
	if err := transaction.QueryRow(ctx, `SELECT revoked_at IS NULL FROM agent_controller.legacy_export_verifier_keys WHERE key_id=$1 FOR SHARE`, binding.KeyID).Scan(&active); err != nil {
		return fmt.Errorf("check legacy signing key: %w", err)
	}
	if !active {
		return ports.ErrConcurrentChange
	}
	return nil
}

func checkLegacyMigrationPublish(ctx context.Context, transaction *databaseTransaction, state ports.AgentRebuildState, input ports.PublishAgentRebuild) (bool, error) {
	return checkLegacyPublishTarget(ctx, transaction, state.Agent, state.SourceSpec, state.TargetSpec,
		state.Operation, state.LegacyMigration, input.LegacyVerification, domain.OperationRebuild, input.Fingerprint, input.Now)
}

func checkLegacyPublishTarget(ctx context.Context, transaction *databaseTransaction, agent ports.AgentRecord,
	sourceSpec, targetSpec ports.AgentSpecRecord, operation ports.LifecycleOperationRecord,
	binding *ports.LegacySkillMigrationBinding, proof *ports.LegacySkillPublishVerification,
	kind domain.OperationKind, fingerprint string, now time.Time) (bool, error) {
	if binding == nil {
		if proof != nil {
			return false, ports.ErrConcurrentChange
		}
		return false, nil
	}
	if proof == nil || operation.RuntimeResult == nil || proof.PreparedReferenceID == "" {
		return false, ports.ErrConcurrentChange
	}
	if err := checkLegacyLifecycleAdmission(ctx, transaction, agent, binding, now); err != nil {
		if errors.Is(err, ports.ErrConcurrentChange) || errors.Is(err, ports.ErrNotFound) || errors.Is(err, pgx.ErrNoRows) {
			return false, ports.ErrLegacyMigrationProofLost
		}
		return false, err
	}
	intent, err := loadSkillPreparationIntent(ctx, transaction, operation.RequestID)
	if err != nil {
		return false, err
	}
	receipt := proof.Receipt
	if intent.Kind != kind || intent.State != "ready" || intent.AgentID != agent.AgentID ||
		intent.OrganizationID != agent.OrganizationID || intent.RequestFingerprint != fingerprint ||
		intent.PreparedReferenceID != proof.PreparedReferenceID || intent.TargetSpecDigest != targetSpec.CanonicalDigest ||
		intent.TargetSpec.SkillSetDigest != targetSpec.Snapshot.SkillSetDigest ||
		receipt.AgentID != agent.AgentID || receipt.RuntimeRevision != operation.RuntimeResult.RuntimeRevision ||
		receipt.SkillSetDigest != targetSpec.Snapshot.SkillSetDigest || receipt.LayoutVersion != domain.SkillLayoutVersion ||
		len(receipt.ManifestDigest) != 71 || receipt.ManifestDigest[:7] != "sha256:" ||
		receipt.VerifiedAt.IsZero() || receipt.VerifiedAt.After(now.Add(time.Minute)) ||
		receipt.VerifiedAt.Before(now.Add(-time.Minute)) {
		return false, ports.ErrConcurrentChange
	}
	if _, err := hex.DecodeString(receipt.ManifestDigest[7:]); err != nil {
		return false, ports.ErrConcurrentChange
	}
	choice, err := loadLatestLegacySkillChoice(ctx, transaction, agent.AgentID)
	if err != nil {
		return false, err
	}
	if choice == nil || choice.RequestID != binding.ChoiceRequestID || choice.Sequence != binding.ChoiceSequence {
		return false, ports.ErrConcurrentChange
	}
	if err := checkLegacyTargetAgainstChoice(agent.OrganizationID, sourceSpec.Snapshot, targetSpec.Snapshot, *choice); err != nil {
		return false, err
	}
	return true, nil
}

func checkLegacyTargetAgainstChoice(organizationID string, source, target domain.AgentSpecSnapshot, choice ports.LegacySkillChoice) error {
	switch choice.Kind {
	case "empty":
		expected := source
		expected.SystemSkills = nil
		var err error
		expected.SkillSetDigest, err = domain.SkillSetDigest(organizationID, nil)
		if err != nil {
			return err
		}
		actual := target
		actual.SystemSkills = nil
		if !reflect.DeepEqual(expected, actual) {
			return ports.ErrConcurrentChange
		}
	case "template_revision":
		if target.TemplateID != choice.TemplateID || target.TemplateRevision != choice.TemplateRevision ||
			len(target.SystemSkills) == 0 {
			return ports.ErrConcurrentChange
		}
	default:
		return ports.ErrConcurrentChange
	}
	return nil
}

func resolveLegacyMigration(ctx context.Context, transaction *databaseTransaction, agentID, requestID string, now time.Time) error {
	result, err := transaction.Exec(ctx, `UPDATE agent_controller.legacy_system_skills_migrations
SET state='resolved', evidence_ref=$2, resolved_at=$3
WHERE agent_id=$1 AND state='pending'`, agentID, requestID, now)
	if err != nil {
		return fmt.Errorf("resolve legacy Skill migration: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func insertLegacyMigrationBinding(ctx context.Context, transaction *databaseTransaction, requestID, agentID string, binding *ports.LegacySkillMigrationBinding, now time.Time) error {
	if binding == nil {
		return nil
	}
	_, err := transaction.Exec(ctx, `INSERT INTO agent_controller.legacy_skill_migration_bindings
	(operation_request_id,agent_id,choice_request_id,choice_sequence,key_id,attestation,attestation_digest,expires_at,created_at)
	VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
		requestID, agentID, binding.ChoiceRequestID, binding.ChoiceSequence, binding.KeyID,
		binding.Attestation, binding.AttestationDigest, binding.ExpiresAt, now)
	if err != nil {
		return fmt.Errorf("record legacy migration binding: %w", err)
	}
	return nil
}

func loadLegacyMigrationBinding(ctx context.Context, query legacyChoiceQuery, requestID string) (*ports.LegacySkillMigrationBinding, error) {
	var binding ports.LegacySkillMigrationBinding
	err := query.QueryRow(ctx, `SELECT choice_request_id,choice_sequence,key_id,attestation,attestation_digest,expires_at FROM agent_controller.legacy_skill_migration_bindings WHERE operation_request_id=$1`, requestID).
		Scan(&binding.ChoiceRequestID, &binding.ChoiceSequence, &binding.KeyID, &binding.Attestation, &binding.AttestationDigest, &binding.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load legacy migration binding: %w", err)
	}
	return &binding, nil
}

func sameLegacyMigrationBinding(left, right *ports.LegacySkillMigrationBinding) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return left.ChoiceRequestID == right.ChoiceRequestID && left.ChoiceSequence == right.ChoiceSequence &&
		left.KeyID == right.KeyID && left.AttestationDigest == right.AttestationDigest &&
		sameStoredLegacyExpiry(left.ExpiresAt, right.ExpiresAt) && bytes.Equal(left.Attestation, right.Attestation)
}
