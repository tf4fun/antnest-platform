package orchestration

import (
	"context"
	"reflect"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const (
	proofLossAdmitActivity   = "legacy_proof_loss.admit"
	proofLossDisableActivity = "legacy_proof_loss.disable_runtime"
	proofLossPublishActivity = "legacy_proof_loss.publish"
)

func LegacyProofLossRecoveryWorkflow(ctx workflow.Context, command application.LegacyProofLossRecoveryInput) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 15 * time.Minute, HeartbeatTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: time.Minute}})
	var admitted bool
	var record ports.LegacyProofLossRecoveryRecord
	var admissionErr error
	if err := workflow.SetUpdateHandlerWithOptions(ctx, admissionUpdate, func(ctx workflow.Context, _ application.LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, error) {
		if err := workflow.Await(ctx, func() bool { return admitted }); err != nil {
			return record, err
		}
		return record, admissionErr
	}, workflow.UpdateHandlerOptions{Validator: func(input application.LegacyProofLossRecoveryInput) error {
		if !reflect.DeepEqual(input, command) {
			return temporal.NewNonRetryableApplicationError("request identity conflict", "request_conflict", nil)
		}
		return nil
	}}); err != nil {
		return err
	}
	admissionErr = workflow.ExecuteActivity(ctx, proofLossAdmitActivity, command).Get(ctx, &record)
	admitted = true
	if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
		return err
	}
	if admissionErr != nil {
		return admissionErr
	}
	if record.State == "completed" || record.State == "manual_recovery_required" {
		return nil
	}
	if record.Phase == "disable_runtime" {
		if err := workflow.ExecuteActivity(ctx, proofLossDisableActivity, command.RequestID).Get(ctx, &record); err != nil {
			return err
		}
	}
	if record.State == "completed" || record.State == "manual_recovery_required" {
		return nil
	}
	if record.Phase != "publish" {
		return temporal.NewNonRetryableApplicationError("invalid recovery phase", "lifecycle_conflict", nil)
	}
	if err := workflow.ExecuteActivity(ctx, proofLossPublishActivity, command.RequestID).Get(ctx, &record); err != nil {
		return err
	}
	if record.State == "manual_recovery_required" {
		return nil
	}
	if record.State != "completed" || record.Phase != "done" {
		return temporal.NewNonRetryableApplicationError("recovery not published", "lifecycle_conflict", nil)
	}
	return workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) })
}

func registerLegacyProofLossRecovery(registry Registry, service *application.LegacyProofLossRecoveryService) {
	registry.RegisterWorkflow(LegacyProofLossRecoveryWorkflow)
	registry.RegisterActivityWithOptions(func(ctx context.Context, input application.LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		record, err := service.Admit(ctx, input)
		return record, activityError(err)
	}, activity.RegisterOptions{Name: proofLossAdmitActivity})
	registry.RegisterActivityWithOptions(func(ctx context.Context, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		record, err := service.Advance(ctx, requestID)
		if err == nil && record.State == "running" && record.Phase == "disable_runtime" {
			err = application.ErrDependencyUnavailable
		}
		return record, activityError(err)
	}, activity.RegisterOptions{Name: proofLossDisableActivity})
	registry.RegisterActivityWithOptions(func(ctx context.Context, requestID string) (ports.LegacyProofLossRecoveryRecord, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		record, err := service.Advance(ctx, requestID)
		if err == nil && record.State == "running" && record.Phase == "publish" {
			err = application.ErrDependencyUnavailable
		}
		return record, activityError(err)
	}, activity.RegisterOptions{Name: proofLossPublishActivity})
}
