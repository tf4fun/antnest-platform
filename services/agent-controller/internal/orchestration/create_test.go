package orchestration

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestCreateWorkflowReturnsCommittedAdmissionBeforeRuntime(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	registerTestActivities(env)
	command := testCommand()
	admitted := false
	env.OnActivity(AdmitActivity, mock.Anything, command).Return(testAdmission(), nil).Once()
	for _, phase := range createPhases {
		env.OnActivity(string(phase), mock.Anything, command).Return(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			if !admitted {
				t.Fatal("resource activity ran before admission update completed")
			}
			return application.OperationView{State: domain.OperationRunning}, nil
		}).Once()
	}
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow(admissionUpdate, "admit", &testsuite.TestUpdateCallback{
			OnReject: func(err error) { t.Errorf("admission rejected: %v", err) },
			OnAccept: func() {},
			OnComplete: func(value interface{}, err error) {
				if err != nil || value.(application.CreateAgentResult).Agent.AgentID != "agent-test" {
					t.Errorf("admission = %+v, %v", value, err)
				}
				admitted = true
			},
		}, command)
	}, 0)
	env.ExecuteWorkflow(CreateAgentWorkflow, command)
	if err := env.GetWorkflowError(); err != nil {
		t.Fatal(err)
	}
	env.AssertExpectations(t)
}

func TestCreateWorkflowRetriesTemporaryFailureAndStopsOnBuildFailure(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	registerTestActivities(env)
	command := testCommand()
	env.OnActivity(AdmitActivity, mock.Anything, command).Return(testAdmission(), nil).Once()
	env.OnActivity(string(domain.PhaseNetworkEnsure), mock.Anything, command).
		Return(application.OperationView{}, errors.New("temporary network error")).Once()
	env.OnActivity(string(domain.PhaseNetworkEnsure), mock.Anything, command).
		Return(application.OperationView{State: domain.OperationRunning}, nil).Once()
	env.OnActivity(string(domain.PhaseRuntimeInitialize), mock.Anything, command).
		Return(application.OperationView{State: domain.OperationFailed, ErrorCode: "image_missing"}, nil).Once()
	env.ExecuteWorkflow(CreateAgentWorkflow, command)
	var failure *temporal.ApplicationError
	if !errors.As(env.GetWorkflowError(), &failure) || failure.Type() != "build_failed" {
		t.Fatalf("workflow failure = %v", env.GetWorkflowError())
	}
	env.AssertExpectations(t)
}

func TestCreateWorkflowRejectsConflictingAdmission(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	registerTestActivities(env)
	command := testCommand()
	env.OnActivity(AdmitActivity, mock.Anything, command).
		Return(testAdmission(), nil).After(time.Second).Once()
	for _, phase := range createPhases {
		env.OnActivity(string(phase), mock.Anything, command).
			Return(application.OperationView{State: domain.OperationRunning}, nil).Once()
	}
	rejected := false
	env.RegisterDelayedCallback(func() {
		changed := command
		changed.OrganizationID = "other-organization"
		env.UpdateWorkflow(admissionUpdate, "conflicting", &testsuite.TestUpdateCallback{
			OnReject:   func(err error) { rejected = err != nil },
			OnAccept:   func() { t.Error("conflicting update was accepted") },
			OnComplete: func(interface{}, error) { t.Error("conflicting update completed") },
		}, changed)
	}, 0)
	env.ExecuteWorkflow(CreateAgentWorkflow, command)
	if !rejected || env.GetWorkflowError() != nil {
		t.Fatalf("rejected=%v, workflow error=%v", rejected, env.GetWorkflowError())
	}
}

func testCommand() application.CreateAgentInput {
	return application.CreateAgentInput{
		RequestID: "create-test", OrganizationID: "org-test", OwnerUserID: "user-test",
		Name: "Test Agent", TemplateID: "template-test", TemplateRevision: 1,
	}
}

func testAdmission() application.CreateAgentResult {
	return application.CreateAgentResult{Agent: application.AgentView{AgentID: "agent-test"}}
}

func registerTestActivities(env *testsuite.TestWorkflowEnvironment) {
	env.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error) {
		return application.CreateAgentResult{}, nil
	}, activity.RegisterOptions{Name: AdmitActivity})
	for _, phase := range createPhases {
		env.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			return application.OperationView{}, nil
		}, activity.RegisterOptions{Name: string(phase)})
	}
}

func TestAdmissionErrorsPreservePublicClassification(t *testing.T) {
	for _, failure := range admissionErrors {
		t.Run(failure.code, func(t *testing.T) {
			encoded := activityError(failure.err)
			var applicationError *temporal.ApplicationError
			if !errors.As(encoded, &applicationError) || !applicationError.NonRetryable() {
				t.Fatalf("definitive admission error became retryable: %v", encoded)
			}
			if !errors.Is(publicError(encoded), failure.err) {
				t.Fatalf("public error classification changed: %v", publicError(encoded))
			}
		})
	}
	err := errors.New("temporary database failure")
	if activityError(err) != err {
		t.Fatal("temporary error must remain retryable")
	}
}
