package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type DeleteAgentInput struct {
	RequestID        string
	OrganizationID   string
	ActorPrincipalID string
	AgentID          string
}

type DeleteAgentResult struct {
	Agent     AgentView
	Operation OperationView
}

func (service *LifecycleService) DeleteAgent(
	ctx context.Context, input DeleteAgentInput,
) (DeleteAgentResult, error) {
	if err := validateDeleteAgentInput(input); err != nil {
		return DeleteAgentResult{}, err
	}
	fingerprint, err := deleteAgentFingerprint(input)
	if err != nil {
		return DeleteAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentDelete(ctx, input.RequestID, fingerprint)
	if err != nil {
		return DeleteAgentResult{}, fmt.Errorf("replay Agent delete: %w", err)
	}
	if found {
		if !lifecycleScopeMatches(state.Agent.OrganizationID, input.OrganizationID) {
			return DeleteAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return deleteAgentResult(state), nil
	}

	base, err := service.store.GetAgentDeleteBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return DeleteAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return DeleteAgentResult{}, fmt.Errorf("load Agent delete source: %w", err)
	}
	if !lifecycleScopeMatches(base.Agent.OrganizationID, input.OrganizationID) {
		return DeleteAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
	}
	if err := validateDeleteSource(base.Agent); err != nil {
		return DeleteAgentResult{}, err
	}
	sourceRuntime := base.Agent.RuntimeRevision
	if base.Agent.DesiredState == domain.DesiredDeleted {
		// A new deletion attempt must inspect the current physical state after fencing.
		sourceRuntime = ""
	}
	now := service.clock.Now()
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: base.Agent.AgentID, Kind: domain.OperationDelete,
		SourceRuntimeRevision: sourceRuntime,
		Now:                   now,
	})
	if err != nil {
		return DeleteAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	state, _, err = service.store.BeginAgentDelete(ctx, ports.BeginAgentDelete{
		AgentID: base.Agent.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedDesiredState:    base.Agent.DesiredState,
		ExpectedLifecycleState:  base.Agent.LifecycleState,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			DrainDeadlineAt: service.drainDeadline(now),
			RequestID:       input.RequestID, RequestFingerprint: fingerprint,
			AgentID: base.Agent.AgentID, Kind: domain.OperationDelete,
			Phase: operation.Phase(), State: operation.State(),
			SourceRuntimeRevision: sourceRuntime,
			ChildRequestID:        operation.ChildRequestID(), CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-delete-requested", input.RequestID),
			AgentID: base.Agent.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDeleteRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"actor_principal_id":      input.ActorPrincipalID,
				"source_runtime_revision": sourceRuntime,
				"source_runtime_absent":   false,
			},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return DeleteAgentResult{}, fmt.Errorf("begin Agent delete: %w", err)
	}
	return deleteAgentResult(state), nil
}

func (service *LifecycleService) stepAgentDelete(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	switch state.Operation.Phase {
	case domain.PhaseDrain:
		return service.settleDeleteDrain(ctx, state)
	case domain.PhaseNetworkFence:
		return service.fenceDeleteNetwork(ctx, state)
	case domain.PhaseRuntimeDelete:
		return service.deleteRuntime(ctx, state)
	case domain.PhaseNetworkRelease:
		return service.releaseDeleteNetwork(ctx, state)
	case domain.PhasePublish:
		return service.publishAgentDelete(ctx, state)
	default:
		return state, fmt.Errorf("invalid delete operation phase %q", state.Operation.Phase)
	}
}

func (service *LifecycleService) settleDeleteDrain(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	outcome, err := service.settleLifecycleExecution(ctx, state.Agent, state.Operation)
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil && !service.clock.Now().Before(*state.Operation.DrainDeadlineAt) {
		return service.failAgentDelete(ctx, state, "drain_timeout", "Agent execution did not settle before deletion; retry after execution has stopped")
	}
	if err != nil || outcome == ports.ExecutionNotSettled {
		return state, err
	}
	operation, err := service.confirmLifecycleDrain(ctx, state.Operation, outcome)
	if err != nil {
		return state, err
	}
	state.Operation = operation
	return state, nil
}

func (service *LifecycleService) fenceDeleteNetwork(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	attachment, err := service.egress.GetAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil && dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
		return service.advanceDeleteFence(ctx, state, nil)
	}
	if err != nil {
		return state, fmt.Errorf("%w: runtime-egress attachment read", ErrDependencyUnavailable)
	}
	attachment, err = service.setOperationNetworkAttachment(
		ctx, state.Operation, ports.NetworkAttachmentClosed, attachment,
	)
	if err != nil && !dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
		return state, fmt.Errorf("%w: runtime-egress attachment close", ErrDependencyUnavailable)
	}
	if err == nil && !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
		return state, fmt.Errorf("%w: runtime-egress attachment close is not current", ErrDependencyUnavailable)
	}
	if err != nil {
		return service.advanceDeleteFence(ctx, state, nil)
	}
	return service.advanceDeleteFence(ctx, state, &attachment)
}

func (service *LifecycleService) deleteRuntime(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	if state.Operation.SourceRuntimeRevision == "" || state.Operation.SourceRuntimeAbsent {
		return state, fmt.Errorf("%w: Runtime cleanup target is unresolved", ErrDependencyUnavailable)
	}
	result, err := service.runtime.DeleteRuntime(
		ctx, state.Operation.ChildRequestID, state.Agent.AgentID,
		state.Operation.SourceRuntimeRevision,
	)
	if err != nil {
		return service.reconcileDeletedRuntime(ctx, state)
	}
	switch result.State {
	case "running", "unknown":
		return state, nil
	case "failed":
		if result.Effect == "not_started" {
			return service.failAgentDelete(ctx, state, result.ErrorCode, result.ErrorDetail)
		}
		return service.reconcileDeletedRuntime(ctx, state)
	case "completed":
		if !completedDeletedRuntime(result) {
			return state, fmt.Errorf("%w: unprovable Runtime deletion", ErrDependencyUnavailable)
		}
		return service.recordDeletedRuntime(ctx, state, result)
	default:
		return state, fmt.Errorf("%w: invalid Runtime deletion state", ErrDependencyUnavailable)
	}
}

func (service *LifecycleService) failAgentDelete(ctx context.Context, state ports.AgentDeleteState, code, detail string) (ports.AgentDeleteState, error) {
	if code == "" {
		code = "runtime_delete_failed"
	}
	if detail == "" {
		detail = "Runtime deletion was rejected before execution; correct the deployment configuration and retry deletion"
	}
	operation := state.Operation
	if err := service.store.QuarantineLifecycleOperation(ctx, ports.QuarantineLifecycleOperation{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: operation.Phase, ErrorCode: code, ErrorDetail: detail,
		EventID: domain.DeriveResourceID("event", "event-lifecycle-quarantined", operation.RequestID), TraceID: currentTraceID(ctx),
	}); err != nil {
		return state, err
	}
	failed, found, err := service.store.ReplayAgentDelete(ctx, operation.RequestID, operation.RequestFingerprint)
	if !found || err != nil {
		return state, lifecycleReplayError("delete failure", found, err)
	}
	return failed, nil
}

func (service *LifecycleService) reconcileDeletedRuntime(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, state.Agent.AgentID)
	if err != nil {
		if dependencyHasCode(err, "runtime-controller", "runtime_not_found") {
			return service.recordDeletedRuntime(ctx, state, observedDeletedRuntime(state, ""))
		}
		return state, fmt.Errorf("%w: runtime-controller deletion inspection", ErrDependencyUnavailable)
	}
	if !runtimeInspectionProvesDeleted(state.Agent.AgentID, inspection) {
		return state, fmt.Errorf("%w: Runtime deletion remains unproven", ErrDependencyUnavailable)
	}
	return service.recordDeletedRuntime(
		ctx, state, observedDeletedRuntime(state, inspection.RuntimeRevision),
	)
}

func (service *LifecycleService) recordDeletedRuntime(
	ctx context.Context, state ports.AgentDeleteState, result ports.RuntimeOperation,
) (ports.AgentDeleteState, error) {
	return service.advanceAgentDelete(
		ctx, state, domain.PhaseRuntimeDelete, domain.PhaseNetworkRelease, nil, &result, "",
	)
}

func (service *LifecycleService) releaseDeleteNetwork(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	attachment, err := service.egress.GetAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil && dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
		return service.advanceAgentDelete(
			ctx, state, domain.PhaseNetworkRelease, domain.PhasePublish, nil, nil,
			ports.NetworkReleaseAuthoritativeNone,
		)
	}
	if err == nil && networkAttachmentInState(
		attachment, state.Agent.AgentID,
		ports.NetworkStateQuarantined, ports.NetworkAttachmentClosed,
	) {
		return service.advanceAgentDelete(
			ctx, state, domain.PhaseNetworkRelease, domain.PhasePublish, &attachment, nil,
			ports.NetworkReleaseQuarantined,
		)
	}
	if err != nil || !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
		return state, fmt.Errorf("%w: runtime-egress release attachment is not closed", ErrDependencyUnavailable)
	}
	attachment, err = service.egress.ReleaseAgentNetwork(
		ctx, state.Agent.AgentID, attachment.NetworkResourceVersion,
	)
	if err != nil {
		if dependencyHasCode(err, "runtime-egress", "agent_network_not_found") {
			return service.advanceAgentDelete(
				ctx, state, domain.PhaseNetworkRelease, domain.PhasePublish, nil, nil,
				ports.NetworkReleaseAuthoritativeNone,
			)
		}
		return state, fmt.Errorf("%w: runtime-egress release", ErrDependencyUnavailable)
	}
	if !networkAttachmentInState(
		attachment, state.Agent.AgentID,
		ports.NetworkStateQuarantined, ports.NetworkAttachmentClosed,
	) {
		return state, fmt.Errorf("%w: invalid released network attachment", ErrDependencyUnavailable)
	}
	return service.advanceAgentDelete(
		ctx, state, domain.PhaseNetworkRelease, domain.PhasePublish, &attachment, nil,
		ports.NetworkReleaseQuarantined,
	)
}

func (service *LifecycleService) advanceAgentDelete(
	ctx context.Context,
	state ports.AgentDeleteState,
	expected domain.OperationPhase,
	next domain.OperationPhase,
	attachment *ports.NetworkAttachment,
	runtime *ports.RuntimeOperation,
	networkReleaseOutcome string,
) (ports.AgentDeleteState, error) {
	now := service.clock.Now()
	input := deleteAdvanceInput(state, expected, next, now)
	input.NetworkAttachment, input.RuntimeResult = attachment, runtime
	input.NetworkReleaseOutcome = networkReleaseOutcome
	return service.store.AdvanceAgentDelete(ctx, input)
}

func deleteAdvanceInput(state ports.AgentDeleteState, expected, next domain.OperationPhase, now time.Time) ports.AdvanceAgentDelete {
	return ports.AdvanceAgentDelete{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: expected, NextPhase: next,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, next),
		Now:                now,
	}
}

func (service *LifecycleService) publishAgentDelete(
	ctx context.Context, state ports.AgentDeleteState,
) (ports.AgentDeleteState, error) {
	if state.Operation.SourceRuntimeAbsent &&
		!validRuntimeAbsenceProof(state.Operation.SourceRuntimeAbsenceProof) {
		return ports.AgentDeleteState{}, fmt.Errorf("delete operation has no Runtime absence proof")
	}
	if !state.Operation.SourceRuntimeAbsent &&
		(state.Operation.RuntimeResult == nil || !completedDeletedRuntime(*state.Operation.RuntimeResult)) {
		return ports.AgentDeleteState{}, fmt.Errorf("delete operation has no proven Runtime deletion")
	}
	if !validDeleteNetworkRelease(state.Operation, state.Agent.AgentID) {
		return ports.AgentDeleteState{}, fmt.Errorf("delete operation has no proven network release")
	}
	now := service.clock.Now()
	return service.store.PublishAgentDelete(ctx, ports.PublishAgentDelete{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		DeletedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-deleted", state.Operation.RequestID),
			AgentID: state.Agent.AgentID, AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentDeleted,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"source_runtime_revision": state.Operation.SourceRuntimeRevision,
				"source_runtime_absent":   state.Operation.SourceRuntimeAbsent,
				"runtime_absence_reason": runtimeAbsenceReason(
					state.Operation.SourceRuntimeAbsenceProof,
				),
				"network_release_outcome": state.Operation.NetworkReleaseOutcome,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func validateDeleteSource(agent ports.AgentRecord) error {
	if agent.ActiveOperationRequestID != "" {
		return fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	if agent.LifecycleState != domain.AgentCreated && agent.LifecycleState != domain.AgentNotCreated {
		return fmt.Errorf("%w: Agent cannot enter deletion from %s", ErrAgentNotReady, agent.LifecycleState)
	}
	return nil
}

func completedDeletedRuntime(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "deleted" && result.Health == "absent" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID == "" && result.MCPEndpoint == ""
}

func runtimeInspectionProvesDeleted(expectedAgentID string, inspection ports.RuntimeInspection) bool {
	return inspection.AgentID == expectedAgentID && inspection.RuntimeRevision != "" &&
		inspection.LifecycleState == "deleted" && inspection.Health == "absent" &&
		inspection.RuntimeExecutionID == "" && inspection.MCPEndpoint == ""
}

func validDeleteNetworkRelease(operation ports.LifecycleOperationRecord, agentID string) bool {
	switch operation.NetworkReleaseOutcome {
	case ports.NetworkReleaseQuarantined:
		return operation.NetworkAttachment != nil &&
			networkAttachmentInState(
				*operation.NetworkAttachment, agentID,
				ports.NetworkStateQuarantined, ports.NetworkAttachmentClosed,
			)
	case ports.NetworkReleaseAuthoritativeNone:
		return operation.NetworkAttachment == nil
	default:
		return false
	}
}

func runtimeAbsenceReason(proof *ports.RuntimeAbsenceProof) string {
	if proof == nil {
		return ""
	}
	return proof.Reason
}

func validRuntimeAbsenceProof(proof *ports.RuntimeAbsenceProof) bool {
	if proof == nil || proof.ObservedAt.IsZero() {
		return false
	}
	switch proof.Reason {
	case "runtime_not_found":
		return proof.RuntimeRevision == ""
	case "runtime_deleted":
		return proof.RuntimeRevision != ""
	default:
		return false
	}
}

func observedDeletedRuntime(
	state ports.AgentDeleteState, observedRevision string,
) ports.RuntimeOperation {
	if observedRevision == "" {
		observedRevision = state.Operation.SourceRuntimeRevision
	}
	return ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: observedRevision,
		LifecycleState: "deleted", Health: "absent",
	}
}

func dependencyHasCode(err error, service string, code string) bool {
	var failure *ports.DependencyError
	return errors.As(err, &failure) && failure.Service == service && failure.Code == code
}

func validateDeleteAgentInput(input DeleteAgentInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validLifecycleCaller(input.OrganizationID, input.ActorPrincipalID) {
		return fmt.Errorf("%w: Agent delete input", ErrInvalidInput)
	}
	return nil
}

func deleteAgentFingerprint(input DeleteAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
	}{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID,
	})
}

func deleteAgentResult(state ports.AgentDeleteState) DeleteAgentResult {
	return DeleteAgentResult{
		Agent: agentView(state.Agent), Operation: lifecycleOperationView(state.Operation),
	}
}
