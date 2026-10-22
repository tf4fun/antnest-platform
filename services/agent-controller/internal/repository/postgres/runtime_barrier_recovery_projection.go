package postgres

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var _ ports.RuntimeBarrierObservationStore = (*Repository)(nil)
var _ ports.RuntimeBarrierProjectionStore = (*Repository)(nil)

func (repository *Repository) GetRuntimeBarrierObservationRevision(ctx context.Context, organizationID, agentID string) (int64, error) {
	if !domain.ValidRuntimeBarrierPolicyIdentifier(organizationID) || !domain.ValidRuntimeBarrierPolicyIdentifier(agentID) {
		return 0, ports.ErrInvalidRuntimeBarrierRecovery
	}
	var revision int64
	err := repository.pool.QueryRow(ctx, `SELECT observation_revision FROM agent_controller.runtime_barrier_recovery_observations
WHERE organization_id=$1 AND agent_id=$2`, organizationID, agentID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("read Runtime barrier observation revision: %w", err)
	}
	if revision < 1 || revision > domain.RuntimeBarrierRecoveryMaxRevision {
		return 0, fmt.Errorf("invalid Runtime barrier observation revision")
	}
	return revision, nil
}

type runtimeBarrierObservation struct {
	revision int64
	source   ports.AgentRecord
	fact     ports.RuntimeBarrierResult
	policy   domain.RuntimeBarrierRecoveryPolicy
}

func sameRuntimeBarrierObservationSource(a, b ports.AgentRecord) bool {
	return a.OrganizationID == b.OrganizationID && a.AgentID == b.AgentID &&
		a.RuntimeRevision == b.RuntimeRevision && a.AgentSpecRevisionID == b.AgentSpecRevisionID &&
		a.ExecutionRevisionID == b.ExecutionRevisionID && a.AccessRevision == b.AccessRevision &&
		a.OwnerUserID == b.OwnerUserID && a.OwnerAuthorizationSequence == b.OwnerAuthorizationSequence &&
		a.IdentityRevocationSequence == b.IdentityRevocationSequence
}

func readRuntimeBarrierObservation(ctx context.Context, tx *databaseTransaction, agentID string) (runtimeBarrierObservation, bool, error) {
	var observation runtimeBarrierObservation
	var barrier, execution []byte
	a := &observation.source
	err := tx.QueryRow(ctx, `SELECT observation_revision, organization_id, agent_id, barrier_id, runtime_execution_id,
runtime_revision, agent_spec_revision_id, execution_revision_id, access_revision, owner_user_id,
owner_authorization_sequence, identity_revocation_sequence, policy_revision, policy_mode, policy_cooldown_ms
FROM agent_controller.runtime_barrier_recovery_observations WHERE agent_id=$1 FOR UPDATE`, agentID).Scan(
		&observation.revision, &a.OrganizationID, &a.AgentID, &barrier, &execution, &a.RuntimeRevision,
		&a.AgentSpecRevisionID, &a.ExecutionRevisionID, &a.AccessRevision, &a.OwnerUserID, &a.OwnerAuthorizationSequence,
		&a.IdentityRevocationSequence, &observation.policy.Revision, &observation.policy.Mode, &observation.policy.CooldownMS)
	if errors.Is(err, pgx.ErrNoRows) {
		return observation, false, nil
	}
	if err != nil {
		return observation, false, fmt.Errorf("read Runtime barrier observation: %w", err)
	}
	observation.policy.OrganizationID = a.OrganizationID
	observation.fact = ports.RuntimeBarrierResult{OrganizationID: a.OrganizationID, AgentID: a.AgentID, RuntimeRevision: a.RuntimeRevision}
	if barrier != nil {
		observation.fact.Barrier = &ports.RuntimeBarrier{BarrierID: string(barrier), RuntimeExecutionID: string(execution), Reason: ports.ExecutionRuntimeBarrierRequired}
	}
	if (barrier == nil) != (execution == nil) || observation.revision < 1 || observation.revision > domain.RuntimeBarrierRecoveryMaxRevision ||
		observation.policy.Validate() != nil || !observation.fact.Matches(ports.RuntimeBarrierQuery{OrganizationID: a.OrganizationID, AgentID: a.AgentID, ExpectedRuntimeRevision: a.RuntimeRevision}) {
		return runtimeBarrierObservation{}, false, fmt.Errorf("invalid persisted Runtime barrier observation")
	}
	return observation, true, nil
}

func (repository *Repository) RecordRuntimeBarrierObservation(ctx context.Context, input ports.RecordRuntimeBarrierObservation) error {
	if err := input.Validate(); err != nil {
		return err
	}
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Runtime barrier observation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	// Preserve admission lock order. No external query runs in this transaction.
	policy, err := lockRuntimeBarrierRecoveryPolicy(ctx, tx, &ports.RuntimeBarrierRecoveryIntent{
		Fact: input.Fact, ExpectedPolicyRevision: input.ExpectedPolicyRevision, Manual: true,
	})
	if err != nil {
		return err
	}
	if err = lockIdentityAdmission(ctx, tx); err != nil {
		return err
	}
	if err = lockAgentExecutionConfiguration(ctx, tx, input.ExpectedAgent.AgentID); err != nil {
		return err
	}
	agent, err := loadAgentRecordForUpdate(ctx, tx, input.ExpectedAgent.AgentID)
	if err != nil {
		return err
	}
	if !agent.CanObserveRuntime() || !sameRuntimeBarrierObservationSource(agent, input.ExpectedAgent) {
		return ports.ErrConcurrentChange
	}
	if err = validateOwnerWatermark(ctx, tx, agent.OwnerUserID, agent.OrganizationID, agent.OwnerAuthorizationSequence); err != nil {
		return err
	}
	var active bool
	err = tx.QueryRow(ctx, `SELECT active FROM agent_controller.agent_access_bindings
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 FOR UPDATE`, agent.AgentID, agent.OwnerUserID, agent.AccessRevision).Scan(&active)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && !active) {
		return ports.ErrConcurrentChange
	}
	if err != nil {
		return fmt.Errorf("lock Runtime barrier observation binding: %w", err)
	}
	previous, found, err := readRuntimeBarrierObservation(ctx, tx, agent.AgentID)
	if err != nil {
		return err
	}
	same := found && sameRuntimeBarrierObservationSource(previous.source, agent) && previous.policy == policy && reflect.DeepEqual(previous.fact, input.Fact)
	if !same {
		if previous.revision != input.ExpectedObservationRevision {
			return ports.ErrConcurrentChange
		}
		if previous.revision >= domain.RuntimeBarrierRecoveryMaxRevision {
			return fmt.Errorf("runtime barrier observation revision exhausted")
		}
		if err = writeRuntimeBarrierObservation(ctx, tx, input.Fact, agent, policy, previous.revision+1); err != nil {
			return err
		}
	}
	appended := false
	if input.Fact.Barrier != nil && policy.Mode == "notify" {
		appended, err = repository.ensureRuntimeBarrierNotification(ctx, tx, agent, input.Fact, policy)
		if err != nil {
			return err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Runtime barrier observation: %w", err)
	}
	if appended {
		repository.recordEventAppend(ctx, ports.EventAgentRuntimeBarrierRequired)
	}
	return nil
}

func writeRuntimeBarrierObservation(ctx context.Context, tx *databaseTransaction, fact ports.RuntimeBarrierResult, agent ports.AgentRecord, policy domain.RuntimeBarrierRecoveryPolicy, revision int64) error {
	var barrier, execution []byte
	if fact.Barrier != nil {
		barrier = []byte(fact.Barrier.BarrierID)
		execution = []byte(fact.Barrier.RuntimeExecutionID)
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_observations
(agent_id,organization_id,observation_revision,barrier_id,runtime_execution_id,runtime_revision,agent_spec_revision_id,
execution_revision_id,access_revision,owner_user_id,owner_authorization_sequence,identity_revocation_sequence,
policy_revision,policy_mode,policy_cooldown_ms,observed_at)
VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,clock_timestamp())
ON CONFLICT (agent_id) DO UPDATE SET organization_id=EXCLUDED.organization_id,observation_revision=EXCLUDED.observation_revision,
barrier_id=EXCLUDED.barrier_id,runtime_execution_id=EXCLUDED.runtime_execution_id,runtime_revision=EXCLUDED.runtime_revision,
agent_spec_revision_id=EXCLUDED.agent_spec_revision_id,execution_revision_id=EXCLUDED.execution_revision_id,
access_revision=EXCLUDED.access_revision,owner_user_id=EXCLUDED.owner_user_id,owner_authorization_sequence=EXCLUDED.owner_authorization_sequence,
identity_revocation_sequence=EXCLUDED.identity_revocation_sequence,policy_revision=EXCLUDED.policy_revision,
policy_mode=EXCLUDED.policy_mode,policy_cooldown_ms=EXCLUDED.policy_cooldown_ms,observed_at=EXCLUDED.observed_at`,
		agent.AgentID, agent.OrganizationID, revision, barrier, execution, agent.RuntimeRevision, agent.AgentSpecRevisionID,
		agent.ExecutionRevisionID, agent.AccessRevision, agent.OwnerUserID, agent.OwnerAuthorizationSequence, agent.IdentityRevocationSequence,
		policy.Revision, policy.Mode, policy.CooldownMS)
	if err != nil {
		return fmt.Errorf("persist Runtime barrier observation: %w", err)
	}
	return nil
}

func (repository *Repository) GetRuntimeBarrierRecoveryProjection(ctx context.Context, agent ports.AgentRecord) (*ports.RuntimeBarrierRecoveryProjection, error) {
	// A single database snapshot fences the stored observation against both the
	// caller's source and current authorization. An active original Rebuild can
	// still show its reason and original cooldown until it replaces that source.
	var projection ports.RuntimeBarrierRecoveryProjection
	var barrier []byte
	var deadline *time.Time
	err := repository.pool.QueryRow(ctx, `SELECT o.barrier_id,o.runtime_revision,o.policy_revision,o.policy_mode,o.policy_cooldown_ms,c.cooldown_until
FROM agent_controller.runtime_barrier_recovery_observations o
JOIN agent_controller.agents a ON a.id=o.agent_id AND a.organization_id=o.organization_id
JOIN agent_controller.agent_access_bindings b ON b.agent_id=a.id AND b.principal_id=a.owner_user_id AND b.access_revision=a.access_revision AND b.active
LEFT JOIN agent_controller.runtime_barrier_recovery_cooldowns c ON c.agent_id=a.id
WHERE a.organization_id=$1 AND a.id=$2 AND o.barrier_id IS NOT NULL
AND a.runtime_revision=$3 AND a.executable_spec_revision_id=$4 AND a.executable_execution_revision_id=$5
AND a.access_revision=$6 AND a.owner_user_id=$7 AND a.owner_authorization_sequence=$8 AND a.identity_revocation_sequence=$9
AND o.runtime_revision=a.runtime_revision AND o.agent_spec_revision_id=a.executable_spec_revision_id
AND o.execution_revision_id=a.executable_execution_revision_id AND o.access_revision=a.access_revision
AND o.owner_user_id=a.owner_user_id AND o.owner_authorization_sequence=a.owner_authorization_sequence
AND o.identity_revocation_sequence=a.identity_revocation_sequence
AND a.lifecycle_state='created' AND a.activation_state='enabled' AND a.desired_state='enabled'
AND a.failure_code<>'lifecycle_invariant_failed' AND a.identity_revocation_sequence<=a.owner_authorization_sequence
AND NOT EXISTS (SELECT 1 FROM agent_controller.owner_revocations r WHERE r.user_id=a.owner_user_id
 AND r.organization_id IN ('',a.organization_id) AND r.sequence>a.owner_authorization_sequence)`,
		agent.OrganizationID, agent.AgentID, agent.RuntimeRevision, agent.AgentSpecRevisionID, agent.ExecutionRevisionID,
		agent.AccessRevision, agent.OwnerUserID, agent.OwnerAuthorizationSequence, agent.IdentityRevocationSequence).Scan(
		&barrier, &projection.RuntimeRevision, &projection.PolicyRevision, &projection.Mode, &projection.CooldownMS, &deadline)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read Runtime barrier recovery projection: %w", err)
	}
	projection.BarrierID = string(barrier)
	projection.Reason = ports.ExecutionRuntimeBarrierRequired
	projection.RebuildRequestID, err = ports.RuntimeBarrierRecoveryRequestID(agent.OrganizationID, agent.AgentID, projection.BarrierID)
	if err != nil {
		return nil, err
	}
	projection.NotificationID, err = ports.RuntimeBarrierNotificationID(agent.OrganizationID, agent.AgentID, projection.BarrierID)
	if err != nil {
		return nil, err
	}
	if deadline != nil {
		utc := deadline.UTC()
		projection.CooldownUntil = &utc
	}
	if err = projection.Validate(agent.OrganizationID, agent.AgentID); err != nil {
		return nil, fmt.Errorf("invalid persisted Runtime barrier recovery projection: %w", err)
	}
	return &projection, nil
}
