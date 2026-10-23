package postgres

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func runtimeReadinessData(agent ports.AgentRecord, threshold, applied int64) map[string]any {
	data := map[string]any{
		"organization_id": agent.OrganizationID, "agent_spec_revision_id": agent.AgentSpecRevisionID,
		"execution_revision_id": agent.ExecutionRevisionID, "runtime_revision": agent.RuntimeRevision,
		"ready_after_revision": threshold,
	}
	if applied > 0 {
		data["applied_revision"] = applied
	}
	return data
}

func insertRuntimeReadiness(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord, threshold int64, now time.Time) error {
	_, err := tx.Exec(ctx, `
INSERT INTO agent_controller.agent_runtime_readiness (
 agent_id, organization_id, execution_revision_id, agent_spec_revision_id,
 runtime_revision, runtime_execution_id, owner_user_id, access_revision,
 owner_authorization_sequence, ready_after_revision, bound_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
		agent.AgentID, agent.OrganizationID, agent.ExecutionRevisionID, agent.AgentSpecRevisionID,
		agent.RuntimeRevision, agent.RuntimeExecutionID, agent.OwnerUserID, agent.AccessRevision,
		agent.OwnerAuthorizationSequence, threshold, now)
	if err != nil {
		return fmt.Errorf("insert Runtime readiness threshold: %w", err)
	}
	return nil
}

type runtimeReadinessCandidate struct {
	agent       ports.AgentRecord
	threshold   int64
	reopenAfter int64
	readyAt     *time.Time
	missing     bool
}

// All Agent locks precede the first journal append. The caller already holds
// Identity admission and the organization publication lock.
func lockRuntimeReadinessCandidates(ctx context.Context, tx *databaseTransaction, organization string) ([]runtimeReadinessCandidate, error) {
	rows, err := tx.Query(ctx, `SELECT id FROM agent_controller.agents
WHERE organization_id=$1 AND executable_execution_revision_id<>'' ORDER BY id FOR UPDATE`, organization)
	if err != nil {
		return nil, fmt.Errorf("lock Runtime readiness Agents: %w", err)
	}
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, fmt.Errorf("read Runtime readiness Agents: %w", err)
	}
	result := make([]runtimeReadinessCandidate, 0, len(ids))
	for _, id := range ids {
		agent, err := loadAgentRecord(ctx, tx, id)
		if err != nil {
			return nil, err
		}
		if !agent.ExecutionReady() {
			continue
		}
		if err := validateOwnerWatermark(ctx, tx, agent.OwnerUserID, agent.OrganizationID, agent.OwnerAuthorizationSequence); err != nil {
			if errors.Is(err, ports.ErrConcurrentChange) {
				continue
			}
			return nil, err
		}
		access, err := loadOwnerAccess(ctx, tx, id, agent.OwnerUserID)
		if errors.Is(err, ports.ErrNotFound) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if !access.Active || access.AccessRevision != agent.AccessRevision {
			continue
		}
		execution, err := loadOptionalExecutionRevision(ctx, tx, agent.ExecutionRevisionID)
		if err != nil {
			return nil, err
		}
		if execution.ID == "" || execution.AgentID != id || execution.AgentSpecRevisionID != agent.AgentSpecRevisionID ||
			execution.RuntimeRevision != agent.RuntimeRevision || execution.RuntimeExecutionID != agent.RuntimeExecutionID ||
			execution.RuntimeMCPEndpoint != agent.RuntimeMCPEndpoint {
			return nil, ports.ErrConcurrentChange
		}
		candidate := runtimeReadinessCandidate{agent: agent}
		var proof ports.AgentRecord
		err = tx.QueryRow(ctx, `SELECT organization_id, agent_spec_revision_id, runtime_revision,
runtime_execution_id, owner_user_id, access_revision, owner_authorization_sequence,
ready_after_revision, reopen_after_revision, ready_at FROM agent_controller.agent_runtime_readiness
WHERE agent_id=$1 AND execution_revision_id=$2 FOR UPDATE`, id, agent.ExecutionRevisionID).Scan(
			&proof.OrganizationID, &proof.AgentSpecRevisionID, &proof.RuntimeRevision, &proof.RuntimeExecutionID,
			&proof.OwnerUserID, &proof.AccessRevision, &proof.OwnerAuthorizationSequence, &candidate.threshold, &candidate.reopenAfter, &candidate.readyAt)
		if errors.Is(err, pgx.ErrNoRows) {
			candidate.missing = true
		} else if err != nil {
			return nil, fmt.Errorf("read Runtime readiness threshold: %w", err)
		} else if proof.OrganizationID != agent.OrganizationID || proof.AgentSpecRevisionID != agent.AgentSpecRevisionID ||
			proof.RuntimeRevision != agent.RuntimeRevision || proof.RuntimeExecutionID != agent.RuntimeExecutionID ||
			proof.OwnerUserID != agent.OwnerUserID || proof.AccessRevision != agent.AccessRevision ||
			proof.OwnerAuthorizationSequence != agent.OwnerAuthorizationSequence {
			return nil, ports.ErrConcurrentChange
		}
		result = append(result, candidate)
	}
	return result, nil
}

func (repository *Repository) appendRuntimeReadinessEvent(ctx context.Context, tx *databaseTransaction, candidate runtimeReadinessCandidate, applied int64, now time.Time) error {
	eventType, kind := ports.EventRuntimeBound, "event-bound-bootstrap"
	if applied > 0 {
		eventType, kind = ports.EventAgentReady, "event-ready-applied"
	}
	agent := candidate.agent
	event := ports.AgentEventRecord{
		EventID: domain.DeriveResourceID("event", kind, agent.ExecutionRevisionID),
		AgentID: agent.AgentID, AggregateSequence: agent.AggregateSequence + 1, SchemaVersion: 2,
		EventType: eventType, OccurredAt: now, Data: runtimeReadinessData(agent, candidate.threshold, applied),
	}
	result, err := tx.Exec(ctx, `UPDATE agent_controller.agents SET aggregate_sequence=$2,updated_at=$3
WHERE id=$1 AND aggregate_sequence=$4`, agent.AgentID, event.AggregateSequence, now, agent.AggregateSequence)
	if err != nil {
		return fmt.Errorf("advance Agent readiness aggregate: %w", err)
	}
	if result.RowsAffected() != 1 {
		return ports.ErrConcurrentChange
	}
	return repository.insertAgentEvent(ctx, tx, event)
}

// The acknowledgement was validated against the pre-bootstrap revision. Old
// ACKs cannot establish proof for legacy bindings that have never had a bound
// threshold. Republish them once, without closing their executable snapshots.
func (repository *Repository) applyRuntimeReadiness(ctx context.Context, tx *databaseTransaction, acknowledgement ports.ExecutionAcknowledgement, candidates []runtimeReadinessCandidate) ([]string, error) {
	bootstrap := false
	for _, candidate := range candidates {
		bootstrap = bootstrap || candidate.missing
	}
	var threshold int64
	if bootstrap {
		if err := repository.advanceExecutionRevision(ctx, tx, acknowledgement.OrganizationID); err != nil {
			return nil, err
		}
		if err := tx.QueryRow(ctx, executionRevisionQuery, acknowledgement.OrganizationID).Scan(&threshold); err != nil {
			return nil, fmt.Errorf("read legacy binding publication revision: %w", err)
		}
	}
	now := time.Now().UTC()
	events := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if candidate.missing {
			candidate.threshold = threshold
			if err := insertRuntimeReadiness(ctx, tx, candidate.agent, threshold, now); err != nil {
				return nil, err
			}
			if err := repository.appendRuntimeReadinessEvent(ctx, tx, candidate, 0, now); err != nil {
				return nil, err
			}
			events = append(events, ports.EventRuntimeBound)
			continue
		}
		if candidate.readyAt != nil || acknowledgement.AppliedRevision < max(candidate.threshold, candidate.reopenAfter) {
			continue
		}
		result, err := tx.Exec(ctx, `UPDATE agent_controller.agent_runtime_readiness SET applied_revision=$3,ready_at=$4
WHERE agent_id=$1 AND execution_revision_id=$2 AND ready_at IS NULL`,
			candidate.agent.AgentID, candidate.agent.ExecutionRevisionID, acknowledgement.AppliedRevision, now)
		if err != nil {
			return nil, fmt.Errorf("confirm Runtime readiness: %w", err)
		}
		if result.RowsAffected() != 1 {
			return nil, ports.ErrConcurrentChange
		}
		if err := repository.appendRuntimeReadinessEvent(ctx, tx, candidate, acknowledgement.AppliedRevision, now); err != nil {
			return nil, err
		}
		events = append(events, ports.EventAgentReady)
	}
	return events, nil
}
