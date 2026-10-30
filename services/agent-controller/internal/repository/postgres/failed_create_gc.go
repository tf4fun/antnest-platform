package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// ListFailedCreateGCCandidates returns Agents whose only lifecycle operation
// is a failed create older than the cutoff. The predicate enforces: never
// ready, no execution history, no active operation, desired state not deleted,
// and no additional lifecycle operations.
func (repository *Repository) ListFailedCreateGCCandidates(
	ctx context.Context, cutoff time.Time, limit int,
) ([]ports.FailedCreateGCCandidate, error) {
	if cutoff.IsZero() || limit < 1 || limit > 500 {
		return nil, fmt.Errorf("failed-create GC cutoff or limit is invalid")
	}
	rows, err := repository.pool.Query(ctx, `
SELECT a.id, a.organization_id, o.request_id, a.aggregate_sequence
FROM agent_controller.agents a
JOIN agent_controller.agent_lifecycle_operations o ON o.agent_id = a.id
WHERE o.kind = 'create' AND o.state = 'failed' AND o.updated_at <= $1
  AND a.lifecycle_state = 'not_created' AND a.desired_state <> 'deleted'
  AND a.active_operation_request_id = '' AND a.executable_execution_revision_id = ''
  AND a.last_successful_execution_revision_id = ''
  AND NOT EXISTS (SELECT 1 FROM agent_controller.agent_lifecycle_operations other WHERE other.agent_id = a.id AND other.request_id <> o.request_id)
  AND NOT EXISTS (SELECT 1 FROM agent_controller.execution_revisions e WHERE e.agent_id = a.id)
  AND NOT EXISTS (SELECT 1 FROM agent_controller.agent_events ev WHERE ev.agent_id = a.id AND ev.event_type IN ('agent_ready', 'runtime_bound'))
ORDER BY o.updated_at, a.id LIMIT $2`,
		cutoff, limit)
	if err != nil {
		return nil, fmt.Errorf("list failed-create GC candidates: %w", err)
	}
	defer rows.Close()
	candidates := []ports.FailedCreateGCCandidate{}
	for rows.Next() {
		var candidate ports.FailedCreateGCCandidate
		if err := rows.Scan(&candidate.AgentID, &candidate.OrganizationID,
			&candidate.CreateRequestID, &candidate.AggregateSequence); err != nil {
			return nil, fmt.Errorf("scan failed-create GC candidate: %w", err)
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate failed-create GC candidates: %w", err)
	}
	return candidates, nil
}
