package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type RebuildAgentInput struct {
	RequestID          string
	OrganizationID     string
	ActorPrincipalID   string
	AgentID            string
	TemplateID         string
	TemplateRevision   int64
	InitialTraceParent string
}

type RebuildAgentResult struct {
	Agent     AgentView
	Operation OperationView
}

func (service *LifecycleService) RebuildAgent(
	ctx context.Context, input RebuildAgentInput,
) (RebuildAgentResult, error) {
	if err := validateRebuildAgentInput(input); err != nil {
		return RebuildAgentResult{}, err
	}
	fingerprint, err := rebuildAgentFingerprint(input)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentRebuild(ctx, input.RequestID, fingerprint)
	if err != nil {
		return RebuildAgentResult{}, fmt.Errorf("replay Agent rebuild: %w", err)
	}
	if found {
		if !lifecycleScopeMatches(state.Agent.OrganizationID, input.OrganizationID) {
			return RebuildAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return rebuildAgentResult(state), nil
	}

	base, err := service.store.GetAgentLifecycleBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return RebuildAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
		}
		return RebuildAgentResult{}, fmt.Errorf("load Agent rebuild source: %w", err)
	}
	if err := validateRebuildSource(base); err != nil {
		return RebuildAgentResult{}, err
	}
	if !lifecycleScopeMatches(base.Agent.OrganizationID, input.OrganizationID) {
		return RebuildAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
	}
	template, _, targetSpec, err := service.resolveAgentSpecRevision(
		ctx, base.Agent.OrganizationID, input.TemplateID, input.TemplateRevision,
	)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	digest, err := targetSpec.Digest()
	if err != nil {
		return RebuildAgentResult{}, fmt.Errorf("digest rebuilt Agent spec: %w", err)
	}
	now := service.clock.Now()
	targetSpecID := derivedID("agentspec-rebuild", input.RequestID)
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: input.AgentID, Kind: domain.OperationRebuild,
		SourceSpecRevision:      base.ExecutableSpec.ID,
		SourceExecutionRevision: base.ExecutableExecution.ID,
		SourceRuntimeRevision:   base.Agent.RuntimeRevision,
		TargetSpecRevision:      targetSpecID,
		InitialTraceParent:      input.InitialTraceParent, Now: now,
	})
	if err != nil {
		return RebuildAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	begin := ports.BeginAgentRebuild{
		AgentID:                     input.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.ExecutableSpec.ID,
		ExpectedExecutionRevisionID: base.ExecutableExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{
			ID: targetSpecID, AgentID: input.AgentID, Revision: base.NextSpecRevision,
			Snapshot: targetSpec.Snapshot(), CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint,
			AgentID: input.AgentID, Kind: domain.OperationRebuild,
			Phase: operation.Phase(), State: operation.State(),
			SourceSpecRevisionID:      base.ExecutableSpec.ID,
			SourceExecutionRevisionID: base.ExecutableExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      targetSpecID,
			ChildRequestID:            operation.ChildRequestID(),
			InitialTraceParent:        input.InitialTraceParent, Attempt: 0,
			CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-rebuild-requested", input.RequestID),
			AgentID: input.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"actor_principal_id":            input.ActorPrincipalID,
				"source_agent_spec_revision_id": base.ExecutableSpec.ID,
				"source_runtime_revision":       base.Agent.RuntimeRevision,
				"target_agent_spec_revision_id": targetSpecID,
				"template_id":                   template.Snapshot().TemplateID,
				"template_revision":             template.Revision(),
			},
			OccurredAt: now,
		},
		Now: now,
	}
	state, _, err = service.store.BeginAgentRebuild(ctx, begin)
	if err != nil {
		return RebuildAgentResult{}, fmt.Errorf("begin Agent rebuild: %w", err)
	}
	return rebuildAgentResult(state), nil
}

func (service *LifecycleService) stepAgentRebuild(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	switch state.Operation.Phase {
	case domain.PhaseDrain:
		return service.settleRebuildDrain(ctx, state)
	case domain.PhaseNetworkFence:
		return service.fenceRebuildNetwork(ctx, state)
	case domain.PhaseRuntimeUpdate:
		return service.updateRebuildRuntime(ctx, state)
	case domain.PhaseNetworkEnsure:
		return service.reopenRebuildNetwork(ctx, state)
	case domain.PhasePublish:
		return service.publishAgentRebuild(ctx, state)
	default:
		return state, fmt.Errorf("invalid rebuild operation phase %q", state.Operation.Phase)
	}
}

func (service *LifecycleService) settleRebuildDrain(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	settled, err := service.store.SettleAgentRebuildDrain(
		ctx, state.Operation.RequestID, state.Operation.RequestFingerprint,
		domain.ChildRequestID(state.Operation.RequestID, domain.PhaseNetworkFence),
		service.clock.Now(),
	)
	if err != nil || settled.Operation.Phase != domain.PhaseDrain {
		return settled, err
	}
	if !service.clock.Now().Before(state.Operation.CreatedAt.Add(service.drainTimeout)) {
		return service.failRebuildPreservingSource(
			ctx, settled, "run_drain_timeout", "active Run did not drain before the deadline", false,
		)
	}
	return settled, nil
}

func (service *LifecycleService) fenceRebuildNetwork(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	attachment, err := service.egress.GetAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil {
		return service.handleRebuildDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
		return service.advanceClosedRebuildNetwork(ctx, state, attachment)
	}
	if !networkAttachmentReady(attachment, state.Agent.AgentID) {
		return service.failRebuildPreservingSource(
			ctx, state, "invalid_network_attachment",
			"Runtime Egress did not return the active open attachment", false,
		)
	}
	attachment, err = service.egress.SetAgentNetworkAttachment(
		ctx, state.Agent.AgentID, ports.NetworkAttachmentClosed,
		attachment.AttachmentResourceVersion,
	)
	if err != nil {
		return service.handleRebuildDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
		return service.failRebuildPreservingSource(
			ctx, state, "network_attachment_close_unconfirmed",
			"Runtime Egress did not confirm the closed attachment", false,
		)
	}
	return service.advanceClosedRebuildNetwork(ctx, state, attachment)
}

func (service *LifecycleService) advanceClosedRebuildNetwork(
	ctx context.Context, state ports.AgentRebuildState, attachment ports.NetworkAttachment,
) (ports.AgentRebuildState, error) {
	return service.store.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID:     state.Operation.RequestID,
		Fingerprint:   state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeUpdate,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhaseRuntimeUpdate),
		NetworkAttachment:  &attachment, Now: service.clock.Now(),
	})
}

func (service *LifecycleService) updateRebuildRuntime(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	if state.Operation.NetworkAttachment == nil {
		return ports.AgentRebuildState{}, fmt.Errorf("rebuild operation has no network attachment")
	}
	runtimeInput := state.TargetSpec.Snapshot.Runtime
	configuration := ports.RuntimeConfiguration{
		ImageRef: runtimeInput.ImageRef, Network: *state.Operation.NetworkAttachment,
		Resources:  runtimeInput.Resources,
		MCPServers: domain.CloneMCPServers(runtimeInput.MCPServers),
	}
	result, err := service.runtime.UpdateRuntime(
		ctx, state.Operation.ChildRequestID, state.Agent.AgentID,
		state.Operation.SourceRuntimeRevision, configuration,
	)
	if err != nil {
		return service.handleRebuildDependencyFailure(ctx, state, "runtime-controller", err)
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
			code = "runtime_update_failed"
		}
		return service.reconcileRejectedRebuildRuntime(ctx, state, code, result.ErrorDetail)
	case "completed":
		if !completedReadyRuntime(result) {
			return state, fmt.Errorf(
				"%w: runtime-controller returned an unprovable completed effect",
				ErrDependencyUnavailable,
			)
		}
	default:
		return state, fmt.Errorf(
			"%w: runtime-controller returned an unknown state", ErrDependencyUnavailable,
		)
	}
	now := service.clock.Now()
	return service.store.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID:     state.Operation.RequestID,
		Fingerprint:   state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseRuntimeUpdate, NextPhase: domain.PhaseNetworkEnsure,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhaseNetworkEnsure),
		RuntimeResult:      &result,
		RunReleaseEvent: lifecycleRunReleaseEvent(
			ctx, state.Operation.RequestID, "runtime_replaced",
			state.Operation.SourceRuntimeRevision, now,
		),
		Now: now,
	})
}

func (service *LifecycleService) reopenRebuildNetwork(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	if state.Operation.NetworkAttachment == nil {
		return ports.AgentRebuildState{}, fmt.Errorf("rebuild operation has no network attachment")
	}
	attachment, err := service.egress.SetAgentNetworkAttachment(
		ctx, state.Agent.AgentID, ports.NetworkAttachmentOpen,
		state.Operation.NetworkAttachment.AttachmentResourceVersion,
	)
	if err != nil {
		return service.handleRebuildDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if !networkAttachmentReady(attachment, state.Agent.AgentID) {
		return state, fmt.Errorf(
			"%w: runtime-egress did not confirm an active attachment", ErrDependencyUnavailable,
		)
	}
	if !sameNetworkCoordinates(*state.Operation.NetworkAttachment, attachment) {
		return state, fmt.Errorf(
			"%w: runtime-egress attachment changed during Runtime replacement",
			ErrDependencyUnavailable,
		)
	}
	return service.store.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID:     state.Operation.RequestID,
		Fingerprint:   state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhasePublish),
		NetworkAttachment:  &attachment, Now: service.clock.Now(),
	})
}

func (service *LifecycleService) publishAgentRebuild(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	if state.Operation.RuntimeResult == nil {
		return ports.AgentRebuildState{}, fmt.Errorf("rebuild operation has no Runtime result")
	}
	runtime := *state.Operation.RuntimeResult
	now := service.clock.Now()
	executionID := derivedID("execution-rebuild", state.Operation.RequestID)
	accessRevision := derivedID("access-rebuild", state.Operation.RequestID)
	return service.store.PublishAgentRebuild(ctx, ports.PublishAgentRebuild{
		RequestID:      state.Operation.RequestID,
		Fingerprint:    state.Operation.RequestFingerprint,
		AccessRevision: accessRevision,
		PromptCapabilities: ports.PromptCapabilities{
			Image: state.TargetSpec.Snapshot.Model.SupportsImages,
		},
		Execution: ports.ExecutionRecord{
			ID: executionID, AgentID: state.Agent.AgentID,
			Revision:               state.SourceExecution.Revision + 1,
			AgentSpecRevisionID:    state.TargetSpec.ID,
			RuntimeRevision:        runtime.RuntimeRevision,
			RuntimeExecutionID:     runtime.RuntimeExecutionID,
			RuntimeMCPEndpoint:     runtime.MCPEndpoint,
			RuntimeMCPSourceDigest: digestString(runtime.MCPEndpoint),
			ChangeSummary: map[string]any{
				"kind":                          "rebuild",
				"source_agent_spec_revision_id": state.SourceSpec.ID,
				"target_agent_spec_revision_id": state.TargetSpec.ID,
			},
			PublishedAt: now,
		},
		RebuiltEvent: ports.AgentEventRecord{
			EventID:           derivedID("event-rebuilt", state.Operation.RequestID),
			AgentID:           state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuilt,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"agent_spec_revision_id": state.TargetSpec.ID,
				"execution_revision_id":  executionID,
				"runtime_revision":       runtime.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
}

func (service *LifecycleService) handleRebuildDependencyFailure(
	ctx context.Context, state ports.AgentRebuildState, serviceName string, err error,
) (ports.AgentRebuildState, error) {
	var dependencyFailure *ports.DependencyError
	if !errors.As(err, &dependencyFailure) || dependencyFailure.Retryable {
		return state, fmt.Errorf("%w: %s", ErrDependencyUnavailable, serviceName)
	}
	if state.Operation.RuntimeResult != nil {
		return state, fmt.Errorf("%w: %s", ErrDependencyUnavailable, serviceName)
	}
	if serviceName == "runtime-controller" && state.Operation.Phase == domain.PhaseRuntimeUpdate {
		return service.reconcileRejectedRebuildRuntime(
			ctx, state, dependencyFailure.Code, dependencyFailure.Error(),
		)
	}
	return service.failRebuildPreservingSource(
		ctx, state, dependencyFailure.Code, dependencyFailure.Error(), false,
	)
}

func (service *LifecycleService) failRebuildPreservingSource(
	ctx context.Context,
	state ports.AgentRebuildState,
	code string,
	detail string,
	retryable bool,
) (ports.AgentRebuildState, error) {
	if state.Operation.NetworkAttachment != nil {
		if _, err := service.setCurrentNetworkAttachmentState(
			ctx, state.Agent.AgentID, ports.NetworkAttachmentOpen,
		); err != nil {
			return state, fmt.Errorf("%w: runtime-egress attachment restoration", ErrDependencyUnavailable)
		}
	}
	return service.failAgentRebuild(ctx, state, code, detail, retryable, true, nil)
}

func (service *LifecycleService) failRebuildAfterRuntimeAbsence(
	ctx context.Context,
	state ports.AgentRebuildState,
	code string,
	detail string,
	proof *ports.RuntimeAbsenceProof,
) (ports.AgentRebuildState, error) {
	return service.failAgentRebuild(ctx, state, code, detail, false, false, proof)
}

func (service *LifecycleService) reconcileRejectedRebuildRuntime(
	ctx context.Context,
	state ports.AgentRebuildState,
	code string,
	detail string,
) (ports.AgentRebuildState, error) {
	inspection, err := service.runtime.InspectRuntime(ctx, state.Agent.AgentID)
	if err != nil {
		if dependencyHasCode(err, "runtime-controller", "runtime_not_found") {
			return state, fmt.Errorf("%w: runtime-controller inspection", ErrDependencyUnavailable)
		}
		return state, fmt.Errorf("%w: runtime-controller inspection", ErrDependencyUnavailable)
	}
	if exactReadyRuntime(
		state.Agent.AgentID, state.Operation.SourceRuntimeRevision,
		state.SourceExecution.RuntimeExecutionID,
		state.SourceExecution.RuntimeMCPEndpoint, inspection,
	) {
		return service.failRebuildPreservingSource(ctx, state, code, detail, false)
	}
	proof, absent := deletedRuntimeAbsenceProof(
		state.Agent.AgentID, state.Operation.SourceRuntimeRevision,
		inspection, service.clock.Now(),
	)
	if absent {
		return service.failRebuildAfterRuntimeAbsence(ctx, state, code, detail, proof)
	}
	return state, fmt.Errorf("%w: runtime-controller inspection", ErrDependencyUnavailable)
}

func (service *LifecycleService) failAgentRebuild(
	ctx context.Context,
	state ports.AgentRebuildState,
	code string,
	detail string,
	retryable bool,
	preserveExecutable bool,
	proof *ports.RuntimeAbsenceProof,
) (ports.AgentRebuildState, error) {
	now := service.clock.Now()
	releaseEvent := ports.RunAdmissionEvent{}
	if proof != nil {
		releaseEvent = lifecycleRunReleaseEvent(
			ctx, state.Operation.RequestID, proof.Reason,
			state.Operation.SourceRuntimeRevision, now,
		)
	}
	return service.store.FailAgentRebuild(ctx, ports.FailAgentRebuild{
		RequestID:                 state.Operation.RequestID,
		Fingerprint:               state.Operation.RequestFingerprint,
		ExpectedAggregateSequence: state.Agent.AggregateSequence,
		Stage:                     state.Operation.Phase, Code: code, Detail: detail, Retryable: retryable,
		FailedEvent: ports.AgentEventRecord{
			EventID:       derivedID("event-rebuild-failed", state.Operation.RequestID),
			AgentID:       state.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentBuildFailed,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"failure_stage": state.Operation.Phase,
				"failure_code":  code,
			},
			OccurredAt: now,
		},
		PreserveExecutable: preserveExecutable, RuntimeAbsenceProof: proof,
		RunReleaseEvent: releaseEvent, Now: now,
	})
}

func validateRebuildAgentInput(input RebuildAgentInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.AgentID) ||
		!validLifecycleCaller(input.OrganizationID, input.ActorPrincipalID) ||
		!validIdentifier(input.TemplateID) || input.TemplateRevision < 1 {
		return fmt.Errorf("%w: Agent rebuild input", ErrInvalidInput)
	}
	return nil
}

func validateRebuildSource(base ports.AgentLifecycleBase) error {
	agent := base.Agent
	if agent.ActiveOperationRequestID != "" {
		return fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	if agent.DesiredState != domain.DesiredEnabled || agent.LifecycleState != domain.AgentAvailable ||
		agent.AgentSpecRevisionID == "" ||
		agent.ExecutionRevisionID == "" || agent.RuntimeRevision == "" ||
		base.ExecutableSpec.ID != agent.AgentSpecRevisionID ||
		base.ExecutableExecution.ID != agent.ExecutionRevisionID ||
		base.ExecutableExecution.RuntimeRevision != agent.RuntimeRevision ||
		base.NextSpecRevision <= base.ExecutableSpec.Revision ||
		base.NextExecutionRevision <= base.ExecutableExecution.Revision {
		return fmt.Errorf("%w: Agent is not a complete available rebuild source", ErrAgentNotReady)
	}
	return nil
}

func rebuildAgentFingerprint(input RebuildAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
		TemplateID       string
		TemplateRevision int64
	}{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID,
		TemplateID: input.TemplateID, TemplateRevision: input.TemplateRevision,
	})
}

func sameNetworkCoordinates(left ports.NetworkAttachment, right ports.NetworkAttachment) bool {
	return left.AgentID == right.AgentID && left.TunnelIPv4 == right.TunnelIPv4 &&
		left.ResolverIPv4 == right.ResolverIPv4 &&
		left.PacketContractRevision == right.PacketContractRevision &&
		left.EgressIPv4 == right.EgressIPv4 && left.EgressPort == right.EgressPort
}

func rebuildAgentResult(state ports.AgentRebuildState) RebuildAgentResult {
	return RebuildAgentResult{
		Agent: agentView(state.Agent), Operation: lifecycleOperationView(state.Operation),
	}
}
