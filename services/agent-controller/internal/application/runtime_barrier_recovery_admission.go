package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type RuntimeBarrierRecoveryAdmissionResult struct {
	State    ports.AgentRebuildState
	Receipt  ports.RuntimeBarrierRecoveryReceipt
	Replayed bool
}

type RuntimeBarrierRecoveryAdmissionService struct {
	lifecycle *LifecycleService
	store     ports.RuntimeBarrierRecoveryStore
}

func NewRuntimeBarrierRecoveryAdmissionService(lifecycle *LifecycleService, store ports.RuntimeBarrierRecoveryStore) *RuntimeBarrierRecoveryAdmissionService {
	return &RuntimeBarrierRecoveryAdmissionService{lifecycle: lifecycle, store: store}
}

func (service *RuntimeBarrierRecoveryAdmissionService) Admit(ctx context.Context, intent ports.RuntimeBarrierRecoveryIntent) (RuntimeBarrierRecoveryAdmissionResult, error) {
	if !validRuntimeBarrierRecoveryFact(intent.Fact) {
		return RuntimeBarrierRecoveryAdmissionResult{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	if service == nil || service.lifecycle == nil || service.lifecycle.store == nil || service.store == nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, ErrDependencyUnavailable
	}
	if err := ctx.Err(); err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, err
	}
	// The tuple identifies a committed original. Current policy, owner or
	// Template observations cannot replace it or trigger new preparation.
	if result, found, err := service.replay(ctx, intent.Fact); found || err != nil {
		return result, err
	}
	input, err := runtimeBarrierRecoveryCommandInput(intent.Fact, intent.Command)
	if err != nil || intent.ExpectedPolicyRevision < 0 || intent.ExpectedPolicyRevision > domain.RuntimeBarrierRecoveryMaxRevision ||
		intent.ExpectedOwnerUserID == "" || intent.ExpectedOwnerAuthorizationSequence < 0 || intent.ExpectedIdentityRevocationSequence < 0 {
		return RuntimeBarrierRecoveryAdmissionResult{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	fingerprint, err := rebuildAgentFingerprint(input)
	if err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, err
	}
	// Ordinary lifecycle replay alone is insufficient. Only the atomic Begin
	// with Recovery metadata can establish the receipt and pending start.
	begin, err := service.lifecycle.prepareAgentRebuild(ctx, input, fingerprint)
	if err != nil {
		return service.replayAfterFailure(ctx, intent.Fact, err)
	}
	if err := ctx.Err(); err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, err
	}
	begin.Recovery = &intent
	state, replayed, err := service.lifecycle.store.BeginAgentRebuild(ctx, begin)
	if err != nil {
		return service.replayAfterFailure(ctx, intent.Fact, fmt.Errorf("begin Runtime barrier recovery: %w", err))
	}
	receipt, found, err := service.readReceipt(ctx, intent.Fact)
	if err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, err
	}
	if !found || !runtimeBarrierRecoveryStateMatches(state, receipt) {
		return RuntimeBarrierRecoveryAdmissionResult{}, ErrQueryContract
	}
	return RuntimeBarrierRecoveryAdmissionResult{State: state, Receipt: receipt, Replayed: replayed}, nil
}

func validRuntimeBarrierRecoveryFact(fact ports.RuntimeBarrierResult) bool {
	return domain.ValidRuntimeBarrierPolicyIdentifier(fact.OrganizationID) &&
		domain.ValidRuntimeBarrierPolicyIdentifier(fact.AgentID) && fact.Barrier != nil &&
		fact.Matches(ports.RuntimeBarrierQuery{OrganizationID: fact.OrganizationID, AgentID: fact.AgentID, ExpectedRuntimeRevision: fact.RuntimeRevision})
}

func runtimeBarrierRecoveryCommandInput(fact ports.RuntimeBarrierResult, command ports.RuntimeBarrierRebuildCommand) (RebuildAgentInput, error) {
	input := RebuildAgentInput(command)
	if !validRuntimeBarrierRecoveryFact(fact) || command.OrganizationID != fact.OrganizationID ||
		command.AgentID != fact.AgentID || command.ActorPrincipalID != "agent-controller" || validateRebuildAgentInput(input) != nil {
		return RebuildAgentInput{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	if err != nil || command.RequestID != requestID {
		return RebuildAgentInput{}, ports.ErrInvalidRuntimeBarrierRecovery
	}
	return input, nil
}

func (service *RuntimeBarrierRecoveryAdmissionService) readReceipt(ctx context.Context, fact ports.RuntimeBarrierResult) (ports.RuntimeBarrierRecoveryReceipt, bool, error) {
	if err := ctx.Err(); err != nil {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, err
	}
	receipt, found, err := service.store.ReplayRuntimeBarrierRecovery(ctx, fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	if cancelled := ctx.Err(); cancelled != nil {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, errors.Join(err, cancelled)
	}
	if err != nil {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, fmt.Errorf("read Runtime barrier recovery receipt: %w", err)
	}
	if !found {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, nil
	}
	input, err := runtimeBarrierRecoveryCommandInput(receipt.Fact, receipt.Command)
	if err != nil || receipt.Fact.OrganizationID != fact.OrganizationID || receipt.Fact.AgentID != fact.AgentID ||
		receipt.Fact.Barrier.BarrierID != fact.Barrier.BarrierID || receipt.Policy.OrganizationID != fact.OrganizationID ||
		receipt.Policy.Validate() != nil || receipt.Policy.Mode != "auto" || receipt.AcceptedAt.IsZero() ||
		!receipt.CooldownUntil.Equal(receipt.AcceptedAt.Add(time.Duration(receipt.Policy.CooldownMS)*time.Millisecond)) {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, ErrQueryContract
	}
	fingerprint, err := rebuildAgentFingerprint(input)
	if err != nil || fingerprint != receipt.RequestFingerprint {
		return ports.RuntimeBarrierRecoveryReceipt{}, false, ErrQueryContract
	}
	return receipt, true, nil
}

func runtimeBarrierRecoveryStateMatches(state ports.AgentRebuildState, receipt ports.RuntimeBarrierRecoveryReceipt) bool {
	command, operation, target := receipt.Command, state.Operation, state.TargetSpec
	return state.Agent.OrganizationID == command.OrganizationID && state.Agent.AgentID == command.AgentID &&
		operation.RequestID == command.RequestID && operation.RequestFingerprint == receipt.RequestFingerprint &&
		operation.AgentID == command.AgentID && operation.Kind == domain.OperationRebuild &&
		operation.SourceRuntimeRevision == receipt.Fact.RuntimeRevision &&
		target.AgentID == command.AgentID && target.ID == operation.TargetSpecRevisionID &&
		target.Snapshot.TemplateID == command.TemplateID && target.Snapshot.TemplateRevision == command.TemplateRevision &&
		operation.CreatedAt.Equal(receipt.AcceptedAt)
}

func (service *RuntimeBarrierRecoveryAdmissionService) replay(ctx context.Context, fact ports.RuntimeBarrierResult) (RuntimeBarrierRecoveryAdmissionResult, bool, error) {
	receipt, found, err := service.readReceipt(ctx, fact)
	if err != nil || !found {
		return RuntimeBarrierRecoveryAdmissionResult{}, found, err
	}
	state, operationFound, err := service.lifecycle.store.ReplayAgentRebuild(ctx, receipt.Command.RequestID, receipt.RequestFingerprint)
	if cancelled := ctx.Err(); cancelled != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, false, errors.Join(err, cancelled)
	}
	if err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, false, fmt.Errorf("replay Runtime barrier lifecycle: %w", err)
	}
	if !operationFound || !runtimeBarrierRecoveryStateMatches(state, receipt) {
		return RuntimeBarrierRecoveryAdmissionResult{}, false, ErrQueryContract
	}
	return RuntimeBarrierRecoveryAdmissionResult{State: state, Receipt: receipt, Replayed: true}, true, nil
}

func (service *RuntimeBarrierRecoveryAdmissionService) replayAfterFailure(ctx context.Context, fact ports.RuntimeBarrierResult, original error) (RuntimeBarrierRecoveryAdmissionResult, error) {
	// Cancellation is not a reason to issue another dependency call. A later
	// observation or the pending-start worker can recover the durable command.
	if err := ctx.Err(); err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, errors.Join(original, err)
	}
	result, found, err := service.replay(ctx, fact)
	if err != nil {
		return RuntimeBarrierRecoveryAdmissionResult{}, errors.Join(original, err)
	}
	if found {
		return result, nil
	}
	return RuntimeBarrierRecoveryAdmissionResult{}, original
}
