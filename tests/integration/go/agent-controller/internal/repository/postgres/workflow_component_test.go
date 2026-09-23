package postgres

import (
	"context"
	"testing"
	"time"

	"go.temporal.io/sdk/testsuite"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/orchestration"
)

func executeLifecycleWorkflowForTest(t *testing.T, repository *Repository, service *application.LifecycleService, requestID string, expected domain.OperationState) {
	t.Helper()
	operation, err := repository.GetLifecycleOperation(context.Background(), requestID)
	if err != nil {
		t.Fatal(err)
	}
	command := application.LifecycleCommand{Kind: operation.Kind, RequestID: requestID, AgentID: operation.AgentID, OwnerRevocationSequence: operation.OwnerRevocationSequence}
	if operation.Kind == domain.OperationRebuild {
		state, found, err := repository.ReplayAgentRebuild(context.Background(), requestID, operation.RequestFingerprint)
		if err != nil || !found {
			t.Fatalf("rebuild source: %v %v", found, err)
		}
		command.TemplateID = state.TargetSpec.Snapshot.TemplateID
		command.TemplateRevision = state.TargetSpec.Snapshot.TemplateRevision
	}
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.SetTestTimeout(10 * time.Second)
	orchestration.Register(env, service)
	env.ExecuteWorkflow(orchestration.LifecycleWorkflow, command)
	if (env.GetWorkflowError() != nil) != (expected == domain.OperationFailed) {
		t.Fatalf("workflow result: %v", env.GetWorkflowError())
	}
	completed, err := repository.GetLifecycleOperation(context.Background(), requestID)
	if err != nil || completed.State != expected {
		t.Fatalf("business result: %+v %v", completed, err)
	}
}
