package orchestration

import (
	"context"
	"testing"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLegacyProofLossWorkflowReturnsAdmissionBeforeDisableAndPublishes(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	input := application.LegacyProofLossRecoveryInput{RequestID: "recover-1", AgentID: "agent-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1", FailedMigrationRequestID: "failed-1"}
	env.RegisterActivityWithOptions(func(context.Context, application.LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, error) {
		return ports.LegacyProofLossRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: proofLossAdmitActivity})
	env.RegisterActivityWithOptions(func(context.Context, string) (ports.LegacyProofLossRecoveryRecord, error) {
		return ports.LegacyProofLossRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: proofLossDisableActivity})
	env.RegisterActivityWithOptions(func(context.Context, string) (ports.LegacyProofLossRecoveryRecord, error) {
		return ports.LegacyProofLossRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: proofLossPublishActivity})
	admitted := false
	env.OnActivity(proofLossAdmitActivity, mock.Anything, input).Return(ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, State: "running", Phase: "disable_runtime"}, nil).Once()
	env.OnActivity(proofLossDisableActivity, mock.Anything, input.RequestID).Return(func(context.Context, string) (ports.LegacyProofLossRecoveryRecord, error) {
		if !admitted {
			t.Fatal("Runtime disabled before admission returned")
		}
		return ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, State: "running", Phase: "publish"}, nil
	}).Once()
	env.OnActivity(proofLossPublishActivity, mock.Anything, input.RequestID).Return(ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, State: "completed", Phase: "done"}, nil).Once()
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow(admissionUpdate, "proof-loss-admit", &testsuite.TestUpdateCallback{
			OnReject: func(err error) { t.Errorf("admission rejected: %v", err) }, OnAccept: func() {}, OnComplete: func(value interface{}, err error) {
				if err != nil || value.(ports.LegacyProofLossRecoveryRecord).Phase != "disable_runtime" {
					t.Errorf("admission=%+v err=%v", value, err)
				}
				admitted = true
			},
		}, input)
	}, 0)
	env.ExecuteWorkflow(LegacyProofLossRecoveryWorkflow, input)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	env.AssertExpectations(t)
}

func TestLegacyProofLossWorkflowStopsOnDurableManualOutcome(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	input := application.LegacyProofLossRecoveryInput{RequestID: "recover-manual", AgentID: "agent-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1", FailedMigrationRequestID: "failed-1"}
	env.RegisterActivityWithOptions(func(context.Context, application.LegacyProofLossRecoveryInput) (ports.LegacyProofLossRecoveryRecord, error) {
		return ports.LegacyProofLossRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: proofLossAdmitActivity})
	env.RegisterActivityWithOptions(func(context.Context, string) (ports.LegacyProofLossRecoveryRecord, error) {
		return ports.LegacyProofLossRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: proofLossDisableActivity})
	env.OnActivity(proofLossAdmitActivity, mock.Anything, input).Return(ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, State: "running", Phase: "disable_runtime"}, nil).Once()
	env.OnActivity(proofLossDisableActivity, mock.Anything, input.RequestID).Return(ports.LegacyProofLossRecoveryRecord{RequestID: input.RequestID, State: "manual_recovery_required", Phase: "disable_runtime", ErrorCode: "legacy_migration_manual_recovery_required", ManualReason: "runtime_disable_rejected"}, nil).Once()
	env.ExecuteWorkflow(LegacyProofLossRecoveryWorkflow, input)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatalf("durable manual outcome retried or failed: %v", err)
	}
	env.AssertExpectations(t)
}
