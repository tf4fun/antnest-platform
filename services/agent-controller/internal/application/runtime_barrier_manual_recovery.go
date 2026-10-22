package application

import (
	"context"
	"errors"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type RuntimeBarrierManualRecoveryInput struct {
	Command                 RebuildAgentInput
	BarrierID               string
	ExpectedRuntimeRevision string
}

func (input RuntimeBarrierManualRecoveryInput) Validate() error {
	command := input.Command
	if validateRebuildAgentInput(command) != nil ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(command.ActorPrincipalID) ||
		!domain.ValidRuntimeBarrierPolicyIdentifier(input.ExpectedRuntimeRevision) {
		return fmt.Errorf("%w: Runtime barrier recovery input", ErrInvalidInput)
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(command.OrganizationID, command.AgentID, input.BarrierID)
	if err != nil || requestID != command.RequestID {
		return fmt.Errorf("%w: Runtime barrier recovery identity", ErrInvalidInput)
	}
	return nil
}

type RuntimeBarrierManualRecoveryStore interface {
	ports.RuntimeBarrierRecoveryStore
	GetRuntimeBarrierRecoveryPolicy(context.Context, string) (domain.RuntimeBarrierRecoveryPolicy, error)
}

type RuntimeBarrierManualRecoveryService struct {
	lifecycle *LifecycleService
	store     RuntimeBarrierManualRecoveryStore
	reader    ports.RuntimeBarrierReader
}

func NewRuntimeBarrierManualRecoveryService(lifecycle *LifecycleService, store RuntimeBarrierManualRecoveryStore,
	reader ports.RuntimeBarrierReader,
) *RuntimeBarrierManualRecoveryService {
	return &RuntimeBarrierManualRecoveryService{lifecycle: lifecycle, store: store, reader: reader}
}

func WithRuntimeBarrierManualRecovery(store RuntimeBarrierManualRecoveryStore, reader ports.RuntimeBarrierReader) LifecycleOption {
	return func(service *LifecycleService) {
		service.manualRecovery = NewRuntimeBarrierManualRecoveryService(service, store, reader)
	}
}

func (service *LifecycleService) RecoverRuntimeBarrier(ctx context.Context, input RuntimeBarrierManualRecoveryInput) (RebuildAgentResult, error) {
	if service == nil || service.manualRecovery == nil {
		return RebuildAgentResult{}, ErrDependencyUnavailable
	}
	return service.manualRecovery.Recover(ctx, input)
}

// Recover follows the original durable operation before reading current
// configuration. Authentication is required at the HTTP boundary on every call;
// neither this intent nor a persisted receipt grants a caller authority.
func (service *RuntimeBarrierManualRecoveryService) Recover(ctx context.Context, input RuntimeBarrierManualRecoveryInput) (RebuildAgentResult, error) {
	if err := input.Validate(); err != nil {
		return RebuildAgentResult{}, err
	}
	if service == nil || service.lifecycle == nil || service.lifecycle.store == nil || service.store == nil || service.reader == nil {
		return RebuildAgentResult{}, ErrDependencyUnavailable
	}
	if err := ctx.Err(); err != nil {
		return RebuildAgentResult{}, err
	}
	command := input.Command
	admission := NewRuntimeBarrierRecoveryAdmissionService(service.lifecycle, service.store)
	scope := ports.RuntimeBarrierResult{OrganizationID: command.OrganizationID, AgentID: command.AgentID,
		RuntimeRevision: input.ExpectedRuntimeRevision, Barrier: &ports.RuntimeBarrier{BarrierID: input.BarrierID}}
	if result, found, err := admission.replay(ctx, scope); err != nil || found {
		if err != nil {
			return RebuildAgentResult{}, err
		}
		return manualRuntimeBarrierRecoveryResult(input, result)
	}
	base, err := service.lifecycle.store.GetAgentLifecycleBase(ctx, command.AgentID)
	if err := runtimeBarrierObservationCallError(ctx, err, "read manual Runtime recovery source"); err != nil {
		if errors.Is(err, ports.ErrNotFound) && ctx.Err() == nil {
			return RebuildAgentResult{}, ErrAgentNotFound
		}
		return RebuildAgentResult{}, err
	}
	agent, snapshot := base.Agent, base.ConfiguredSpec.Snapshot
	if agent.OrganizationID != command.OrganizationID {
		return RebuildAgentResult{}, ErrAgentNotFound
	}
	if agent.AgentID != command.AgentID || !domain.ValidRuntimeBarrierPolicyIdentifier(agent.OwnerUserID) ||
		agent.OwnerAuthorizationSequence < 0 || agent.IdentityRevocationSequence < 0 {
		return RebuildAgentResult{}, ErrQueryContract
	}
	if agent.RuntimeRevision != input.ExpectedRuntimeRevision || snapshot.TemplateID != command.TemplateID ||
		snapshot.TemplateRevision != command.TemplateRevision {
		return manualRuntimeBarrierRecoveryAfterConflict(ctx, admission, input, scope, ErrLifecycleConflict)
	}
	if _, err := resolveRebuildSource(base); err != nil {
		return manualRuntimeBarrierRecoveryAfterConflict(ctx, admission, input, scope, err)
	}
	query := ports.RuntimeBarrierQuery{OrganizationID: command.OrganizationID, AgentID: command.AgentID,
		ExpectedRuntimeRevision: input.ExpectedRuntimeRevision}
	fact, err := service.reader.GetRuntimeBarrier(ctx, query)
	if err := runtimeBarrierObservationCallError(ctx, err, "read manual Runtime recovery barrier"); err != nil {
		return RebuildAgentResult{}, err
	}
	if !fact.Matches(query) {
		return RebuildAgentResult{}, ErrQueryContract
	}
	if fact.Barrier == nil || fact.Barrier.BarrierID != input.BarrierID {
		return manualRuntimeBarrierRecoveryAfterConflict(ctx, admission, input, scope, ErrLifecycleConflict)
	}
	policy, err := service.store.GetRuntimeBarrierRecoveryPolicy(ctx, command.OrganizationID)
	if err := runtimeBarrierObservationCallError(ctx, err, "read manual Runtime recovery policy"); err != nil {
		return RebuildAgentResult{}, err
	}
	if policy.OrganizationID != command.OrganizationID || policy.Validate() != nil {
		return RebuildAgentResult{}, ErrQueryContract
	}
	result, err := admission.Admit(ctx, ports.RuntimeBarrierRecoveryIntent{
		Manual: true, Fact: fact, ExpectedPolicyRevision: policy.Revision,
		ExpectedOwnerUserID: agent.OwnerUserID, ExpectedOwnerAuthorizationSequence: agent.OwnerAuthorizationSequence,
		ExpectedIdentityRevocationSequence: agent.IdentityRevocationSequence,
		Command:                            ports.RuntimeBarrierRebuildCommand(command),
	})
	if err != nil {
		return RebuildAgentResult{}, err
	}
	return manualRuntimeBarrierRecoveryResult(input, result)
}

func manualRuntimeBarrierRecoveryAfterConflict(ctx context.Context, admission *RuntimeBarrierRecoveryAdmissionService,
	input RuntimeBarrierManualRecoveryInput, scope ports.RuntimeBarrierResult, original error,
) (RebuildAgentResult, error) {
	// Another observer or administrator may have committed the same tuple after
	// our initial miss. A changed binding or cleared barrier then belongs to the
	// original operation; it is not a reason to reject a valid original request.
	result, err := admission.replayAfterFailure(ctx, scope, original)
	if err != nil {
		return RebuildAgentResult{}, err
	}
	return manualRuntimeBarrierRecoveryResult(input, result)
}

func manualRuntimeBarrierRecoveryResult(input RuntimeBarrierManualRecoveryInput, result RuntimeBarrierRecoveryAdmissionResult) (RebuildAgentResult, error) {
	original := result.Receipt
	if original.Fact.RuntimeRevision != input.ExpectedRuntimeRevision || original.Command.TemplateID != input.Command.TemplateID ||
		original.Command.TemplateRevision != input.Command.TemplateRevision {
		return RebuildAgentResult{}, ErrLifecycleConflict
	}
	// The original actor, policy, fingerprint and pending-start command remain
	// immutable even when another currently authorized administrator replays it.
	return rebuildAgentResult(result.State), nil
}
