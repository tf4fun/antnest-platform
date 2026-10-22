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

// The Agent row is already locked. Notification identity and journal append are
// committed together, independently of the recovery operation/receipt tables.
func (repository *Repository) ensureRuntimeBarrierNotification(ctx context.Context, tx *databaseTransaction, agent ports.AgentRecord, fact ports.RuntimeBarrierResult, policy domain.RuntimeBarrierRecoveryPolicy) (bool, error) {
	eventID, err := ports.RuntimeBarrierNotificationID(agent.OrganizationID, agent.AgentID, fact.Barrier.BarrierID)
	if err != nil {
		return false, err
	}
	existing, err := scanAgentEvent(tx.QueryRow(ctx, agentEventSelect+`
WHERE notice.organization_id=$1 AND notice.agent_id=$2 AND notice.barrier_id=$3`,
		agent.OrganizationID, agent.AgentID, []byte(fact.Barrier.BarrierID)))
	if err == nil {
		// Later policy updates never replace or republish the original notification.
		if existing.EventID != eventID || existing.EventType != ports.EventAgentRuntimeBarrierRequired || existing.Data["runtime_revision"] != fact.RuntimeRevision {
			return false, ports.ErrConcurrentChange
		}
		return false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return false, err
	}
	var occurredAt time.Time
	if err = tx.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&occurredAt); err != nil {
		return false, fmt.Errorf("freeze Runtime barrier notification time: %w", err)
	}
	changed, err := tx.Exec(ctx, `UPDATE agent_controller.agents SET aggregate_sequence=aggregate_sequence+1,updated_at=$2
WHERE id=$1 AND aggregate_sequence=$3`, agent.AgentID, occurredAt, agent.AggregateSequence)
	if err != nil {
		return false, fmt.Errorf("advance Runtime barrier notification aggregate: %w", err)
	}
	if changed.RowsAffected() != 1 {
		return false, ports.ErrConcurrentChange
	}
	event := ports.AgentEventRecord{EventID: eventID, AgentID: agent.AgentID, AggregateSequence: agent.AggregateSequence + 1,
		SchemaVersion: 1, EventType: ports.EventAgentRuntimeBarrierRequired, OccurredAt: occurredAt,
		Data: map[string]any{"organization_id": agent.OrganizationID, "runtime_revision": fact.RuntimeRevision,
			"reason": ports.ExecutionRuntimeBarrierRequired, "policy_revision": policy.Revision}}
	if err = repository.insertAgentEvent(ctx, tx, event); err != nil {
		return false, err
	}
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_notifications
(organization_id,agent_id,barrier_id,event_id,runtime_revision,policy_revision) VALUES($1,$2,$3,$4,$5,$6)`,
		agent.OrganizationID, agent.AgentID, []byte(fact.Barrier.BarrierID), eventID, fact.RuntimeRevision, policy.Revision)
	if err != nil {
		return false, fmt.Errorf("persist Runtime barrier notification identity: %w", err)
	}
	return true, nil
}

type runtimeBarrierNotificationExtension struct {
	eventID         *string
	organizationID  *string
	runtimeRevision *string
	policyRevision  *int64
	barrierID       []byte
}

func hydrateRuntimeBarrierNotification(record *ports.AgentEventRecord, extension runtimeBarrierNotificationExtension) error {
	if record.EventType != ports.EventAgentRuntimeBarrierRequired {
		if extension.eventID != nil {
			return fmt.Errorf("unexpected Runtime barrier extension on historical Agent event")
		}
		return nil
	}
	if extension.eventID == nil || extension.organizationID == nil || extension.runtimeRevision == nil || extension.policyRevision == nil ||
		record.SchemaVersion != 1 || record.OperationRequestID != "" || len(record.Data) != 4 {
		return fmt.Errorf("incomplete Runtime barrier notification")
	}
	organization, runtime, policy := *extension.organizationID, *extension.runtimeRevision, *extension.policyRevision
	expected, err := ports.RuntimeBarrierNotificationID(organization, record.AgentID, string(extension.barrierID))
	if err != nil || *extension.eventID != record.EventID || expected != record.EventID ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(runtime) || policy < 0 || policy > domain.RuntimeBarrierRecoveryMaxRevision ||
		record.Data["organization_id"] != organization || record.Data["runtime_revision"] != runtime ||
		record.Data["reason"] != ports.ExecutionRuntimeBarrierRequired || record.Data["policy_revision"] != float64(policy) {
		return fmt.Errorf("invalid persisted Runtime barrier notification")
	}
	record.Data["barrier_id"] = string(extension.barrierID)
	return nil
}
