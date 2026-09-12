// Package orchestration adapts durable execution to the controller application.
package orchestration

import (
	"errors"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
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
	return runWorkflow[application.CreateAgentInput, application.CreateAgentResult](ctx, command, command.RequestID, AdmitActivity, createPhases, func(phase domain.OperationPhase) string { return string(phase) })
}

func runWorkflow[I comparable, R any](ctx workflow.Context, command I, requestID string, admit string, phases []domain.OperationPhase, activityName func(domain.OperationPhase) string) error {
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
				if input != command {
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
