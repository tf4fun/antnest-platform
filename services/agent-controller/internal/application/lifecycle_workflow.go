package application

import (
	"context"
	"fmt"
	"slices"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

// LifecycleCommand carries intent only. Execution source snapshots are resolved
// and frozen by admission, never reconstructed from mutable Agent configuration.
type LifecycleCommand struct {
	Kind                    domain.OperationKind
	RequestID               string
	OrganizationID          string
	ActorPrincipalID        string
	AgentID                 string
	TemplateID              string
	TemplateRevision        int64
	OwnerRevocationSequence int64
}

type LifecycleResult struct {
	Agent     AgentView
	Operation OperationView
}

func lifecycleReplayError(kind string, found bool, err error) error {
	if err != nil {
		return fmt.Errorf("load %s lifecycle: %w", kind, err)
	}
	if !found {
		return fmt.Errorf("load %s lifecycle: %w", kind, ports.ErrNotFound)
	}
	return nil
}

type LifecycleFailure struct {
	RequestID string
	Phase     domain.OperationPhase
	Detail    string
}

func (service *LifecycleService) QuarantineLifecycle(ctx context.Context, failure LifecycleFailure) error {
	operation, err := service.store.GetLifecycleOperation(ctx, failure.RequestID)
	if err != nil {
		return err
	}
	return service.store.QuarantineLifecycleOperation(ctx, ports.QuarantineLifecycleOperation{
		RequestID: failure.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: failure.Phase, ErrorCode: "lifecycle_invariant_failed", ErrorDetail: failure.Detail,
		EventID: domain.DeriveResourceID("event", "event-lifecycle-quarantined", failure.RequestID), TraceID: currentTraceID(ctx),
	})
}

func (command LifecycleCommand) rebuild() RebuildAgentInput {
	input := RebuildAgentInput{RequestID: command.RequestID, OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID, TemplateID: command.TemplateID, TemplateRevision: command.TemplateRevision}
	return input
}
func (command LifecycleCommand) disable() DisableAgentInput {
	return DisableAgentInput{RequestID: command.RequestID, OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID, OwnerRevocationSequence: command.OwnerRevocationSequence}
}
func (command LifecycleCommand) enable() EnableAgentInput {
	return EnableAgentInput{RequestID: command.RequestID, OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID}
}
func (command LifecycleCommand) delete() DeleteAgentInput {
	return DeleteAgentInput{RequestID: command.RequestID, OrganizationID: command.OrganizationID, ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID}
}

func (service *LifecycleService) AdmitLifecycle(ctx context.Context, command LifecycleCommand) (LifecycleResult, error) {
	switch command.Kind {
	case domain.OperationRebuild:
		result, err := service.rebuildAgent(ctx, command.rebuild())
		return LifecycleResult(result), err
	case domain.OperationDisable:
		result, err := service.DisableAgent(ctx, command.disable())
		return LifecycleResult(result), err
	case domain.OperationEnable:
		result, err := service.EnableAgent(ctx, command.enable())
		return LifecycleResult(result), err
	case domain.OperationDelete:
		result, err := service.DeleteAgent(ctx, command.delete())
		return LifecycleResult(result), err
	default:
		return LifecycleResult{}, fmt.Errorf("%w: lifecycle kind %q", ErrInvalidInput, command.Kind)
	}
}

type lifecycleStage struct {
	result LifecycleResult
	step   func(context.Context) (OperationView, error)
}

func (service *LifecycleService) ReplayLifecycle(ctx context.Context, command LifecycleCommand) (LifecycleResult, bool, error) {
	stage, found, err := service.lifecycleStage(ctx, command)
	return stage.result, found, err
}

func (service *LifecycleService) AdvanceLifecycle(ctx context.Context, command LifecycleCommand, phase domain.OperationPhase) (OperationView, error) {
	stage, found, err := service.lifecycleStage(ctx, command)
	if err != nil {
		return OperationView{}, err
	}
	if !found {
		return OperationView{}, ports.ErrNotFound
	}
	result, err := advanceStage(ctx, command.Kind, stage, phase)
	if err != nil {
		return result, err
	}
	if (result.State == domain.OperationCompleted || result.State == domain.OperationFailed) && (command.Kind == domain.OperationRebuild || command.Kind == domain.OperationEnable) {
		var fingerprint string
		if command.Kind == domain.OperationRebuild {
			fingerprint, err = rebuildAgentFingerprint(command.rebuild())
		} else {
			fingerprint, err = enableAgentFingerprint(command.enable())
		}
		if err != nil {
			return OperationView{}, err
		}
		if err := service.releasePreparedSkills(ctx, command.RequestID, fingerprint); err != nil {
			return OperationView{}, err
		}
	}
	return result, nil
}

func advanceStage(ctx context.Context, kind domain.OperationKind, stage lifecycleStage, phase domain.OperationPhase) (OperationView, error) {
	plan, err := domain.OperationPlan(kind)
	if err != nil {
		return OperationView{}, err
	}
	operation := stage.result.Operation
	expected, current := slices.Index(plan, phase), slices.Index(plan, operation.Phase)
	if expected < 0 || (operation.State == domain.OperationRunning && (current < 0 || current < expected)) {
		return OperationView{}, fmt.Errorf("%w: %s phase %s is not ready", ErrInvalidInput, kind, phase)
	}
	if operation.State != domain.OperationRunning || current > expected {
		return operation, nil
	}
	next, err := stage.step(ctx)
	if err != nil {
		return OperationView{}, err
	}
	if next.State == domain.OperationRunning && next.Phase == phase {
		return OperationView{}, fmt.Errorf("%w: %s is still pending", ErrDependencyUnavailable, phase)
	}
	return next, nil
}

func loadLifecycleStage[I, S any](ctx context.Context, input I, requestID, organizationID string,
	validate func(I) error, fingerprint func(I) (string, error),
	replay func(context.Context, string, string) (S, bool, error),
	view func(S) LifecycleResult, step func(context.Context, S) (S, error),
) (lifecycleStage, bool, error) {
	if err := validate(input); err != nil {
		return lifecycleStage{}, false, err
	}
	digest, err := fingerprint(input)
	if err != nil {
		return lifecycleStage{}, false, err
	}
	state, found, err := replay(ctx, requestID, digest)
	if err != nil || !found {
		return lifecycleStage{}, found, err
	}
	result := view(state)
	if !lifecycleScopeMatches(result.Agent.OrganizationID, organizationID) {
		return lifecycleStage{}, false, ErrAgentNotFound
	}
	return lifecycleStage{result: result, step: func(ctx context.Context) (OperationView, error) {
		next, err := step(ctx, state)
		return view(next).Operation, err
	}}, true, nil
}

func (service *LifecycleService) lifecycleStage(ctx context.Context, command LifecycleCommand) (lifecycleStage, bool, error) {
	switch command.Kind {
	case domain.OperationRebuild:
		return loadLifecycleStage(ctx, command.rebuild(), command.RequestID, command.OrganizationID, validateRebuildAgentInput, rebuildAgentFingerprint, service.store.ReplayAgentRebuild,
			func(s ports.AgentRebuildState) LifecycleResult { return LifecycleResult(rebuildAgentResult(s)) }, service.stepAgentRebuild)
	case domain.OperationDisable:
		return loadLifecycleStage(ctx, command.disable(), command.RequestID, command.OrganizationID, validateDisableAgentInput, disableAgentFingerprint, service.store.ReplayAgentDisable,
			func(s ports.AgentDisableState) LifecycleResult { return LifecycleResult(disableAgentResult(s)) }, service.stepAgentDisable)
	case domain.OperationEnable:
		return loadLifecycleStage(ctx, command.enable(), command.RequestID, command.OrganizationID, validateEnableAgentInput, enableAgentFingerprint, service.store.ReplayAgentEnable,
			func(s ports.AgentEnableState) LifecycleResult { return LifecycleResult(enableAgentResult(s)) }, service.stepAgentEnable)
	case domain.OperationDelete:
		return loadLifecycleStage(ctx, command.delete(), command.RequestID, command.OrganizationID, validateDeleteAgentInput, deleteAgentFingerprint, service.store.ReplayAgentDelete,
			func(s ports.AgentDeleteState) LifecycleResult { return LifecycleResult(deleteAgentResult(s)) }, service.stepAgentDelete)
	default:
		return lifecycleStage{}, false, fmt.Errorf("%w: lifecycle kind %q", ErrInvalidInput, command.Kind)
	}
}
