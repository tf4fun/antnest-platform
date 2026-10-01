package application

import (
	"context"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

var _ ports.LifecycleExecution = (*ExecutionPublisher)(nil)

func (publisher *ExecutionPublisher) CloseAndSettle(ctx context.Context, request ports.LifecycleSettlementRequest) (ports.AgentSettlementResult, error) {
	if !validIdentifier(request.OrganizationID) || !validIdentifier(request.AgentID) || !validIdentifier(request.OperationID) || request.DeadlineAt.IsZero() {
		return ports.AgentSettlementResult{}, ports.ErrInvalidExecutionConfiguration
	}
	if request.Mode != "wait" && request.Mode != "cancel" {
		return ports.AgentSettlementResult{}, ports.ErrInvalidExecutionConfiguration
	}
	ctx, cancel := context.WithDeadline(ctx, request.DeadlineAt)
	defer cancel()
	acknowledgement, err := publisher.publish(ctx, request.OrganizationID, &request)
	if err != nil {
		return ports.AgentSettlementResult{}, err
	}
	if err := ctx.Err(); err != nil {
		return ports.AgentSettlementResult{}, err
	}
	// Waiting must not hold the organization's publication gate.
	return publisher.client.SettleAgent(ctx, ports.AgentSettlementRequest{
		OrganizationID: request.OrganizationID, AgentID: request.AgentID,
		OperationID: request.OperationID, MinimumRevision: acknowledgement.AppliedRevision,
		Mode: request.Mode, DeadlineAt: request.DeadlineAt,
	})
}

func currentSettlementOperation(source ports.ExecutionSource, request ports.LifecycleSettlementRequest) bool {
	for _, item := range source.Agents {
		if item.Agent.AgentID == request.AgentID {
			return item.Agent.ActiveOperationRequestID == request.OperationID && !item.Agent.ExecutionReady()
		}
	}
	return false
}
