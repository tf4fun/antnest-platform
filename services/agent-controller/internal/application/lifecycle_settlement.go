package application

import (
	"context"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func (service *LifecycleService) drainDeadline(now time.Time) *time.Time {
	deadline := now.Add(service.drainTimeout).UTC().Truncate(time.Microsecond)
	return &deadline
}

func (service *LifecycleService) settleLifecycleExecution(ctx context.Context, agent ports.AgentRecord, operation ports.LifecycleOperationRecord) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if operation.DrainDeadlineAt == nil {
		return "", fmt.Errorf("lifecycle operation has no drain deadline")
	}
	if !service.clock.Now().Before(*operation.DrainDeadlineAt) {
		return "", context.DeadlineExceeded
	}
	if service.execution == nil {
		return "", fmt.Errorf("%w: ACP lifecycle execution is not configured", ErrDependencyUnavailable)
	}
	mode := "wait"
	if operation.Kind == domain.OperationDelete || operation.OwnerRevocationSequence > 0 || agent.IdentityRevoked() {
		mode = "cancel"
	}
	result, err := service.execution.CloseAndSettle(ctx, ports.LifecycleSettlementRequest{
		OrganizationID: agent.OrganizationID, AgentID: agent.AgentID,
		OperationID: operation.RequestID, Mode: mode, DeadlineAt: *operation.DrainDeadlineAt,
	})
	if err != nil {
		return "", err
	}
	switch result.Outcome {
	case ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired, ports.ExecutionNotSettled:
		return result.Outcome, nil
	default:
		return "", fmt.Errorf("%w: invalid ACP settlement result", ErrDependencyUnavailable)
	}
}

func (service *LifecycleService) confirmLifecycleDrain(ctx context.Context, operation ports.LifecycleOperationRecord, outcome string) (ports.LifecycleOperationRecord, error) {
	if operation.DrainDeadlineAt == nil {
		return ports.LifecycleOperationRecord{}, fmt.Errorf("lifecycle operation has no drain deadline")
	}
	if !service.clock.Now().Before(*operation.DrainDeadlineAt) {
		return ports.LifecycleOperationRecord{}, context.DeadlineExceeded
	}
	ctx, cancel := context.WithDeadline(ctx, *operation.DrainDeadlineAt)
	defer cancel()
	return service.store.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		Kind: operation.Kind, Outcome: outcome, Now: service.clock.Now(),
	})
}
