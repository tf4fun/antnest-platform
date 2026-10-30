package orchestration

import (
	"errors"
	"reflect"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

const (
	lifecycleReliabilityVersionID = "lifecycle-reliability-v1"
	terminationActivityName       = "terminate_lifecycle"
	cancelUpdateName              = "cancel_lifecycle_operation"
)

type WorkerConfiguration struct {
	PhaseDeadlines map[string]time.Duration
	BuildID        string
}

func defaultPhaseDeadlines() map[string]time.Duration {
	return map[string]time.Duration{
		"network_ensure":     10 * time.Minute,
		"runtime_initialize": 30 * time.Minute,
		"publish":            10 * time.Minute,
		"default":            10 * time.Minute,
	}
}

func defaultWorkerConfiguration() WorkerConfiguration {
	return WorkerConfiguration{PhaseDeadlines: defaultPhaseDeadlines()}
}

func normalizeWorkerConfiguration(configurations []WorkerConfiguration) WorkerConfiguration {
	configuration := defaultWorkerConfiguration()
	if len(configurations) == 0 {
		return configuration
	}
	configuration.BuildID = configurations[0].BuildID
	deadlines := defaultPhaseDeadlines()
	for phase, deadline := range configurations[0].PhaseDeadlines {
		if deadline > 0 {
			deadlines[phase] = deadline
		}
	}
	configuration.PhaseDeadlines = deadlines
	return configuration
}

func phaseDeadline(deadlines map[string]time.Duration, phase domain.OperationPhase) time.Duration {
	if deadline, ok := deadlines[string(phase)]; ok && deadline > 0 {
		return deadline
	}
	return deadlines["default"]
}

func boundedActivityOptions(deadline time.Duration) workflow.ActivityOptions {
	startToClose := 15 * time.Minute
	if deadline < startToClose {
		startToClose = deadline
	}
	return workflow.ActivityOptions{
		ScheduleToCloseTimeout: deadline,
		StartToCloseTimeout:    startToClose,
		HeartbeatTimeout:       30 * time.Second,
		WaitForCancellation:    true,
		RetryPolicy:            lifecycleRetryPolicy,
	}
}

func executeLifecycleTermination(ctx workflow.Context, requestID string, phase domain.OperationPhase, code, detail string) (application.OperationView, error) {
	disconnected, _ := workflow.NewDisconnectedContext(ctx)
	disconnected = workflow.WithActivityOptions(disconnected, workflow.ActivityOptions{
		StartToCloseTimeout: time.Minute,
		HeartbeatTimeout:    30 * time.Second,
		WaitForCancellation: true,
	})
	var operation application.OperationView
	err := workflow.ExecuteActivity(disconnected, terminationActivityName, application.LifecycleTermination{
		RequestID: requestID, Phase: phase, Code: code, Detail: detail,
	}).Get(disconnected, &operation)
	return operation, err
}

func runReliableWorkflow[I any, R any](ctx workflow.Context, command I, requestID string, admit string, phases []domain.OperationPhase, activityName func(domain.OperationPhase) string, configuration WorkerConfiguration, onCancelled func(workflow.Context, R, I) error) error {
	var frozen WorkerConfiguration
	if err := workflow.SideEffect(ctx, func(ctx workflow.Context) interface{} {
		return configuration
	}).Get(&frozen); err != nil {
		return err
	}
	deadlines := normalizeWorkerConfiguration([]WorkerConfiguration{frozen}).PhaseDeadlines

	var admitted bool
	var admission R
	var admissionErr error
	var cancellationRequested bool
	var completed bool
	var activeCancel func()

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
	err = workflow.SetUpdateHandlerWithOptions(ctx, cancelUpdateName,
		func(ctx workflow.Context, _ string) error {
			if completed {
				return nil
			}
			cancellationRequested = true
			if activeCancel != nil {
				activeCancel()
			}
			return nil
		}, workflow.UpdateHandlerOptions{
			Validator: func(input string) error {
				if input != requestID {
					return temporal.NewNonRetryableApplicationError("request identity conflict", "request_conflict", nil)
				}
				return nil
			},
		})
	if err != nil {
		return err
	}

	controlCtx := workflow.WithActivityOptions(ctx, boundedActivityOptions(phaseDeadline(deadlines, "default")))
	admissionErr = workflow.ExecuteActivity(controlCtx, admit, command).Get(ctx, &admission)
	admitted = true
	if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
		return err
	}
	if admissionErr != nil {
		return admissionErr
	}

	currentPhase := phases[0]
	for _, phase := range phases {
		if cancellationRequested {
			break
		}
		currentPhase = phase
		phaseCtx, cancelPhase := workflow.WithCancel(ctx)
		activeCancel = cancelPhase
		var operation application.OperationView
		phaseErr := workflow.ExecuteActivity(
			workflow.WithActivityOptions(phaseCtx, boundedActivityOptions(phaseDeadline(deadlines, phase))),
			activityName(phase), command).Get(ctx, &operation)
		activeCancel = nil
		cancelPhase()
		if phaseErr == nil {
			if operation.State == domain.OperationCompleted {
				completed = true
				break
			}
			if operation.State == domain.OperationFailed {
				return temporal.NewNonRetryableApplicationError(operation.ErrorCode, "build_failed", nil)
			}
			continue
		}
		if cancellationRequested {
			break
		}
		var timeoutErr *temporal.TimeoutError
		if errors.As(phaseErr, &timeoutErr) {
			terminated, terminateErr := executeLifecycleTermination(ctx, requestID, phase,
				"phase_deadline_exceeded", "phase "+string(phase)+" exceeded its deadline")
			if terminateErr != nil {
				return terminateErr
			}
			if terminated.State == domain.OperationCompleted {
				completed = true
				break
			}
			code := terminated.ErrorCode
			if code == "" {
				code = "phase_deadline_exceeded"
			}
			if code != "phase_deadline_exceeded" {
				return temporal.NewNonRetryableApplicationError(terminated.ErrorDetail, code, nil)
			}
			if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
				return err
			}
			return temporal.NewNonRetryableApplicationError(terminated.ErrorDetail, "phase_deadline_exceeded", nil)
		}
		var failure *temporal.ApplicationError
		if errors.As(phaseErr, &failure) && failure.NonRetryable() {
			disconnected, _ := workflow.NewDisconnectedContext(ctx)
			disconnected = workflow.WithActivityOptions(disconnected, boundedActivityOptions(phaseDeadline(deadlines, "default")))
			if saveErr := workflow.ExecuteActivity(disconnected, quarantineActivity, application.LifecycleFailure{RequestID: requestID, Phase: phase, Detail: failure.Message()}).Get(disconnected, nil); saveErr != nil {
				return saveErr
			}
		}
		return phaseErr
	}
	if cancellationRequested && !completed {
		terminated, terminateErr := executeLifecycleTermination(ctx, requestID, currentPhase,
			"lifecycle_cancelled", "lifecycle cancelled by administrator")
		if terminateErr != nil {
			return terminateErr
		}
		if terminated.State == domain.OperationCompleted {
			completed = true
		} else {
			code := terminated.ErrorCode
			if code == "" {
				code = "lifecycle_cancelled"
			}
			if code != "lifecycle_cancelled" {
				return temporal.NewNonRetryableApplicationError(terminated.ErrorDetail, code, nil)
			}
			if onCancelled != nil {
				if err := onCancelled(ctx, admission, command); err != nil {
					return err
				}
			}
			if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
				return err
			}
			return temporal.NewNonRetryableApplicationError(terminated.ErrorDetail, "lifecycle_cancelled", nil)
		}
	}
	return workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) })
}
