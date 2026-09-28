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
	sourceRecoveryAdmitActivity   = "legacy_source.admit"
	sourceRecoveryAdvanceActivity = "legacy_source.advance"
)

func LegacySourceRecoveryWorkflow(ctx workflow.Context, command application.LegacySourceRecoveryInput) error {
	ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{StartToCloseTimeout: 15 * time.Minute, HeartbeatTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: time.Minute}})
	var admitted bool
	var record ports.LegacySourceRecoveryRecord
	var admissionErr error
	if err := workflow.SetUpdateHandlerWithOptions(ctx, admissionUpdate, func(ctx workflow.Context, _ application.LegacySourceRecoveryInput) (ports.LegacySourceRecoveryRecord, error) {
		if err := workflow.Await(ctx, func() bool { return admitted }); err != nil {
			return record, err
		}
		return record, admissionErr
	}, workflow.UpdateHandlerOptions{Validator: func(input application.LegacySourceRecoveryInput) error {
		if !reflect.DeepEqual(input, command) {
			return temporal.NewNonRetryableApplicationError("request identity conflict", "request_conflict", nil)
		}
		return nil
	}}); err != nil {
		return err
	}
	admissionErr = workflow.ExecuteActivity(ctx, sourceRecoveryAdmitActivity, command).Get(ctx, &record)
	admitted = true
	if err := workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) }); err != nil {
		return err
	}
	if admissionErr != nil {
		return admissionErr
	}
	for record.State == "running" {
		previous := record.Phase
		if err := workflow.ExecuteActivity(ctx, sourceRecoveryAdvanceActivity, command.RequestID).Get(ctx, &record); err != nil {
			return err
		}
		if record.State == "running" && record.Phase == previous {
			return temporal.NewNonRetryableApplicationError("recovery stage made no progress", "lifecycle_conflict", nil)
		}
	}
	if record.State != "completed" && record.State != "manual_recovery_required" {
		return temporal.NewNonRetryableApplicationError("invalid source recovery state", "lifecycle_conflict", nil)
	}
	return workflow.Await(ctx, func() bool { return workflow.AllHandlersFinished(ctx) })
}

func registerLegacySourceRecovery(registry Registry, service *application.LegacySourceRecoveryService) {
	registry.RegisterWorkflow(LegacySourceRecoveryWorkflow)
	registry.RegisterActivityWithOptions(func(ctx context.Context, input application.LegacySourceRecoveryInput) (ports.LegacySourceRecoveryRecord, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		record, err := service.Admit(ctx, input)
		return record, activityError(err)
	}, activity.RegisterOptions{Name: sourceRecoveryAdmitActivity})
	registry.RegisterActivityWithOptions(func(ctx context.Context, requestID string) (ports.LegacySourceRecoveryRecord, error) {
		ctx, stop := activityLifetime(ctx)
		defer stop()
		before, err := service.Current(ctx, requestID)
		if err != nil {
			return ports.LegacySourceRecoveryRecord{}, activityError(err)
		}
		record, err := service.Advance(ctx, requestID)
		if err == nil && record.State == "running" && record.Phase == before.Phase {
			err = application.ErrDependencyUnavailable
		}
		return record, activityError(err)
	}, activity.RegisterOptions{Name: sourceRecoveryAdvanceActivity})
}
