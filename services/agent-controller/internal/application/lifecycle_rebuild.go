package application

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type RebuildAgentInput struct {
	RequestID        string
	OrganizationID   string
	ActorPrincipalID string
	AgentID          string
	TemplateID       string
	TemplateRevision int64
}

type RebuildAgentResult struct {
	Agent     AgentView
	Operation OperationView
}

func (service *LifecycleService) RebuildAgent(
	ctx context.Context, input RebuildAgentInput,
) (RebuildAgentResult, error) {
	return service.rebuildAgent(ctx, input)
}

func (service *LifecycleService) rebuildAgent(
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
	if !lifecycleScopeMatches(base.Agent.OrganizationID, input.OrganizationID) {
		return RebuildAgentResult{}, fmt.Errorf("%w: %s", ErrAgentNotFound, input.AgentID)
	}
	source, err := resolveRebuildSource(base)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	var targetSnapshot domain.AgentSpecSnapshot
	var digest string
	intent, existingIntent, err := service.existingSkillPreparation(ctx, input.RequestID, fingerprint, domain.OperationRebuild, input.AgentID, base.Agent.OrganizationID)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	if existingIntent {
		targetSnapshot, digest = intent.TargetSpec, intent.TargetSpecDigest
	} else {
		_, _, targetSpec, resolveErr := service.resolveAgentSpecRevision(ctx, base.Agent.OrganizationID, input.TemplateID, input.TemplateRevision)
		err = resolveErr
		if err == nil {
			targetSnapshot = targetSpec.Snapshot()
			digest, err = targetSpec.Digest()
		}
		if err != nil {
			return RebuildAgentResult{}, fmt.Errorf("resolve rebuilt Agent spec: %w", err)
		}
	}
	now := service.clock.Now()
	prepared, err := service.prepareAgentSkills(ctx, ports.SkillPreparationIntent{
		RequestID: input.RequestID, RequestFingerprint: fingerprint, Kind: domain.OperationRebuild,
		AgentID: input.AgentID, OrganizationID: base.Agent.OrganizationID,
		TargetSpec: targetSnapshot, TargetSpecDigest: digest,
		ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:    source.Spec.ID, ExpectedExecutionRevisionID: source.Execution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision, CreatedAt: now, UpdatedAt: now,
	})
	if err != nil {
		return RebuildAgentResult{}, err
	}
	targetSnapshot, digest = prepared.TargetSpec, prepared.TargetSpecDigest
	targetSpecID := domain.DeriveResourceID("agentspec", "agentspec-rebuild", input.RequestID)
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: input.AgentID, Kind: domain.OperationRebuild,
		SourceSpecRevision:      source.Spec.ID,
		SourceExecutionRevision: source.Execution.ID,
		SourceRuntimeRevision:   base.Agent.RuntimeRevision,
		TargetSpecRevision:      targetSpecID,
		Now:                     now,
	})
	if err != nil {
		return RebuildAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	begin := ports.BeginAgentRebuild{
		AgentID:                     input.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      source.Spec.ID,
		ExpectedExecutionRevisionID: source.Execution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{
			ID: targetSpecID, AgentID: input.AgentID, Revision: base.NextSpecRevision,
			Snapshot: targetSnapshot, CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			DrainDeadlineAt: service.drainDeadline(now),
			RequestID:       input.RequestID, RequestFingerprint: fingerprint,
			AgentID: input.AgentID, Kind: domain.OperationRebuild,
			Phase: operation.Phase(), State: operation.State(),
			SourceSpecRevisionID:      source.Spec.ID,
			SourceExecutionRevisionID: source.Execution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      targetSpecID,
			ChildRequestID:            operation.ChildRequestID(),
			CreatedAt:                 now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: domain.DeriveResourceID("event", "event-rebuild-requested", input.RequestID),
			AgentID: input.AgentID, AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion: 1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"actor_principal_id":            input.ActorPrincipalID,
				"source_agent_spec_revision_id": source.Spec.ID,
				"source_runtime_revision":       base.Agent.RuntimeRevision,
				"target_agent_spec_revision_id": targetSpecID,
				"template_id":                   targetSnapshot.TemplateID,
				"template_revision":             targetSnapshot.TemplateRevision,
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
	outcome, err := service.settleLifecycleExecution(ctx, state.Agent, state.Operation)
	if errors.Is(err, context.DeadlineExceeded) && ctx.Err() == nil && !service.clock.Now().Before(*state.Operation.DrainDeadlineAt) {
		return service.failRebuildPreservingSource(
			ctx, state, "run_drain_timeout", "Agent execution did not settle before the deadline", false,
		)
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
	attachment, err = service.setOperationNetworkAttachment(
		ctx, state.Operation, ports.NetworkAttachmentClosed, attachment,
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
	return service.advanceRebuild(ctx, state, ports.AdvanceAgentRebuild{
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
		Resources:          runtimeInput.Resources,
		MCPServers:         domain.CloneMCPServers(runtimeInput.MCPServers),
		ManagedMCPTemplate: mcpTemplateSource(state.Agent.OrganizationID, state.TargetSpec.Snapshot),
	}
	if err := service.attachPreparedSkills(ctx, state.Operation.RequestID, state.Agent.AgentID, state.Agent.OrganizationID, state.TargetSpec.Snapshot, &configuration); err != nil {
		return state, err
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
		if result.Effect == "not_started" && state.Agent.ExecutionRevisionID == "" {
			return service.failRebuildPreservingSource(ctx, state, code, result.ErrorDetail, false)
		}
		return service.reconcileRejectedRebuildRuntime(ctx, state, code, result.ErrorDetail)
	case "completed":
		if !completedProvisionedRuntime(result) {
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
	return service.advanceRebuild(ctx, state, ports.AdvanceAgentRebuild{
		RequestID:     state.Operation.RequestID,
		Fingerprint:   state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseRuntimeUpdate, NextPhase: domain.PhaseNetworkEnsure,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhaseNetworkEnsure),
		RuntimeResult:      &result,
		Now:                now,
	})
}

func (service *LifecycleService) reopenRebuildNetwork(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	if state.Operation.NetworkAttachment == nil {
		return ports.AgentRebuildState{}, fmt.Errorf("rebuild operation has no network attachment")
	}
	if state.Operation.RuntimeResult == nil {
		return state, ErrDependencyUnavailable
	}
	attachment, err := service.openRuntimeNetwork(ctx, state.Agent.AgentID, state.Operation.RuntimeResult.RuntimeRevision, *state.Operation.NetworkAttachment)
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
	return service.advanceRebuild(ctx, state, ports.AdvanceAgentRebuild{
		RequestID:     state.Operation.RequestID,
		Fingerprint:   state.Operation.RequestFingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(state.Operation.RequestID, domain.PhasePublish),
		NetworkAttachment:  &attachment, Now: service.clock.Now(),
	})
}

func (service *LifecycleService) advanceRebuild(ctx context.Context, state ports.AgentRebuildState, input ports.AdvanceAgentRebuild) (ports.AgentRebuildState, error) {
	result, err := service.store.AdvanceAgentRebuild(ctx, input)
	if err != nil {
		return state, err
	}
	state.Agent, state.Operation = result.Agent, result.Operation
	return state, nil
}

func (service *LifecycleService) publishAgentRebuild(
	ctx context.Context, state ports.AgentRebuildState,
) (ports.AgentRebuildState, error) {
	if state.Operation.RuntimeResult == nil {
		return ports.AgentRebuildState{}, fmt.Errorf("rebuild operation has no Runtime result")
	}
	runtime := *state.Operation.RuntimeResult
	now := service.clock.Now()
	accessRevision := domain.DeriveResourceID("accessrev", "access-rebuild", state.Operation.RequestID)
	published, err := service.store.PublishAgentRebuild(ctx, ports.PublishAgentRebuild{
		RequestID:      state.Operation.RequestID,
		Fingerprint:    state.Operation.RequestFingerprint,
		AccessRevision: accessRevision,
		RebuiltEvent: ports.AgentEventRecord{
			EventID:           domain.DeriveResourceID("event", "event-rebuilt", state.Operation.RequestID),
			AgentID:           state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuilt,
			OperationRequestID: state.Operation.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"agent_spec_revision_id": state.TargetSpec.ID,
				"runtime_revision":       runtime.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
	return published, err
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
	// Restore a still-bound source, or a target which has never had a binding.
	// A historical execution without a current binding is an invalidated source.
	canRestore := state.Agent.ExecutionRevisionID != "" || state.SourceExecution.ID == ""
	if state.Operation.NetworkAttachment != nil && state.Agent.HasConfiguredRuntime() && canRestore {
		if err := service.restoreNetworkUnlessRevoked(ctx, state.Operation, 0); err != nil {
			return state, fmt.Errorf("%w: runtime-egress attachment restoration", ErrDependencyUnavailable)
		}
	}
	return service.failAgentRebuild(ctx, state, code, detail, retryable, true, nil)
}

func (service *LifecycleService) restoreNetworkUnlessRevoked(ctx context.Context, operation ports.LifecycleOperationRecord, cause int64) error {
	agentID := operation.AgentID
	if cause > 0 || operation.SettlementOutcome == ports.ExecutionRuntimeBarrierRequired {
		return nil
	}
	attachment, err := service.egress.GetAgentNetwork(ctx, agentID)
	if err != nil {
		return err
	}
	base, err := service.store.GetAgentLifecycleBase(ctx, agentID)
	if err != nil {
		return fmt.Errorf("check owner revocation before network restoration: %w", err)
	}
	if base.Agent.IdentityRevoked() {
		return nil
	}
	attachment, err = service.setOperationNetworkAttachment(ctx, operation, ports.NetworkAttachmentOpen, attachment)
	if err != nil {
		return err
	}
	// Receipt can commit during the outbound RPC. Reclose a completed restoration
	// in that case; an ambiguous RPC remains the Activity retry's responsibility.
	base, err = service.store.GetAgentLifecycleBase(ctx, agentID)
	if err != nil {
		return err
	}
	if !base.Agent.IdentityRevoked() {
		return nil
	}
	_, err = service.setOperationNetworkAttachment(ctx, operation, ports.NetworkAttachmentClosed, attachment)
	return err
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
	// A rejected recovery update need not resurrect the historical process.
	// An unchanged logical head permits a management failure without assuming a live process.
	if state.Agent.ExecutionRevisionID == "" && inspection.AgentID == state.Agent.AgentID &&
		inspection.RuntimeRevision == state.Operation.SourceRuntimeRevision && inspection.LifecycleState == "provisioned" {
		return service.failRebuildPreservingSource(ctx, state, code, detail, false)
	}
	if exactRuntimeSource(
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
	return service.store.FailAgentRebuild(ctx, ports.FailAgentRebuild{
		RequestID:                 state.Operation.RequestID,
		Fingerprint:               state.Operation.RequestFingerprint,
		ExpectedAggregateSequence: state.Agent.AggregateSequence,
		Stage:                     state.Operation.Phase, Code: code, Detail: detail, Retryable: retryable,
		FailedEvent: ports.AgentEventRecord{
			EventID:       domain.DeriveResourceID("event", "event-rebuild-failed", state.Operation.RequestID),
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
		Now: now,
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

func resolveRebuildSource(base ports.AgentLifecycleBase) (ports.AgentRuntimeSource, error) {
	agent := base.Agent
	if agent.ActiveOperationRequestID != "" {
		return ports.AgentRuntimeSource{}, fmt.Errorf("%w: Agent already has an active lifecycle operation", ErrLifecycleConflict)
	}
	source := ports.AgentRuntimeSource{Spec: base.ConfiguredSpec, Execution: base.SourceExecution}
	if agent.DesiredState != domain.DesiredEnabled || agent.IdentityRevoked() || !source.MatchesAgent(agent) || base.NextSpecRevision <= source.Spec.Revision ||
		base.NextExecutionRevision <= source.Execution.Revision {
		return ports.AgentRuntimeSource{}, fmt.Errorf("%w: Agent has no complete rebuild source", ErrAgentNotReady)
	}
	return source, nil
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
