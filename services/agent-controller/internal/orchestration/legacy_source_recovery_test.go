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

func TestLegacySourceRecoveryWorkflowAdmitsBeforeDrainAndCompletesStages(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	defer env.AssertExpectations(t)
	input := application.LegacySourceRecoveryInput{RequestID: "recover-source-1", AgentID: "agent-1", OrganizationID: "org-1", ActorPrincipalID: "admin-1"}
	env.RegisterActivityWithOptions(func(context.Context, application.LegacySourceRecoveryInput) (ports.LegacySourceRecoveryRecord, error) {
		return ports.LegacySourceRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: sourceRecoveryAdmitActivity})
	env.RegisterActivityWithOptions(func(context.Context, string) (ports.LegacySourceRecoveryRecord, error) {
		return ports.LegacySourceRecoveryRecord{}, nil
	}, activity.RegisterOptions{Name: sourceRecoveryAdvanceActivity})
	env.OnActivity(sourceRecoveryAdmitActivity, mock.Anything, input).Return(ports.LegacySourceRecoveryRecord{RequestID: input.RequestID, State: "running", Phase: "drain"}, nil).Once()
	for _, phase := range []string{"network_fence", "disable_runtime", "publish", "done"} {
		state := "running"
		if phase == "done" {
			state = "completed"
		}
		env.OnActivity(sourceRecoveryAdvanceActivity, mock.Anything, input.RequestID).Return(ports.LegacySourceRecoveryRecord{RequestID: input.RequestID, State: state, Phase: phase}, nil).Once()
	}
	env.ExecuteWorkflow(LegacySourceRecoveryWorkflow, input)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
}
