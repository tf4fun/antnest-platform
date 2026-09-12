package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type EnableAgentInput struct {
	RequestID        string
	OrganizationID   string
	ActorPrincipalID string
	AgentID          string
}

type EnableAgentResult struct {
	Agent     AgentView
	Operation OperationView
}

func (service *LifecycleService) EnableAgent(
	ctx context.Context, input EnableAgentInput,
) (EnableAgentResult, error) {
	if err := validateEnableAgentInput(input); err != nil {
		return EnableAgentResult{}, err
	}
	fingerprint, err := enableAgentFingerprint(input)
	if err != nil {
		return EnableAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentEnable(ctx, input.RequestID, fingerprint)
	if err != nil {
		return EnableAgentResult{}, fmt.Errorf("replay Agent enable: %w", err)
	}
	if found {
		if !lifecycleScopeMatches(state.Agent.OrganizationID, input.OrganizationID) {
			return EnableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return enableAgentResult(state), nil
	}

	base, err := service.store.GetAgentEnableBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return EnableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return EnableAgentResult{}, fmt.Errorf("load Agent enable source: %w", err)
	}
	if !lifecycleScopeMatches(base.Agent.OrganizationID, input.OrganizationID) {
		return EnableAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
	}
	if err := validateEnableSource(base); err != nil {
		return EnableAgentResult{}, err
	}
	authorization, err := service.authorizeOwner(ctx, base.Agent.OrganizationID, base.Agent.OwnerUserID)
	if err != nil {
		return EnableAgentResult{}, err
	}
	now := service.clock.Now()
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: input.AgentID, Kind: domain.OperationEnable,
		SourceSpecRevision:      base.Spec.ID,
		SourceExecutionRevision: base.LastSuccessfulExecution.ID,
		SourceRuntimeRevision:   base.Agent.RuntimeRevision,
		TargetSpecRevision:      base.Spec.ID,
		Now:                     now,
	})
	if err != nil {
		return EnableAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	state, _, err = service.store.BeginAgentEnable(ctx, ports.BeginAgentEnable{
		OwnerAuthorizationSequence:  authorization.LastRevocationSequence,
		AgentID:                     input.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.Spec.ID,
		ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint,
			AgentID: input.AgentID, Kind: domain.OperationEnable,
			Phase: operation.Phase(), State: operation.State(),
			SourceSpecRevisionID:      base.Spec.ID,
			SourceExecutionRevisionID: base.LastSuccessfulExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      base.Spec.ID,
			ChildRequestID:            operation.ChildRequestID(),
			CreatedAt:                 now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-enable-requested", input.RequestID),
			AgentID: input.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentEnableRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"actor_principal_id":           input.ActorPrincipalID,
				"agent_spec_revision_id":       base.Spec.ID,
				"source_execution_revision_id": base.LastSuccessfulExecution.ID,
				"source_runtime_revision":      base.Agent.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return EnableAgentResult{}, fmt.Errorf("begin Agent enable: %w", err)
	}
	return enableAgentResult(state), nil
}

func (service *LifecycleService) stepAgentEnable(
	ctx context.Context, state ports.AgentEnableState,
) (ports.AgentEnableState, error) {
	switch state.Operation.Phase {
	case domain.PhaseNetworkEnsure:
		return service.ensureEnableNetwork(ctx, state)
	case domain.PhaseRuntimeEnable:
		return service.enableRuntime(ctx, state)
	case domain.PhaseNetworkRestore:
		return service.restoreEnableNetwork(ctx, state)
	case domain.PhasePublish:
		return service.publishAgentEnable(ctx, state)
	default:
		return state, fmt.Errorf("invalid enable operation phase %q", state.Operation.Phase)
	}
}

func (service *LifecycleService) ensureEnableNetwork(
	ctx context.Context, state ports.AgentEnableState,
) (ports.AgentEnableState, error) {
	attachment, err := service.egress.EnsureAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil {
		return service.handleEnableDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, attachment.AttachmentState,
	) {
		return service.failEnableBeforeRuntimeEffect(
			ctx, state, "invalid_network_attachment",
			"Runtime Egress returned an incomplete attachment",
		)
	}
	if attachment.AttachmentState != ports.NetworkAttachmentClosed {
		attachment, err = service.setOperationNetworkAttachment(
			ctx, state.Operation, ports.NetworkAttachmentClosed, attachment,
		)
		if err != nil {
			return service.handleEnableDependencyFailure(ctx, state, "runtime-egress", err)
		}
	}
	if !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
		return service.failEnableBeforeRuntimeEffect(
			ctx, state, "network_attachment_close_unconfirmed",
			"Runtime Egress did not confirm the closed attachment",
		)
	}
	return service.store.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhaseRuntimeEnable,
		NextChildRequestID: domain.ChildRequestID(
			state.Operation.RequestID, domain.PhaseRuntimeEnable,
		),
		NetworkAttachment: &attachment, Now: service.clock.Now(),
	})
}

func (service *LifecycleService) enableRuntime(
	ctx context.Context, state ports.AgentEnableState,
) (ports.AgentEnableState, error) {
	if state.Operation.NetworkAttachment == nil {
		return ports.AgentEnableState{}, fmt.Errorf("enable operation has no network attachment")
	}
	runtimeInput := state.Spec.Snapshot.Runtime
	result, err := service.runtime.EnableRuntime(
		ctx, state.Operation.ChildRequestID, state.Agent.AgentID,
		state.Operation.SourceRuntimeRevision,
		ports.RuntimeConfiguration{
			ImageRef: runtimeInput.ImageRef, Network: *state.Operation.NetworkAttachment,
			Resources:  runtimeInput.Resources,
			MCPServers: domain.CloneMCPServers(runtimeInput.MCPServers),
		},
	)
	if err != nil {
		return service.handleEnableDependencyFailure(ctx, state, "runtime-controller", err)
	}
	switch result.State {
	case "running", "unknown":
		return state, nil
	case "failed":
		if result.Effect == "unknown" {
			return state, fmt.Errorf("%w: runtime-controller", ErrDependencyUnavailable)
		}
		code := strings.TrimSpace(result.ErrorCode)
		if code == "" {
			code = "runtime_enable_failed"
		}
		return service.failEnableAfterRuntimeRejection(ctx, state, code, result.ErrorDetail)
	case "completed":
		if !completedReadyRuntime(result) {
			return state, fmt.Errorf(
				"%w: runtime-controller returned an unprovable ready effect",
				ErrDependencyUnavailable,
			)
		}
	default:
		return state, fmt.Errorf(
			"%w: runtime-controller returned an unknown state", ErrDependencyUnavailable,
		)
	}
	return service.store.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseRuntimeEnable, NextPhase: domain.PhaseNetworkRestore,
		NextChildRequestID: domain.ChildRequestID(
			state.Operation.RequestID, domain.PhaseNetworkRestore,
		),
		RuntimeResult: &result, Now: service.clock.Now(),
	})
}

func (service *LifecycleService) restoreEnableNetwork(
	ctx context.Context, state ports.AgentEnableState,
) (ports.AgentEnableState, error) {
	if state.Operation.NetworkAttachment == nil || state.Operation.RuntimeResult == nil {
		return ports.AgentEnableState{}, fmt.Errorf("enable operation is missing a durable dependency result")
	}
	attachment, err := service.egress.SetAgentNetworkAttachment(
		ctx, state.Agent.AgentID, ports.NetworkAttachmentOpen,
		state.Operation.NetworkAttachment.AttachmentResourceVersion,
	)
	if err != nil {
		return state, fmt.Errorf("%w: runtime-egress attachment open: %w", ErrDependencyUnavailable, err)
	}
	if !networkAttachmentReady(attachment, state.Agent.AgentID) ||
		!sameNetworkCoordinates(*state.Operation.NetworkAttachment, attachment) {
		return state, fmt.Errorf("%w: runtime-egress attachment changed during Runtime enable", ErrDependencyUnavailable)
	}
	return service.store.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkRestore, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhasePublish),
		NetworkAttachment:  &attachment, Now: service.clock.Now(),
	})
}

func (service *LifecycleService) fenceIncompleteEnable(
	ctx context.Context,
	state ports.AgentEnableState,
	stage string,
	cause error,
) (ports.AgentEnableState, error) {
	if _, err := service.setCurrentNetworkAttachmentState(
		ctx, state.Operation, ports.NetworkAttachmentClosed,
	); err != nil {
		return state, fmt.Errorf(
			"%w: runtime-egress %s and attachment close failed: %v: %w",
			ErrDependencyUnavailable, stage, cause, err,
		)
	}
	return state, fmt.Errorf(
		"%w: runtime-egress %s; Agent attachment remains closed: %w",
		ErrDependencyUnavailable, stage, cause,
	)
}

func (service *LifecycleService) publishAgentEnable(
	ctx context.Context, state ports.AgentEnableState,
) (ports.AgentEnableState, error) {
	if state.Operation.RuntimeResult == nil || !completedReadyRuntime(*state.Operation.RuntimeResult) {
		return ports.AgentEnableState{}, fmt.Errorf("enable operation has no proven Runtime result")
	}
	runtime := *state.Operation.RuntimeResult
	now := service.clock.Now()
	executionID := derivedID("execution-enable", state.Operation.RequestID)
	return service.store.PublishAgentEnable(ctx, ports.PublishAgentEnable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		Execution: ports.ExecutionRecord{
			ID: executionID, AgentID: state.Agent.AgentID,
			Revision:               state.LastSuccessfulExecution.Revision + 1,
			AgentSpecRevisionID:    state.Spec.ID,
			RuntimeRevision:        runtime.RuntimeRevision,
			RuntimeExecutionID:     runtime.RuntimeExecutionID,
			RuntimeMCPEndpoint:     runtime.MCPEndpoint,
			RuntimeMCPSourceDigest: digestString(runtime.MCPEndpoint),
			ChangeSummary: map[string]any{
				"kind":                         "enable",
				"source_execution_revision_id": state.LastSuccessfulExecution.ID,
			},
			PublishedAt: now,
		},
		EnabledEvent: ports.AgentEventRecord{
			EventID:           derivedID("event-enabled", state.Operation.RequestID),
			AgentID:           state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentEnabled,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"agent_spec_revision_id": state.Spec.ID,
				"execution_revision_id":  executionID,
				"runtime_revision":       runtime.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func (service *LifecycleService) handleEnableDependencyFailure(
	ctx context.Context, state ports.AgentEnableState, serviceName string, err error,
) (ports.AgentEnableState, error) {
	var dependencyFailure *ports.DependencyError
	if !errors.As(err, &dependencyFailure) || dependencyFailure.Retryable {
		return state, fmt.Errorf("%w: %s", ErrDependencyUnavailable, serviceName)
	}
	if serviceName == "runtime-controller" && state.Operation.Phase == domain.PhaseRuntimeEnable {
		return service.failEnableAfterRuntimeRejection(
			ctx, state, dependencyFailure.Code, dependencyFailure.Error(),
		)
	}
	if state.Operation.RuntimeResult != nil {
		return state, fmt.Errorf("%w: %s", ErrDependencyUnavailable, serviceName)
	}
	return service.failEnableBeforeRuntimeEffect(
		ctx, state, dependencyFailure.Code, dependencyFailure.Error(),
	)
}

func (service *LifecycleService) failEnableBeforeRuntimeEffect(
	ctx context.Context,
	state ports.AgentEnableState,
	code string,
	detail string,
) (ports.AgentEnableState, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, state.Agent.AgentID)
	if err != nil {
		return service.fenceIncompleteEnable(
			ctx, state, "Runtime source inspection after "+code, err,
		)
	}
	if !exactDisabledSourceRuntime(state, inspection) {
		return service.fenceIncompleteEnable(
			ctx, state, "Runtime source inspection mismatch after "+code,
			&ports.DependencyError{
				Service: "runtime-controller", Code: "runtime_source_mismatch", Retryable: true,
			},
		)
	}
	return service.failAgentEnable(ctx, state, code, detail, &inspection)
}

func (service *LifecycleService) failEnableAfterRuntimeRejection(
	ctx context.Context, state ports.AgentEnableState, code string, detail string,
) (ports.AgentEnableState, error) {
	return service.failEnableBeforeRuntimeEffect(ctx, state, code, detail)
}

func (service *LifecycleService) failAgentEnable(
	ctx context.Context,
	state ports.AgentEnableState,
	code string,
	detail string,
	inspection *ports.RuntimeInspection,
) (ports.AgentEnableState, error) {
	now := service.clock.Now()
	return service.store.FailAgentEnable(ctx, ports.FailAgentEnable{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		Stage: state.Operation.Phase, Code: code, Detail: detail,
		SourceRuntimeInspection: inspection,
		FailedEvent: ports.AgentEventRecord{
			EventID:           derivedID("event-enable-failed", state.Operation.RequestID),
			AgentID:           state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentEnableFailed,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"failure_stage":            state.Operation.Phase,
				"failure_code":             code,
				"source_preserved":         true,
				"terminal_desired_state":   domain.DesiredDisabled,
				"terminal_lifecycle_state": domain.AgentDisabled,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func exactDisabledSourceRuntime(
	state ports.AgentEnableState, inspection ports.RuntimeInspection,
) bool {
	return inspection.AgentID == state.Agent.AgentID &&
		inspection.RuntimeRevision == state.Operation.SourceRuntimeRevision &&
		inspection.RuntimeExecutionID == "" && inspection.MCPEndpoint == "" &&
		inspection.LifecycleState == "disabled" && inspection.Health == "absent"
}

func validateEnableAgentInput(input EnableAgentInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validLifecycleCaller(input.OrganizationID, input.ActorPrincipalID) {
		return fmt.Errorf("%w: Agent enable input", ErrInvalidInput)
	}
	return nil
}

func validateEnableSource(base ports.AgentEnableBase) error {
	agent := base.Agent
	if agent.ActiveOperationRequestID != "" {
		return fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	if agent.DesiredState != domain.DesiredDisabled || agent.LifecycleState != domain.AgentDisabled ||
		agent.AgentSpecRevisionID == "" || agent.ExecutionRevisionID != "" ||
		agent.LastSuccessfulExecutionRevisionID == "" || agent.RuntimeRevision == "" ||
		agent.RuntimeExecutionID != "" || agent.RuntimeMCPEndpoint != "" ||
		base.Spec.ID != agent.AgentSpecRevisionID || base.Spec.AgentID != agent.AgentID ||
		base.LastSuccessfulExecution.ID != agent.LastSuccessfulExecutionRevisionID ||
		base.LastSuccessfulExecution.AgentID != agent.AgentID ||
		base.LastSuccessfulExecution.AgentSpecRevisionID != base.Spec.ID ||
		base.NextExecutionRevision <= base.LastSuccessfulExecution.Revision {
		return fmt.Errorf("%w: Agent is not a complete disabled enable source", ErrAgentNotReady)
	}
	return nil
}

func enableAgentFingerprint(input EnableAgentInput) (string, error) {
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

func enableAgentResult(state ports.AgentEnableState) EnableAgentResult {
	return EnableAgentResult{
		Agent: agentView(state.Agent), Operation: lifecycleOperationView(state.Operation),
	}
}
