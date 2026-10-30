// Package orchestration adapts durable execution to the controller application.
package orchestration

import (
	"errors"
	"reflect"
	"time"

	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

const (
	AdmitActivity   = "admit_agent"
	admissionUpdate = "admission"
	TaskQueue       = "agent-lifecycle"
)

var createPhases = []domain.OperationPhase{
	domain.PhaseNetworkEnsure, domain.PhaseRuntimeInitialize, domain.PhasePublish,
}

func CreateAgentWorkflow(ctx workflow.Context, command application.CreateAgentInput) error {
	return createAgentWorkflow(ctx, command, defaultWorkerConfiguration())
}

func createAgentWorkflow(ctx workflow.Context, command application.CreateAgentInput, configuration WorkerConfiguration) error {
	return runWorkflow[application.CreateAgentInput, application.CreateAgentResult](ctx, command, command.RequestID, AdmitActivity, createPhases, func(phase domain.OperationPhase) string { return string(phase) }, configuration, createCancellationCleanup)
}

func createCancellationCleanup(ctx workflow.Context, admission application.CreateAgentResult, command application.CreateAgentInput) error {
	deleteRequestID := domain.DeriveResourceID("request", "lifecycle-cancel-delete", command.RequestID)
	childCtx := workflow.WithChildOptions(workflow.WithTaskQueue(ctx, workflow.GetInfo(ctx).TaskQueueName), workflow.ChildWorkflowOptions{
		WorkflowID:            "agent-delete/" + deleteRequestID,
		ParentClosePolicy:     enums.PARENT_CLOSE_POLICY_ABANDON,
		WorkflowIDReusePolicy: enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
	})
	return workflow.ExecuteChildWorkflow(childCtx, LifecycleWorkflow, application.LifecycleCommand{
		Kind: domain.OperationDelete, RequestID: deleteRequestID,
		AgentID: admission.Agent.AgentID, OrganizationID: command.OrganizationID,
		ActorPrincipalID: command.ActorPrincipalID,
	}).GetChildWorkflowExecution().Get(ctx, nil)
}

var lifecycleRetryPolicy = &temporal.RetryPolicy{
	InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: time.Minute,
}

func runWorkflow[I any, R any](ctx workflow.Context, command I, requestID string, admit string, phases []domain.OperationPhase, activityName func(domain.OperationPhase) string, configuration WorkerConfiguration, onCancelled func(workflow.Context, R, I) error) error {
	if workflow.GetVersion(ctx, lifecycleReliabilityVersionID, workflow.DefaultVersion, 1) == workflow.DefaultVersion {
		return runLegacyWorkflow[I, R](ctx, command, requestID, admit, phases, activityName)
	}
	return runReliableWorkflow(ctx, command, requestID, admit, phases, activityName, configuration, onCancelled)
}

func runLegacyWorkflow[I any, R any](ctx workflow.Context, command I, requestID string, admit string, phases []domain.OperationPhase, activityName func(domain.OperationPhase) string) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 15 * time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: time.Minute,
		},
	})
	var admitted bool
	var admission R
	var admissionErr error
	err := workflow.SetUpdateHandlerWithOptions(ctx, admissionUpdate,
		func(ctx workflow.Context, _ I) (R, error) {
			if err := workflow.Await(ctx, func() bool { return admitted }); err != nil {
				return admission, err
			}
			return admission, admissionErr
		}, workflow.UpdateHandlerOptions{
			Validator: func(input I) error {
				if !reflect.DeepEqual(input, command) {
					return temporal.NewNonRetryableApplicationError("request identity conflict", "request_conflict", nil)
				}
				return nil
			},
		})
	if err != nil {
		return err
	}
	admissionErr = workflow.ExecuteActivity(ctx, admit, command).Get(ctx, &admission)
	admitted = true
	if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
		return err
	}
	if admissionErr != nil {
		return admissionErr
	}
	for _, phase := range phases {
		var operation application.OperationView
		if err := workflow.ExecuteActivity(ctx, activityName(phase), command).Get(ctx, &operation); err != nil {
			var failure *temporal.ApplicationError
			if errors.As(err, &failure) && failure.NonRetryable() {
				if saveErr := workflow.ExecuteActivity(ctx, quarantineActivity, application.LifecycleFailure{RequestID: requestID, Phase: phase, Detail: failure.Message()}).Get(ctx, nil); saveErr != nil {
					return saveErr
				}
			}
			return err
		}
		if operation.State == domain.OperationFailed {
			return temporal.NewNonRetryableApplicationError(operation.ErrorCode, "build_failed", nil)
		}
	}
	return workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) })
}
