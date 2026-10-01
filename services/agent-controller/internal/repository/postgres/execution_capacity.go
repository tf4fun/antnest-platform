package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func WithExecutionCapacityGuard(guard ports.ExecutionCapacityGuard) Option {
	return func(repository *Repository) { repository.executionCapacity = guard }
}

// The observer must only enqueue a nonblocking local hint, never publish or query.
func WithExecutionChangeObserver(observer func(context.Context, string)) Option {
	return func(repository *Repository) { repository.executionChanged = observer }
}

func (repository *Repository) advanceExecutionRevision(ctx context.Context, tx *databaseTransaction, organizationID string) error {
	if repository.executionCapacity != nil {
		if err := repository.validateExecutionCapacity(ctx, tx, organizationID); err != nil {
			return err
		}
	}
	if err := advanceExecutionRevision(ctx, tx, organizationID); err != nil {
		return err
	}
	if observer := repository.executionChanged; observer != nil {
		parent := trace.SpanContextFromContext(ctx)
		tx.afterCommit = append(tx.afterCommit, func() {
			observer(trace.ContextWithSpanContext(context.Background(), parent), organizationID)
		})
	}
	return nil
}

func (repository *Repository) validateExecutionCapacity(ctx context.Context, tx *databaseTransaction, organizationID string) error {
	current, err := readExecutionSource(ctx, tx, organizationID, ports.MaximumExecutionRevision)
	if err != nil {
		return err
	}
	targets, err := readExecutionCapacityTargets(ctx, tx, organizationID)
	if err != nil {
		return err
	}
	return repository.executionCapacity.ValidateExecutionCapacity(ctx, ports.ExecutionCapacityInput{Current: current, Targets: targets})
}

func readExecutionCapacityTargets(ctx context.Context, tx *databaseTransaction, organizationID string) ([]ports.AgentSpecRecord, error) {
	rows, err := tx.Query(ctx, `SELECT s.id, s.agent_id, s.revision, s.snapshot
FROM agent_controller.agents a
JOIN agent_controller.agent_lifecycle_operations o ON o.request_id=a.active_operation_request_id AND o.agent_id=a.id AND o.state='running'
LEFT JOIN agent_controller.agent_spec_revisions s ON s.id=o.target_spec_revision_id AND s.agent_id=a.id
WHERE a.organization_id=$1 AND a.lifecycle_state<>'deleted' AND o.target_spec_revision_id<>''
ORDER BY a.id`, organizationID)
	if err != nil {
		return nil, fmt.Errorf("read execution capacity targets: %w", err)
	}
	defer rows.Close()
	targets := []ports.AgentSpecRecord{}
	for rows.Next() {
		var target ports.AgentSpecRecord
		var snapshot []byte
		if err := rows.Scan(&target.ID, &target.AgentID, &target.Revision, &snapshot); err != nil {
			return nil, fmt.Errorf("scan execution capacity target: %w", err)
		}
		if err := json.Unmarshal(snapshot, &target.Snapshot); err != nil {
			return nil, fmt.Errorf("decode execution capacity target: %w", err)
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate execution capacity targets: %w", err)
	}
	return targets, nil
}
