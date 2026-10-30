package orchestration

import (
	"context"
	"fmt"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/workflow"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const lifecycleAdmission = "admit_lifecycle"
const quarantineActivity = "quarantine_lifecycle"

func lifecycleActivity(phase domain.OperationPhase) string { return "lifecycle." + string(phase) }

func LifecycleWorkflow(ctx workflow.Context, command application.LifecycleCommand) error {
	return lifecycleWorkflow(ctx, command, defaultWorkerConfiguration())
}

func lifecycleWorkflow(ctx workflow.Context, command application.LifecycleCommand, configuration WorkerConfiguration) error {
	phases, err := domain.OperationPlan(command.Kind)
	if err != nil {
		return activityError(err)
	}
	return runWorkflow[application.LifecycleCommand, application.LifecycleResult](ctx, command, command.RequestID, lifecycleAdmission, phases, lifecycleActivity, configuration, nil)
}

func registerLifecycle(registry Registry, service *application.LifecycleService, configuration WorkerConfiguration) {
	registry.RegisterActivityWithOptions(func(ctx context.Context, input application.LifecycleFailure) error {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		return activityError(service.QuarantineLifecycle(ctx, input))
	}, activity.RegisterOptions{Name: quarantineActivity})
	registry.RegisterActivityWithOptions(func(ctx context.Context, input application.LifecycleTermination) (application.OperationView, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		operation, err := service.GetLifecycleOperation(ctx, input.RequestID)
		if err != nil {
			return application.OperationView{}, activityError(err)
		}
		if operation.State == domain.OperationRunning {
			input.Phase = operation.Phase
		}
		result, err := service.TerminateLifecycle(ctx, input)
		return result, activityError(err)
	}, activity.RegisterOptions{Name: terminationActivityName})
	registry.RegisterWorkflowWithOptions(func(ctx workflow.Context, command application.LifecycleCommand) error {
		return lifecycleWorkflow(ctx, command, configuration)
	}, workflow.RegisterOptions{Name: "LifecycleWorkflow"})
	registry.RegisterActivityWithOptions(func(ctx context.Context, input application.LifecycleCommand) (application.LifecycleResult, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		result, err := service.AdmitLifecycle(ctx, input)
		return result, activityError(err)
	}, activity.RegisterOptions{Name: lifecycleAdmission})
	registered := make(map[domain.OperationPhase]bool)
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable, domain.OperationEnable, domain.OperationDelete} {
		phases, err := domain.OperationPlan(kind)
		if err != nil {
			panic(err)
		}
		for _, phase := range phases {
			if registered[phase] {
				continue
			}
			registered[phase] = true
			registry.RegisterActivityWithOptions(func(ctx context.Context, input application.LifecycleCommand) (application.OperationView, error) {
				ctx, stop := activityLifetime(ctx)
				defer stop()
				result, err := service.AdvanceLifecycle(ctx, input, phase)
				return result, activityError(err)
			}, activity.RegisterOptions{Name: lifecycleActivity(phase)})
		}
	}
}

func (service *Service) RebuildAgent(ctx context.Context, input application.RebuildAgentInput) (application.RebuildAgentResult, error) {
	result, err := service.startLifecycle(ctx, application.LifecycleCommand{Kind: domain.OperationRebuild, RequestID: input.RequestID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID, TemplateID: input.TemplateID, TemplateRevision: input.TemplateRevision})
	return application.RebuildAgentResult(result), err
}

func (service *Service) DisableAgent(ctx context.Context, input application.DisableAgentInput) (application.DisableAgentResult, error) {
	result, err := service.startLifecycle(ctx, application.LifecycleCommand{Kind: domain.OperationDisable, RequestID: input.RequestID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID, OwnerRevocationSequence: input.OwnerRevocationSequence})
	return application.DisableAgentResult(result), err
}
func (service *Service) EnableAgent(ctx context.Context, input application.EnableAgentInput) (application.EnableAgentResult, error) {
	result, err := service.startLifecycle(ctx, application.LifecycleCommand{Kind: domain.OperationEnable, RequestID: input.RequestID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID})
	return application.EnableAgentResult(result), err
}
func (service *Service) DeleteAgent(ctx context.Context, input application.DeleteAgentInput) (application.DeleteAgentResult, error) {
	result, err := service.startLifecycle(ctx, application.LifecycleCommand{Kind: domain.OperationDelete, RequestID: input.RequestID, OrganizationID: input.OrganizationID, ActorPrincipalID: input.ActorPrincipalID, AgentID: input.AgentID})
	return application.DeleteAgentResult(result), err
}

func (service *Service) CancelLifecycleOperation(ctx context.Context, input application.CancelLifecycleOperationInput) (application.OperationView, error) {
	operation, err := service.GetCancellableLifecycleOperation(ctx, input)
	if err != nil {
		return application.OperationView{}, err
	}
	if operation.State != domain.OperationRunning {
		return operation, nil
	}
	reread := func(cause error) (application.OperationView, error) {
		latest, readErr := service.GetCancellableLifecycleOperation(ctx, input)
		if readErr != nil {
			return application.OperationView{}, fmt.Errorf("%w: reread cancelled operation: %v", application.ErrDependencyUnavailable, readErr)
		}
		if latest.State != domain.OperationRunning {
			return latest, nil
		}
		return application.OperationView{}, publicError(cause)
	}
	handle, err := service.client.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
		WorkflowID:   "agent-" + string(operation.Kind) + "/" + operation.RequestID,
		UpdateName:   cancelUpdateName,
		Args:         []interface{}{operation.RequestID},
		WaitForStage: client.WorkflowUpdateStageCompleted,
	})
	if err != nil {
		return reread(err)
	}
	var ignored interface{}
	if err := handle.Get(ctx, &ignored); err != nil {
		return reread(err)
	}
	return service.GetCancellableLifecycleOperation(ctx, input)
}

// DeleteFailedCreate admits a GC candidate into the normal durable delete
// workflow with a deterministic request ID derived from the failed create.
func (service *Service) DeleteFailedCreate(ctx context.Context, candidate ports.FailedCreateGCCandidate, cutoff time.Time) error {
	_, err := service.startLifecycle(ctx, application.LifecycleCommand{
		Kind: domain.OperationDelete,
		RequestID: domain.DeriveResourceID("request", "failed-create-gc-delete",
			candidate.CreateRequestID),
		AgentID:            candidate.AgentID,
		OrganizationID:     candidate.OrganizationID,
		ActorPrincipalID:   "system-failed-create-gc",
		FailedCreate:       &candidate,
		FailedCreateCutoff: cutoff,
	})
	return err
}

func (service *Service) startLifecycle(ctx context.Context, command application.LifecycleCommand) (application.LifecycleResult, error) {
	prefix := "agent-" + string(command.Kind)
	return startWorkflow(ctx, service.client, prefix+"/"+command.RequestID, LifecycleWorkflow, command, service.ReplayLifecycle)
}
