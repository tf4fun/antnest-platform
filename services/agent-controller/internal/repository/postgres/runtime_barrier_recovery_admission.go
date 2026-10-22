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

var _ ports.RuntimeBarrierRecoveryStore = (*Repository)(nil)

const runtimeBarrierRecoverySelect = `SELECT r.organization_id, r.agent_id, r.barrier_id,
r.runtime_revision, r.runtime_execution_id, r.reason, r.request_id, r.request_fingerprint,
r.policy_revision, r.policy_mode, r.policy_cooldown_ms, r.actor_principal_id,
r.template_id, r.template_revision, r.accepted_at, r.cooldown_until, r.manual
FROM agent_controller.runtime_barrier_recovery_receipts r`

func recoveryCommandFingerprint(command ports.RuntimeBarrierRebuildCommand) string {
	// Preserve the existing six Rebuild fields, their order and spelling.
	payload, _ := json.Marshal(command)
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func validRecoveryCommand(fact ports.RuntimeBarrierResult, command ports.RuntimeBarrierRebuildCommand, fingerprint string, manual bool) bool {
	if fact.Barrier == nil || !fact.Matches(ports.RuntimeBarrierQuery{
		OrganizationID: command.OrganizationID, AgentID: command.AgentID,
		ExpectedRuntimeRevision: fact.RuntimeRevision,
	}) || !domain.ValidRuntimeBarrierPolicyIdentifier(command.OrganizationID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(command.AgentID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(command.TemplateID) ||
		command.TemplateRevision < 1 || !ports.ValidRuntimeBarrierRecoveryActor(command.ActorPrincipalID, manual) {
		return false
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	return err == nil && command.RequestID == requestID && fingerprint == recoveryCommandFingerprint(command)
}

func validateRuntimeBarrierRecovery(input ports.BeginAgentRebuild) error {
	intent := input.Recovery
	if intent == nil {
		return nil
	}
	if !validRecoveryCommand(intent.Fact, intent.Command, input.Operation.RequestFingerprint, intent.Manual) ||
		intent.Command.RequestID != input.Operation.RequestID || intent.Command.AgentID != input.AgentID ||
		intent.Fact.RuntimeRevision != input.ExpectedRuntimeRevision ||
		intent.ExpectedPolicyRevision < 0 || intent.ExpectedPolicyRevision > domain.RuntimeBarrierRecoveryMaxRevision ||
		intent.ExpectedOwnerUserID == "" || intent.ExpectedOwnerAuthorizationSequence < 0 || intent.ExpectedIdentityRevocationSequence < 0 ||
		input.Operation.AgentID != input.AgentID || input.Operation.Kind != domain.OperationRebuild ||
		input.Operation.Phase != domain.PhaseDrain || input.Operation.State != domain.OperationRunning ||
		input.Operation.ChildRequestID != domain.ChildRequestID(input.Operation.RequestID, domain.PhaseDrain) ||
		input.RequestedEvent.AgentID != input.AgentID || input.RequestedEvent.OperationRequestID != input.Operation.RequestID ||
		input.RequestedEvent.EventType != ports.EventAgentRebuildRequested {
		return ports.ErrInvalidRuntimeBarrierRecovery
	}
	return nil
}

func scanRuntimeBarrierRecovery(row catalogRowScanner) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	var receipt ports.RuntimeBarrierRecoveryReceipt
	var barrierID, executionID []byte
	barrier := &ports.RuntimeBarrier{}
	err := row.Scan(&receipt.Fact.OrganizationID, &receipt.Fact.AgentID, &barrierID,
		&receipt.Fact.RuntimeRevision, &executionID, &barrier.Reason,
		&receipt.Command.RequestID, &receipt.RequestFingerprint, &receipt.Policy.Revision,
		&receipt.Policy.Mode, &receipt.Policy.CooldownMS, &receipt.Command.ActorPrincipalID,
		&receipt.Command.TemplateID, &receipt.Command.TemplateRevision, &receipt.AcceptedAt, &receipt.CooldownUntil, &receipt.Manual)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, nil
	}
	if err != nil {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, fmt.Errorf("read Runtime barrier recovery receipt: %w", err)
	}
	barrier.BarrierID, barrier.RuntimeExecutionID = string(barrierID), string(executionID)
	receipt.Fact.Barrier = barrier
	receipt.Command.OrganizationID, receipt.Command.AgentID = receipt.Fact.OrganizationID, receipt.Fact.AgentID
	receipt.Policy.OrganizationID = receipt.Fact.OrganizationID
	if !validRecoveryCommand(receipt.Fact, receipt.Command, receipt.RequestFingerprint, receipt.Manual) ||
		receipt.Policy.Validate() != nil || (!receipt.Manual && receipt.Policy.Mode != "auto") || receipt.AcceptedAt.IsZero() ||
		!receipt.CooldownUntil.Equal(receipt.AcceptedAt.Add(time.Duration(receipt.Policy.CooldownMS)*time.Millisecond)) {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, fmt.Errorf("invalid persisted Runtime barrier recovery receipt")
	}
	return receipt, true, nil
}

func readRuntimeBarrierRecovery(ctx context.Context, queryer catalogQueryer, organizationID, agentID, barrierID string) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	return scanRuntimeBarrierRecovery(queryer.QueryRow(ctx, runtimeBarrierRecoverySelect+`
WHERE r.organization_id=$1 AND r.agent_id=$2 AND r.barrier_id=$3`, organizationID, agentID, []byte(barrierID)))
}

func (repository *Repository) ReplayRuntimeBarrierRecovery(ctx context.Context, organizationID, agentID, barrierID string) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	if _, err := ports.RuntimeBarrierRecoveryRequestID(organizationID, agentID, barrierID); err != nil ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(organizationID) || !domain.ValidRuntimeBarrierPolicyIdentifier(agentID) {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, ports.ErrInvalidRuntimeBarrierRecovery
	}
	return readRuntimeBarrierRecovery(ctx, repository.pool, organizationID, agentID, barrierID)
}

func (repository *Repository) ListPendingRuntimeBarrierRecoveryStarts(ctx context.Context, afterRequestID string, limit int) ([]ports.RuntimeBarrierRecoveryReceipt, error) {
	if limit < 1 || limit > 1000 || (afterRequestID != "" && !domain.ValidRuntimeBarrierPolicyIdentifier(afterRequestID)) {
		return nil, ports.ErrInvalidRuntimeBarrierRecovery
	}
	rows, err := repository.pool.Query(ctx, runtimeBarrierRecoverySelect+`
JOIN agent_controller.runtime_barrier_recovery_starts s ON s.request_id=r.request_id
WHERE s.started_at IS NULL AND r.request_id>$1 ORDER BY r.request_id LIMIT $2`, afterRequestID, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending Runtime barrier recovery starts: %w", err)
	}
	defer rows.Close()
	receipts := []ports.RuntimeBarrierRecoveryReceipt{}
	for rows.Next() {
		receipt, _, err := scanRuntimeBarrierRecovery(rows)
		if err != nil {
			return nil, err
		}
		receipts = append(receipts, receipt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read pending Runtime barrier recovery starts: %w", err)
	}
	return receipts, nil
}

func (repository *Repository) ConfirmRuntimeBarrierRecoveryStarted(ctx context.Context, requestID, fingerprint string) error {
	if !domain.ValidRuntimeBarrierPolicyIdentifier(requestID) || len(fingerprint) != 64 {
		return ports.ErrInvalidRuntimeBarrierRecovery
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Runtime barrier start acknowledgement: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var savedFingerprint string
	var startedAt *time.Time
	err = tx.QueryRow(ctx, `SELECT r.request_fingerprint, s.started_at
FROM agent_controller.runtime_barrier_recovery_starts s
JOIN agent_controller.runtime_barrier_recovery_receipts r ON r.request_id=s.request_id
WHERE s.request_id=$1 FOR UPDATE OF s`, requestID).Scan(&savedFingerprint, &startedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ports.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock Runtime barrier pending start: %w", err)
	}
	if savedFingerprint != fingerprint {
		return ports.ErrRequestConflict
	}
	if startedAt == nil {
		if _, err := tx.Exec(ctx, `UPDATE agent_controller.runtime_barrier_recovery_starts
SET started_at=clock_timestamp() WHERE request_id=$1 AND started_at IS NULL`, requestID); err != nil {
			return fmt.Errorf("acknowledge Runtime barrier start: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Runtime barrier start acknowledgement: %w", err)
	}
	return nil
}

func lockRuntimeBarrierRecoveryPolicy(ctx context.Context, tx *databaseTransaction, intent *ports.RuntimeBarrierRecoveryIntent) (domain.RuntimeBarrierRecoveryPolicy, error) {
	organizationID := intent.Fact.OrganizationID
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1, hashtext($2))`, runtimeBarrierPolicyOrganizationLockNamespace, organizationID); err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, fmt.Errorf("lock Runtime barrier recovery policy: %w", err)
	}
	policy, err := readRuntimeBarrierPolicy(tx.QueryRow(ctx, runtimeBarrierPolicySelect+` FOR UPDATE`, organizationID), organizationID)
	if err != nil {
		return domain.RuntimeBarrierRecoveryPolicy{}, err
	}
	if policy.Revision != intent.ExpectedPolicyRevision || (!intent.Manual && policy.Mode != "auto") {
		return domain.RuntimeBarrierRecoveryPolicy{}, ports.ErrConcurrentChange
	}
	return policy, nil
}

func guardRuntimeBarrierRecovery(ctx context.Context, tx *databaseTransaction, input ports.BeginAgentRebuild, agent ports.AgentRecord, source ports.AgentSpecRecord) error {
	intent := input.Recovery
	if agent.OrganizationID != intent.Fact.OrganizationID || agent.OwnerUserID != intent.ExpectedOwnerUserID ||
		agent.OwnerAuthorizationSequence != intent.ExpectedOwnerAuthorizationSequence || agent.IdentityRevocationSequence != intent.ExpectedIdentityRevocationSequence ||
		source.Snapshot.TemplateID != intent.Command.TemplateID || source.Snapshot.TemplateRevision != intent.Command.TemplateRevision ||
		input.TargetSpec.Snapshot.TemplateID != intent.Command.TemplateID || input.TargetSpec.Snapshot.TemplateRevision != intent.Command.TemplateRevision {
		return ports.ErrConcurrentChange
	}
	if err := validateOwnerWatermark(ctx, tx, agent.OwnerUserID, agent.OrganizationID, agent.OwnerAuthorizationSequence); err != nil {
		return err
	}
	var active bool
	err := tx.QueryRow(ctx, `SELECT active FROM agent_controller.agent_access_bindings
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 FOR UPDATE`, agent.AgentID, agent.OwnerUserID, agent.AccessRevision).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !active) {
		return ports.ErrConcurrentChange
	}
	if err != nil {
		return fmt.Errorf("lock Runtime barrier owner binding: %w", err)
	}
	return nil
}

func freezeRuntimeBarrierRecoveryTime(ctx context.Context, tx *databaseTransaction, input *ports.BeginAgentRebuild, policy domain.RuntimeBarrierRecoveryPolicy) (ports.RuntimeBarrierRecoveryReceipt, error) {
	if input.Operation.DrainDeadlineAt == nil || input.Now.IsZero() {
		return ports.RuntimeBarrierRecoveryReceipt{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	drainDuration := input.Operation.DrainDeadlineAt.Sub(input.Now)
	if drainDuration <= 0 {
		return ports.RuntimeBarrierRecoveryReceipt{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	var previousDeadline time.Time
	err := tx.QueryRow(ctx, `SELECT cooldown_until FROM agent_controller.runtime_barrier_recovery_cooldowns
WHERE agent_id=$1 FOR UPDATE`, input.AgentID).Scan(&previousDeadline)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return ports.RuntimeBarrierRecoveryReceipt{}, fmt.Errorf("lock Runtime barrier cooldown: %w", err)
	}
	// Acquire the journal lock before the acceptance clock. Waiting for an
	// unrelated event must not consume the cooldown or original drain duration.
	var journalSequence int64
	if err := tx.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.event_journal_cursor WHERE singleton FOR UPDATE`).Scan(&journalSequence); err != nil {
		return ports.RuntimeBarrierRecoveryReceipt{}, fmt.Errorf("lock Runtime barrier event journal: %w", err)
	}
	var acceptedAt time.Time
	if err := tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&acceptedAt); err != nil {
		return ports.RuntimeBarrierRecoveryReceipt{}, fmt.Errorf("freeze Runtime barrier acceptance: %w", err)
	}
	if acceptedAt.Before(previousDeadline) {
		return ports.RuntimeBarrierRecoveryReceipt{}, ports.ErrConcurrentChange
	}
	drainDeadline := acceptedAt.Add(drainDuration).UTC()
	input.Now = acceptedAt
	input.TargetSpec.CreatedAt = acceptedAt
	input.Operation.CreatedAt, input.Operation.UpdatedAt = acceptedAt, acceptedAt
	input.Operation.DrainDeadlineAt = &drainDeadline
	input.RequestedEvent.OccurredAt = acceptedAt
	// Avoid modifying the caller's shared map or drain-deadline pointer.
	data := make(map[string]any, len(input.RequestedEvent.Data)+1)
	for key, value := range input.RequestedEvent.Data {
		data[key] = value
	}
	data["rebuild_reason"] = ports.ExecutionRuntimeBarrierRequired
	input.RequestedEvent.Data = data
	return ports.RuntimeBarrierRecoveryReceipt{Fact: input.Recovery.Fact, Policy: policy, Manual: input.Recovery.Manual,
		Command: input.Recovery.Command, RequestFingerprint: input.Operation.RequestFingerprint,
		AcceptedAt: acceptedAt, CooldownUntil: acceptedAt.Add(time.Duration(policy.CooldownMS) * time.Millisecond)}, nil
}

func insertRuntimeBarrierRecovery(ctx context.Context, tx *databaseTransaction, receipt ports.RuntimeBarrierRecoveryReceipt) error {
	fact, command, policy := receipt.Fact, receipt.Command, receipt.Policy
	_, err := tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_receipts
(organization_id,agent_id,barrier_id,runtime_revision,runtime_execution_id,reason,request_id,request_fingerprint,
policy_revision,policy_mode,policy_cooldown_ms,actor_principal_id,template_id,template_revision,accepted_at,cooldown_until,manual)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		fact.OrganizationID, fact.AgentID, []byte(fact.Barrier.BarrierID), fact.RuntimeRevision,
		[]byte(fact.Barrier.RuntimeExecutionID), fact.Barrier.Reason, command.RequestID, receipt.RequestFingerprint,
		policy.Revision, policy.Mode, policy.CooldownMS, command.ActorPrincipalID, command.TemplateID,
		command.TemplateRevision, receipt.AcceptedAt, receipt.CooldownUntil, receipt.Manual)
	if err != nil {
		return fmt.Errorf("insert Runtime barrier recovery receipt: %w", err)
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_cooldowns
(agent_id,organization_id,request_id,accepted_at,cooldown_until) VALUES ($1,$2,$3,$4,$5)
ON CONFLICT (agent_id) DO UPDATE SET request_id=EXCLUDED.request_id,
accepted_at=EXCLUDED.accepted_at,cooldown_until=EXCLUDED.cooldown_until`,
		fact.AgentID, fact.OrganizationID, command.RequestID, receipt.AcceptedAt, receipt.CooldownUntil)
	if err != nil {
		return fmt.Errorf("save Runtime barrier recovery cooldown: %w", err)
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_starts (request_id) VALUES ($1)`, command.RequestID); err != nil {
		return fmt.Errorf("save Runtime barrier pending start: %w", err)
	}
	return nil
}
