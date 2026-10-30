package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// loadFailedCreateRebuildSource returns the sole failed create operation that
// never passed network_ensure and left no execution or readiness evidence. It
// is initialization-retry eligibility, never a resource-absence claim.
func loadFailedCreateRebuildSource(
	ctx context.Context, queryer catalogQueryer, agent ports.AgentRecord,
) (*ports.LifecycleOperationRecord, error) {
	if agent.LifecycleState != domain.AgentNotCreated ||
		agent.DesiredState != domain.DesiredEnabled || agent.IdentityRevoked() ||
		agent.ActiveOperationRequestID != "" || agent.RuntimeRevision != "" ||
		agent.RuntimeExecutionID != "" || agent.RuntimeMCPEndpoint != "" ||
		agent.ExecutionRevisionID != "" || agent.LastSuccessfulExecutionRevisionID != "" ||
		agent.FailureCode == "lifecycle_cancelled" ||
		agent.FailureCode == "lifecycle_invariant_failed" {
		return nil, nil
	}
	var requestID string
	err := queryer.QueryRow(ctx, `
SELECT o.request_id FROM agent_controller.agent_lifecycle_operations o
WHERE o.agent_id=$1 AND o.kind='create' AND o.state='failed' AND o.phase='network_ensure'
 AND o.error_code NOT IN ('lifecycle_cancelled','lifecycle_invariant_failed')
 AND NOT EXISTS (SELECT 1 FROM agent_controller.agent_lifecycle_operations other WHERE other.agent_id=o.agent_id AND other.request_id<>o.request_id)
 AND NOT EXISTS (SELECT 1 FROM agent_controller.execution_revisions e WHERE e.agent_id=o.agent_id)
 AND NOT EXISTS (SELECT 1 FROM agent_controller.agent_events ev WHERE ev.agent_id=o.agent_id AND ev.event_type IN ('agent_ready','runtime_bound'))`,
		agent.AgentID).Scan(&requestID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	operation, err := loadLifecycleOperation(ctx, queryer, requestID, "")
	if err != nil {
		return nil, err
	}
	return &operation, nil
}

// failedCreateRebuildMatches replaces the ordinary source checks for a
// failed-create initialization retry: the locked Agent plus the stored failed
// create must still form a valid retry source.
func failedCreateRebuildMatches(agent ports.AgentRecord, input ports.BeginAgentRebuild) bool {
	return agent.DesiredState == domain.DesiredEnabled && !agent.IdentityRevoked() &&
		agent.LifecycleState == domain.AgentNotCreated && agent.ActiveOperationRequestID == "" &&
		agent.RuntimeRevision == "" && agent.RuntimeExecutionID == "" &&
		agent.RuntimeMCPEndpoint == "" &&
		agent.ExecutionRevisionID == "" && agent.LastSuccessfulExecutionRevisionID == "" &&
		agent.FailureCode != "lifecycle_cancelled" &&
		agent.FailureCode != "lifecycle_invariant_failed" &&
		agent.AggregateSequence == input.ExpectedAggregateSequence &&
		(agent.AgentSpecRevisionID == "" || agent.AgentSpecRevisionID == input.ExpectedSpecRevisionID)
}
