package orchestration

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestLifecycleWorkflows(t *testing.T) {
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable, domain.OperationEnable, domain.OperationDelete} {
		t.Run(string(kind), func(t *testing.T) {
			for _, fail := range []bool{false, true} {
				t.Run(fmt.Sprintf("fail_%t", fail), func(t *testing.T) {
					checkLifecycleWorkflow(t, kind, fail)
				})
			}
		})
	}
}

func checkLifecycleWorkflow(t *testing.T, kind domain.OperationKind, fail bool) {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	plan, err := domain.OperationPlan(kind)
	if err != nil {
		t.Fatal(err)
	}
	input := application.LifecycleCommand{Kind: kind, RequestID: "request-1", AgentID: "agent-1", OrganizationID: "org-1", ActorPrincipalID: "actor-1"}
	var order []string
	env.RegisterActivityWithOptions(func(context.Context, application.LifecycleCommand) (application.LifecycleResult, error) {
		order = append(order, "admit")
		return application.LifecycleResult{Operation: application.OperationView{State: domain.OperationRunning}}, nil
	}, activity.RegisterOptions{Name: lifecycleAdmission})
	for _, phase := range plan {
		attempts := 0
		env.RegisterActivityWithOptions(func(context.Context, application.LifecycleCommand) (application.OperationView, error) {
			attempts++
			if attempts == 1 {
				return application.OperationView{}, fmt.Errorf("temporary dependency failure")
			}
			order = append(order, string(phase))
			if fail && phase == plan[0] {
				return application.OperationView{State: domain.OperationFailed, ErrorCode: "effect_rejected"}, nil
			}
			return application.OperationView{State: domain.OperationRunning}, nil
		}, activity.RegisterOptions{Name: lifecycleActivity(phase)})
	}
	admitted := false
	env.RegisterDelayedCallback(func() {
		update := input
		env.UpdateWorkflow(admissionUpdate, "admission-test", &testsuite.TestUpdateCallback{
			OnReject: func(err error) { t.Errorf("admission rejected: %v", err) },
			OnAccept: func() {},
			OnComplete: func(_ interface{}, err error) {
				if err != nil {
					t.Errorf("admission failed: %v", err)
				}
				admitted = true
				if !reflect.DeepEqual(order, []string{"admit"}) {
					t.Errorf("admission waited for resource work: %v", order)
				}
			},
		}, update)
	}, 0)
	env.SetTestTimeout(5 * time.Second)
	env.ExecuteWorkflow(LifecycleWorkflow, input)
	if !admitted {
		t.Fatal("no admission response")
	}
	if (env.GetWorkflowError() != nil) != fail {
		t.Fatalf("workflow failure = %v", env.GetWorkflowError())
	}
	want := []string{"admit"}
	for _, phase := range plan {
		want = append(want, string(phase))
		if fail {
			break
		}
	}
	if !reflect.DeepEqual(order, want) {
		t.Fatalf("activities = %v, want %v", order, want)
	}
}

func TestLifecycleAdmissionErrorsDoNotRetry(t *testing.T) {
	for _, input := range []error{application.ErrAgentNotReady, application.ErrLifecycleConflict} {
		var failure *temporal.ApplicationError
		if !errors.As(activityError(input), &failure) || !failure.NonRetryable() {
			t.Fatalf("retryable business rejection: %v", input)
		}
		if !errors.Is(publicError(activityError(input)), input) {
			t.Fatalf("lost public error: %v", input)
		}
	}
}
