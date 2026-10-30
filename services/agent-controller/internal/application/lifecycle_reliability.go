package application

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strconv"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type LifecycleTermination struct {
	RequestID string
	Phase     domain.OperationPhase
	Code      string
	Detail    string
}

var lifecycleTerminationCodes = map[string]bool{
	"phase_deadline_exceeded": true,
	"lifecycle_cancelled":     true,
}

func (service *LifecycleService) TerminateLifecycle(
	ctx context.Context, input LifecycleTermination,
) (OperationView, error) {
	if !validIdentifier(input.RequestID) || !lifecycleTerminationCodes[input.Code] {
		return OperationView{}, fmt.Errorf("%w: lifecycle termination", ErrInvalidInput)
	}
	operation, err := service.store.GetLifecycleOperation(ctx, input.RequestID)
	if err != nil {
		return OperationView{}, err
	}
	if operation.RequestID != input.RequestID {
		return OperationView{}, fmt.Errorf("%w: lifecycle termination scope", ErrInvalidInput)
	}
	if operation.State != domain.OperationRunning {
		return service.terminatedLifecycleResult(ctx, operation, input.Code)
	}
	plan, err := domain.OperationPlan(operation.Kind)
	if err != nil || !slices.Contains(plan, input.Phase) {
		return OperationView{}, fmt.Errorf("%w: lifecycle termination phase", ErrInvalidInput)
	}
	if operation.Phase != input.Phase {
		return OperationView{}, ports.ErrConcurrentChange
	}
	reliability, ok := service.store.(ports.LifecycleReliabilityStore)
	if !ok {
		return OperationView{}, fmt.Errorf("%w: lifecycle termination", ErrDependencyUnavailable)
	}
	record, err := reliability.TerminateLifecycleOperation(ctx, ports.TerminateLifecycleOperation{
		RequestID: input.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: input.Phase, ErrorCode: input.Code, ErrorDetail: input.Detail,
		EventID: domain.DeriveResourceID("event", "lifecycle-terminated", input.RequestID),
		TraceID: currentTraceID(ctx),
	})
	if err != nil {
		return OperationView{}, err
	}
	return service.terminatedLifecycleResult(ctx, record, input.Code)
}

func (service *LifecycleService) terminatedLifecycleResult(ctx context.Context, record ports.LifecycleOperationRecord, code string) (OperationView, error) {
	if record.State == domain.OperationFailed && record.ErrorCode == code &&
		(record.Kind == domain.OperationCreate || record.Kind == domain.OperationRebuild || record.Kind == domain.OperationEnable) {
		// Commit the terminal operation before releasing the RC preparation.
		// Replayed termination must finish an unconfirmed release as well.
		if err := service.releasePreparedSkills(ctx, record.RequestID, record.RequestFingerprint); err != nil {
			return OperationView{}, err
		}
	}
	return lifecycleOperationView(record), nil
}

type CancelLifecycleOperationInput struct {
	OrganizationID     string
	ActorPrincipalID   string
	AgentID            string
	OperationRequestID string
}

func (service *LifecycleService) GetCancellableLifecycleOperation(
	ctx context.Context, input CancelLifecycleOperationInput,
) (OperationView, error) {
	if !validIdentifier(input.OrganizationID) || !validIdentifier(input.ActorPrincipalID) ||
		!validIdentifier(input.AgentID) || !validIdentifier(input.OperationRequestID) {
		return OperationView{}, fmt.Errorf("%w: lifecycle cancel", ErrInvalidInput)
	}
	operation, err := service.store.GetLifecycleOperation(ctx, input.OperationRequestID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return OperationView{}, fmt.Errorf("%w: Agent", ErrAgentNotFound)
		}
		return OperationView{}, err
	}
	if operation.RequestID != input.OperationRequestID || operation.AgentID != input.AgentID {
		return OperationView{}, fmt.Errorf("%w: Agent scope", ErrAgentNotFound)
	}
	base, err := service.store.GetAgentLifecycleBase(ctx, operation.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return OperationView{}, fmt.Errorf("%w: Agent", ErrAgentNotFound)
		}
		return OperationView{}, err
	}
	if base.Agent.OrganizationID != input.OrganizationID {
		return OperationView{}, fmt.Errorf("%w: Agent scope", ErrAgentNotFound)
	}
	return lifecycleOperationView(operation), nil
}

type ClearLifecycleQuarantineInput struct {
	OrganizationID            string
	ActorPrincipalID          string
	AgentID                   string
	ExpectedAggregateSequence int64
}

const maximumAggregateSequence = 9007199254740991

func (service *LifecycleService) ClearLifecycleQuarantine(
	ctx context.Context, input ClearLifecycleQuarantineInput,
) (AgentView, error) {
	if !validIdentifier(input.OrganizationID) || !validIdentifier(input.ActorPrincipalID) ||
		!validIdentifier(input.AgentID) ||
		input.ExpectedAggregateSequence < 1 ||
		input.ExpectedAggregateSequence > maximumAggregateSequence {
		return AgentView{}, fmt.Errorf("%w: quarantine clear", ErrInvalidInput)
	}
	base, err := service.store.GetAgentLifecycleBase(ctx, input.AgentID)
	if err != nil {
		if errors.Is(err, ports.ErrNotFound) {
			return AgentView{}, fmt.Errorf("%w: Agent", ErrAgentNotFound)
		}
		return AgentView{}, err
	}
	if base.Agent.OrganizationID != input.OrganizationID {
		return AgentView{}, fmt.Errorf("%w: Agent scope", ErrAgentNotFound)
	}
	if base.Agent.AggregateSequence != input.ExpectedAggregateSequence {
		return AgentView{}, fmt.Errorf("%w: aggregate sequence", ErrLifecycleConflict)
	}
	if !ports.CanClearLifecycleQuarantine(base) {
		return AgentView{}, fmt.Errorf("%w: lifecycle invariants", ErrLifecycleConflict)
	}
	reliability, ok := service.store.(ports.LifecycleReliabilityStore)
	if !ok {
		return AgentView{}, fmt.Errorf("%w: quarantine clear", ErrDependencyUnavailable)
	}
	if service.runtime == nil {
		return AgentView{}, fmt.Errorf("%w: Runtime inspection", ErrDependencyUnavailable)
	}
	inspection, err := service.runtime.InspectRuntime(ctx, input.AgentID)
	if err != nil {
		return AgentView{}, fmt.Errorf("%w: Runtime inspection: %v", ErrDependencyUnavailable, err)
	}
	if !ports.ValidQuarantineRuntimeInspection(base.Agent, inspection) {
		return AgentView{}, fmt.Errorf("%w: Runtime inspection invariant", ErrLifecycleConflict)
	}
	agent, err := reliability.ClearLifecycleQuarantine(ctx, ports.ClearLifecycleQuarantine{
		OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID,
		AgentID: input.AgentID, ExpectedAggregateSequence: input.ExpectedAggregateSequence,
		ExpectedSpecRevisionID:                    base.ConfiguredSpec.ID,
		ExpectedRuntimeRevision:                   base.Agent.RuntimeRevision,
		ExpectedLastSuccessfulExecutionRevisionID: base.Agent.LastSuccessfulExecutionRevisionID,
		Inspection: inspection,
		EventID: domain.DeriveResourceID("event", "lifecycle-quarantine-cleared",
			input.AgentID+":"+strconv.FormatInt(input.ExpectedAggregateSequence, 10)),
		TraceID: currentTraceID(ctx),
	})
	if err != nil {
		if errors.Is(err, ports.ErrConcurrentChange) {
			return AgentView{}, fmt.Errorf("%w: %v", ErrLifecycleConflict, err)
		}
		return AgentView{}, err
	}
	return agentView(agent), nil
}
