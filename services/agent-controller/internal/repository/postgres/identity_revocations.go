package postgres

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (repository *Repository) GetIdentityRevocationCursor(ctx context.Context) (int64, error) {
	var sequence int64
	err := repository.pool.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.identity_revocation_cursor WHERE singleton`).Scan(&sequence)
	if err != nil {
		return 0, fmt.Errorf("load Identity revocation cursor: %w", err)
	}
	return sequence, nil
}

// Admission readers share this lock. Receipt serializes only the brief local
// commit boundary, never an Identity RPC or a Runtime operation.
func lockIdentityAdmission(ctx context.Context, tx pgx.Tx) error {
	var sequence int64
	if err := tx.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.identity_revocation_cursor WHERE singleton FOR SHARE`).Scan(&sequence); err != nil {
		return fmt.Errorf("lock Identity admission boundary: %w", err)
	}
	return nil
}

func validateOwnerWatermark(ctx context.Context, tx pgx.Tx, userID, orgID string, authorization int64) error {
	var revoked int64
	if err := tx.QueryRow(ctx, `SELECT COALESCE(MAX(sequence), 0) FROM agent_controller.owner_revocations
WHERE user_id=$1 AND organization_id IN ('', $2)`, userID, orgID).Scan(&revoked); err != nil {
		return fmt.Errorf("load owner revocation watermark: %w", err)
	}
	if authorization < revoked || authorization < 0 {
		return ports.ErrConcurrentChange
	}
	return nil
}

func (repository *Repository) ApplyIdentityRevocation(
	ctx context.Context, expected int64, event ports.PrincipalRevocation, traceID string,
) error {
	tx, err := repository.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin Identity revocation: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var cursor int64
	if err := tx.QueryRow(ctx, `SELECT last_sequence FROM agent_controller.identity_revocation_cursor WHERE singleton FOR UPDATE`).Scan(&cursor); err != nil {
		return fmt.Errorf("lock Identity receipt: %w", err)
	}
	if event.Sequence <= cursor {
		return nil
	}
	if cursor != expected {
		return ports.ErrConcurrentChange
	}
	if _, err := tx.Exec(ctx, `INSERT INTO agent_controller.owner_revocations
(user_id, organization_id, sequence, reason, occurred_at, trace_parent) VALUES ($1,$2,$3,$4,$5,$6)
ON CONFLICT (user_id, organization_id) DO UPDATE SET sequence=EXCLUDED.sequence,
reason=EXCLUDED.reason, occurred_at=EXCLUDED.occurred_at, trace_parent=EXCLUDED.trace_parent`,
		event.UserID, event.OrganizationID, event.Sequence, event.Reason, event.OccurredAt, event.TraceParent); err != nil {
		return fmt.Errorf("persist owner revocation: %w", err)
	}
	agents, err := lockRevokedAgents(ctx, tx, event)
	if err != nil {
		return err
	}
	for _, agent := range agents {
		if err := repository.fenceRevokedAgent(ctx, tx, agent, event, traceID); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.identity_revocation_cursor SET last_sequence=$1 WHERE singleton`, event.Sequence); err != nil {
		return fmt.Errorf("advance Identity cursor: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit Identity revocation: %w", err)
	}
	for range agents {
		repository.recordEventAppend(ctx, ports.EventAgentOwnerRevoked)
	}
	return nil
}

type revokedAgent struct {
	id        string
	aggregate int64
}

func lockRevokedAgents(ctx context.Context, tx pgx.Tx, event ports.PrincipalRevocation) ([]revokedAgent, error) {
	rows, err := tx.Query(ctx, `SELECT id, aggregate_sequence FROM agent_controller.agents
WHERE owner_user_id=$1 AND ($2='' OR organization_id=$2) AND lifecycle_state <> 'deleted'
AND owner_authorization_sequence < $3 AND identity_revocation_sequence < $3 ORDER BY id FOR UPDATE`,
		event.UserID, event.OrganizationID, event.Sequence)
	if err != nil {
		return nil, fmt.Errorf("lock revoked Agents: %w", err)
	}
	defer rows.Close()
	agents, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (revokedAgent, error) {
		var agent revokedAgent
		err := row.Scan(&agent.id, &agent.aggregate)
		return agent, err
	})
	if err != nil {
		return nil, fmt.Errorf("read revoked Agents: %w", err)
	}
	return agents, nil
}

func (repository *Repository) fenceRevokedAgent(ctx context.Context, tx pgx.Tx, agent revokedAgent, event ports.PrincipalRevocation, traceID string) error {
	if _, err := tx.Exec(ctx, `UPDATE agent_controller.agents SET identity_revocation_sequence=$2,
desired_state=CASE WHEN active_operation_request_id='' AND desired_state <> 'deleted' THEN 'disabled' ELSE desired_state END,
aggregate_sequence=aggregate_sequence+1, updated_at=clock_timestamp() WHERE id=$1`, agent.id, event.Sequence); err != nil {
		return fmt.Errorf("fence revoked Agent: %w", err)
	}
	return repository.insertAgentEvent(ctx, tx, ports.AgentEventRecord{
		EventID: fmt.Sprintf("identity-revocation-%d-%s", event.Sequence, agent.id),
		AgentID: agent.id, AggregateSequence: agent.aggregate + 1, SchemaVersion: 1,
		EventType: ports.EventAgentOwnerRevoked, TraceID: traceID, OccurredAt: event.OccurredAt,
		Data: map[string]any{"identity_revocation_sequence": event.Sequence, "reason": event.Reason,
			"owner_user_id": event.UserID, "organization_id": event.OrganizationID},
	})
}

func (repository *Repository) ListPendingOwnerRevocations(ctx context.Context, after string, limit int) ([]ports.PendingOwnerRevocation, error) {
	if limit < 1 || limit > 500 {
		return nil, fmt.Errorf("invalid pending offboarding limit")
	}
	rows, err := repository.pool.Query(ctx, `SELECT a.id, a.identity_revocation_sequence, a.aggregate_sequence, r.trace_parent
FROM agent_controller.agents a JOIN agent_controller.owner_revocations r ON r.sequence=a.identity_revocation_sequence
WHERE a.identity_revocation_sequence>a.owner_authorization_sequence AND a.lifecycle_state NOT IN ('deleted','disabled')
AND NOT EXISTS (SELECT 1 FROM agent_controller.agent_lifecycle_operations o WHERE o.agent_id=a.id
    AND o.kind='disable' AND o.state='failed' AND o.owner_revocation_sequence=a.identity_revocation_sequence
    AND o.updated_at > clock_timestamp() - interval '30 seconds')
AND a.id>$1 ORDER BY a.id LIMIT $2`, after, limit)
	if err != nil {
		return nil, fmt.Errorf("list pending owner revocations: %w", err)
	}
	defer rows.Close()
	result, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (ports.PendingOwnerRevocation, error) {
		var item ports.PendingOwnerRevocation
		err := row.Scan(&item.AgentID, &item.Sequence, &item.AggregateSequence, &item.TraceParent)
		return item, err
	})
	if err != nil {
		return nil, fmt.Errorf("read pending owner revocations: %w", err)
	}
	return result, nil
}

var _ ports.IdentityRevocationStore = (*Repository)(nil)
