package orchestration

import (
	"context"
	"errors"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	enums "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type reliabilityProbe struct {
	mu              sync.Mutex
	activities      []string
	terminations    []application.LifecycleTermination
	terminated      application.OperationView
	terminateErr    error
	children        []application.LifecycleCommand
	childErr        error
	beforeTerminate func()
	lifecycleStubs  map[string]func(context.Context, application.LifecycleCommand) (application.OperationView, error)
}

func (probe *reliabilityProbe) record(activity string) {
	probe.mu.Lock()
	defer probe.mu.Unlock()
	probe.activities = append(probe.activities, activity)
}

func (probe *reliabilityProbe) order() []string {
	probe.mu.Lock()
	defer probe.mu.Unlock()
	return slices.Clone(probe.activities)
}

func reliabilityCommand() application.CreateAgentInput {
	return application.CreateAgentInput{
		RequestID: "request-reliability", Name: "agent", OrganizationID: "org-1",
		OwnerUserID: "user-1", TemplateID: "template-1", TemplateRevision: 7,
		ActorPrincipalID: "admin-1",
	}
}

func reliabilityAdmission() application.CreateAgentResult {
	return application.CreateAgentResult{
		Agent: application.AgentView{AgentID: "agent-test"},
		Operation: application.OperationView{
			RequestID: "request-reliability", AgentID: "agent-test",
			Kind: domain.OperationCreate, Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
		},
	}
}

func registerReliability(env *testsuite.TestWorkflowEnvironment, probe *reliabilityProbe) {
	env.RegisterWorkflowWithOptions(LifecycleWorkflow, workflow.RegisterOptions{Name: "LifecycleWorkflow"})
	termination := func(_ context.Context, input application.LifecycleTermination) (application.OperationView, error) {
		probe.mu.Lock()
		defer probe.mu.Unlock()
		if probe.beforeTerminate != nil {
			probe.beforeTerminate()
		}
		probe.activities = append(probe.activities, "terminate_lifecycle")
		probe.terminations = append(probe.terminations, input)
		if probe.terminated.RequestID != "" || probe.terminateErr != nil {
			return probe.terminated, probe.terminateErr
		}
		return application.OperationView{
			RequestID: input.RequestID, Kind: domain.OperationCreate, Phase: input.Phase,
			State: domain.OperationFailed, ErrorCode: input.Code, ErrorDetail: input.Detail,
		}, nil
	}
	env.RegisterActivityWithOptions(termination, activity.RegisterOptions{Name: "terminate_lifecycle"})
	quarantine := func(context.Context, application.LifecycleFailure) error {
		probe.record("quarantine_lifecycle")
		return nil
	}
	env.RegisterActivityWithOptions(quarantine, activity.RegisterOptions{Name: "quarantine_lifecycle"})
	for _, phase := range createPhases {
		env.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			return application.OperationView{State: domain.OperationRunning}, nil
		}, activity.RegisterOptions{Name: string(phase)})
	}
	env.RegisterActivityWithOptions(func(context.Context, application.CreateAgentInput) (application.CreateAgentResult, error) {
		return reliabilityAdmission(), nil
	}, activity.RegisterOptions{Name: AdmitActivity})
	for _, phase := range []domain.OperationPhase{
		domain.PhaseDrain, domain.PhaseNetworkFence, domain.PhaseRuntimeUpdate,
		domain.PhaseRuntimeDisable, domain.PhaseRuntimeEnable, domain.PhaseRuntimeDelete,
		domain.PhaseNetworkRelease, domain.PhaseNetworkRestore, domain.PhasePublish,
	} {
		name := lifecycleActivity(phase)
		env.RegisterActivityWithOptions(func(ctx context.Context, command application.LifecycleCommand) (application.OperationView, error) {
			probe.mu.Lock()
			stub := probe.lifecycleStubs[name]
			probe.mu.Unlock()
			if stub != nil {
				return stub(ctx, command)
			}
			probe.record(name)
			return application.OperationView{State: domain.OperationRunning}, nil
		}, activity.RegisterOptions{Name: name})
	}
	env.RegisterActivityWithOptions(func(context.Context, application.LifecycleCommand) (application.LifecycleResult, error) {
		return application.LifecycleResult{Operation: application.OperationView{
			RequestID: "request-lifecycle", AgentID: "agent-test",
			State: domain.OperationRunning,
		}}, nil
	}, activity.RegisterOptions{Name: lifecycleAdmission})
}

func stubChildDelete(env *testsuite.TestWorkflowEnvironment, probe *reliabilityProbe) {
	env.OnWorkflow(LifecycleWorkflow, mock.Anything, mock.Anything).Run(func(args mock.Arguments) {
		probe.mu.Lock()
		defer probe.mu.Unlock()
		probe.children = append(probe.children, args.Get(1).(application.LifecycleCommand))
	}).Return(func(workflow.Context, application.LifecycleCommand) error {
		return probe.childErr
	})
}

func onCreateActivity(env *testsuite.TestWorkflowEnvironment, name string, fn func(context.Context, application.CreateAgentInput) (application.OperationView, error)) {
	env.OnActivity(name, mock.Anything, mock.Anything).Return(fn)
}

func reliabilityEnvironment(t *testing.T, probe *reliabilityProbe, configuration ...WorkerConfiguration) *testsuite.TestWorkflowEnvironment {
	t.Helper()
	suite := testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetTestTimeout(30 * time.Second)
	env.SetWorkerOptions(worker.Options{EnableSessionWorker: true})
	registerReliability(env, probe)
	return env
}

func reliabilityDeadlineOperation(phase domain.OperationPhase) application.OperationView {
	return application.OperationView{
		RequestID: "request-reliability", AgentID: "agent-test",
		Kind: domain.OperationCreate, Phase: phase, State: domain.OperationFailed,
		ErrorCode: "phase_deadline_exceeded",
	}
}

func TestCreateWorkflowPhaseDeadlineTerminatesExactlyOnce(t *testing.T) {
	for _, phase := range createPhases {
		t.Run(string(phase), func(t *testing.T) {
			probe := &reliabilityProbe{
				terminated: reliabilityDeadlineOperation(phase),
			}
			env := reliabilityEnvironment(t, probe)
			onCreateActivity(env, string(phase), func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
				probe.record(string(phase))
				return application.OperationView{}, temporal.NewTimeoutError(enums.TIMEOUT_TYPE_SCHEDULE_TO_CLOSE, errors.New("schedule-to-close expired"))
			})
			for _, later := range createPhases {
				if later == phase {
					continue
				}
				name := string(later)
				onCreateActivity(env, name, func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
					probe.record(name)
					return application.OperationView{State: domain.OperationRunning}, nil
				})
			}
			env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
			require.True(t, env.IsWorkflowCompleted())
			err := env.GetWorkflowError()
			require.Error(t, err)
			var failure *temporal.ApplicationError
			require.ErrorAs(t, err, &failure)
			require.Equal(t, "phase_deadline_exceeded", failure.Type())
			require.Len(t, probe.terminations, 1)
			require.Equal(t, phase, probe.terminations[0].Phase)
			require.Equal(t, "phase_deadline_exceeded", probe.terminations[0].Code)
			index := slices.Index(probe.order(), string(phase))
			for _, later := range createPhases {
				if later == phase {
					continue
				}
				require.False(t, slices.Contains(probe.order()[max(index, 0):], string(later)), string(later))
			}
		})
	}
}

func TestCreateWorkflowCancelBeforeEffectsStartsDeterministicChild(t *testing.T) {
	probe := &reliabilityProbe{}
	env := reliabilityEnvironment(t, probe)
	stubChildDelete(env, probe)
	for _, phase := range createPhases {
		name := string(phase)
		onCreateActivity(env, name, func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			probe.record(name)
			return application.OperationView{State: domain.OperationRunning}, nil
		})
	}
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow("cancel_lifecycle_operation", "", &testsuite.TestUpdateCallback{
			OnAccept:   func() {},
			OnReject:   func(err error) { t.Errorf("cancel rejected: %v", err) },
			OnComplete: func(interface{}, error) {},
		}, "request-reliability")
	}, 0)
	env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	err := env.GetWorkflowError()
	require.Error(t, err)
	var failure *temporal.ApplicationError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "lifecycle_cancelled", failure.Type())
	require.Len(t, probe.terminations, 1)
	require.Equal(t, "lifecycle_cancelled", probe.terminations[0].Code)
	require.Equal(t, []string{"terminate_lifecycle"}, probe.order(), "no phase activity should run after pre-effect cancellation")
	require.Len(t, probe.children, 1)
	child := probe.children[0]
	require.Equal(t, domain.OperationDelete, child.Kind)
	require.Equal(t, domain.DeriveResourceID("request", "lifecycle-cancel-delete", "request-reliability"), child.RequestID)
	require.Equal(t, "agent-test", child.AgentID)
	require.Equal(t, "org-1", child.OrganizationID)
	require.Equal(t, "admin-1", child.ActorPrincipalID)
}

func TestCreateWorkflowCancelDuringActivityRequestsTermination(t *testing.T) {
	probe := &reliabilityProbe{}
	env := reliabilityEnvironment(t, probe)
	stubChildDelete(env, probe)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	onCreateActivity(env, "network_ensure", func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		probe.record("network_ensure")
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-release:
			return application.OperationView{State: domain.OperationRunning}, nil
		}
	})
	env.SetOnActivityStartedListener(func(info *activity.Info, ctx context.Context, args converter.EncodedValues) {
		if info.ActivityType.Name == "network_ensure" {
			go env.UpdateWorkflow("cancel_lifecycle_operation", "", &testsuite.TestUpdateCallback{
				OnAccept:   func() {},
				OnReject:   func(err error) { t.Errorf("cancel rejected: %v", err) },
				OnComplete: func(interface{}, error) {},
			}, "request-reliability")
		}
	})
	env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	err := env.GetWorkflowError()
	require.Error(t, err)
	var failure *temporal.ApplicationError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "lifecycle_cancelled", failure.Type())
	order := probe.order()
	require.Equal(t, "network_ensure", order[0])
	require.Equal(t, "terminate_lifecycle", order[len(order)-1])
	require.False(t, slices.Contains(order, "runtime_initialize"))
	require.Len(t, probe.children, 1)
}

func TestLifecycleWorkflowCancelDoesNotStartChild(t *testing.T) {
	probe := &reliabilityProbe{}
	env := reliabilityEnvironment(t, probe)
	admissionReleased := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(admissionReleased) }) }
	t.Cleanup(unblock)
	var cancelApplied atomic.Bool
	command := application.LifecycleCommand{
		Kind: domain.OperationDisable, RequestID: "request-lifecycle",
		AgentID: "agent-test", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
	}
	env.OnActivity(lifecycleAdmission, mock.Anything, mock.Anything).Return(
		func(ctx context.Context, _ application.LifecycleCommand) (application.LifecycleResult, error) {
			select {
			case <-ctx.Done():
				return application.LifecycleResult{}, ctx.Err()
			case <-admissionReleased:
				return application.LifecycleResult{Operation: application.OperationView{
					RequestID: "request-lifecycle", AgentID: "agent-test",
					State: domain.OperationRunning,
				}}, nil
			}
		})
	env.SetOnActivityStartedListener(func(info *activity.Info, _ context.Context, _ converter.EncodedValues) {
		if info.ActivityType.Name != lifecycleAdmission {
			return
		}
		env.UpdateWorkflow("cancel_lifecycle_operation", "", &testsuite.TestUpdateCallback{
			OnAccept: func() {},
			OnReject: func(err error) {
				t.Errorf("cancel rejected: %v", err)
				unblock()
			},
			OnComplete: func(_ interface{}, err error) {
				if err != nil {
					t.Errorf("cancel update failed: %v", err)
					unblock()
					return
				}
				cancelApplied.Store(true)
				unblock()
			},
		}, "request-lifecycle")
	})
	env.ExecuteWorkflow(LifecycleWorkflow, command)
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	require.True(t, cancelApplied.Load(), "the cancel update must apply before the admission receipt")
	require.Len(t, probe.terminations, 1)
	require.Equal(t, "lifecycle_cancelled", probe.terminations[0].Code)
	require.Empty(t, probe.children)
	require.Equal(t, []string{"terminate_lifecycle"}, probe.order(), "no phase activity should run after pre-effect cancellation")
}

func TestCancelUpdateRejectsMismatchedRequest(t *testing.T) {
	probe := &reliabilityProbe{}
	env := reliabilityEnvironment(t, probe)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	rejected := make(chan error, 1)
	onCreateActivity(env, "network_ensure", func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		probe.record("network_ensure")
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-release:
			return application.OperationView{State: domain.OperationRunning}, nil
		}
	})
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow("cancel_lifecycle_operation", "", &testsuite.TestUpdateCallback{
			OnAccept:   func() {},
			OnReject:   func(err error) { rejected <- err },
			OnComplete: func(interface{}, error) {},
		}, "request-other")
		env.CancelWorkflow()
	}, time.Millisecond)
	env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	err := <-rejected
	require.Error(t, err)
	var failure *temporal.ApplicationError
	require.ErrorAs(t, err, &failure)
	require.Equal(t, "request_conflict", failure.Type())
	require.Empty(t, probe.terminations)
}

func TestCreateWorkflowCompletedWinsCancelRace(t *testing.T) {
	probe := &reliabilityProbe{
		terminated: application.OperationView{
			RequestID: "request-reliability", Kind: domain.OperationCreate,
			Phase: domain.PhasePublish, State: domain.OperationCompleted,
		},
	}
	env := reliabilityEnvironment(t, probe)
	stubChildDelete(env, probe)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	onCreateActivity(env, "network_ensure", func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		probe.record("network_ensure")
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-release:
			return application.OperationView{State: domain.OperationRunning}, nil
		}
	})
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow("cancel_lifecycle_operation", "", &testsuite.TestUpdateCallback{
			OnAccept:   func() {},
			OnReject:   func(err error) { t.Errorf("cancel rejected: %v", err) },
			OnComplete: func(interface{}, error) {},
		}, "request-reliability")
	}, time.Millisecond)
	env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	require.Len(t, probe.terminations, 1)
	require.Empty(t, probe.children)
	require.False(t, slices.Contains(probe.order(), "runtime_initialize"))
}

func TestCreateWorkflowNonRetryableFailureStillQuarantines(t *testing.T) {
	probe := &reliabilityProbe{}
	env := reliabilityEnvironment(t, probe)
	onCreateActivity(env, "network_ensure", func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
		probe.record("network_ensure")
		return application.OperationView{}, temporal.NewNonRetryableApplicationError("runtime observation contradicted the journal", "lifecycle_conflict", nil)
	})
	env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	require.Error(t, env.GetWorkflowError())
	require.Len(t, probe.terminations, 0)
	require.Equal(t, []string{"network_ensure", "quarantine_lifecycle"}, probe.order())
}

func TestLegacyWorkflowVersionRunsOriginalSemantics(t *testing.T) {
	probe := &reliabilityProbe{}
	env := reliabilityEnvironment(t, probe)
	env.OnGetVersion("lifecycle-reliability-v1", workflow.DefaultVersion, workflow.Version(1)).Return(workflow.DefaultVersion)
	for _, phase := range createPhases {
		name := string(phase)
		onCreateActivity(env, name, func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			probe.record(name)
			return application.OperationView{State: domain.OperationRunning}, nil
		})
	}
	rejected := make(chan error, 1)
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow("cancel_lifecycle_operation", "", &testsuite.TestUpdateCallback{
			OnAccept:   func() {},
			OnReject:   func(err error) { rejected <- err },
			OnComplete: func(interface{}, error) {},
		}, "request-reliability")
	}, time.Millisecond)
	env.ExecuteWorkflow(CreateAgentWorkflow, reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
	select {
	case rejectErr := <-rejected:
		require.Error(t, rejectErr, "legacy branch must not register the cancel update")
	case <-time.After(2 * time.Second):
	}
	require.Equal(t, []string{"network_ensure", "runtime_initialize", "publish"}, probe.order())
	require.Empty(t, probe.terminations)
	require.Empty(t, probe.children)
}

func TestBoundedActivityOptions(t *testing.T) {
	deadlines := map[string]time.Duration{
		"network_ensure": 10 * time.Minute, "runtime_initialize": 30 * time.Minute,
		"publish": 10 * time.Minute, "default": 10 * time.Minute,
	}
	options := boundedActivityOptions(phaseDeadline(deadlines, domain.PhaseRuntimeInitialize))
	require.Equal(t, 30*time.Minute, options.ScheduleToCloseTimeout)
	require.Equal(t, 15*time.Minute, options.StartToCloseTimeout)
	require.Equal(t, 30*time.Second, options.HeartbeatTimeout)
	require.True(t, options.WaitForCancellation)
	require.NotNil(t, options.RetryPolicy)
	for _, scenario := range []struct {
		phase domain.OperationPhase
		want  time.Duration
	}{
		{domain.PhaseNetworkEnsure, 10 * time.Minute},
		{domain.PhaseRuntimeInitialize, 30 * time.Minute},
		{domain.PhasePublish, 10 * time.Minute},
		{domain.PhaseDrain, 10 * time.Minute},
		{domain.PhaseRuntimeDelete, 10 * time.Minute},
	} {
		options := boundedActivityOptions(phaseDeadline(deadlines, scenario.phase))
		require.Equal(t, scenario.want, options.ScheduleToCloseTimeout, string(scenario.phase))
	}
	require.Equal(t, 5*time.Minute, phaseDeadline(map[string]time.Duration{"network_ensure": 5 * time.Minute, "default": 10 * time.Minute}, domain.PhaseNetworkEnsure))
	require.Equal(t, 10*time.Minute, phaseDeadline(map[string]time.Duration{"default": 10 * time.Minute}, domain.PhaseNetworkEnsure))
}

func TestCreateWorkflowRetryExhaustionDeadlinesPhase(t *testing.T) {
	probe := &reliabilityProbe{terminated: reliabilityDeadlineOperation(domain.PhaseNetworkEnsure)}
	suite := testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.SetTestTimeout(30 * time.Second)
	env.SetWorkerOptions(worker.Options{EnableSessionWorker: true})
	env.RegisterWorkflowWithOptions(func(ctx workflow.Context, command application.CreateAgentInput) error {
		return createAgentWorkflow(ctx, command, WorkerConfiguration{
			PhaseDeadlines: map[string]time.Duration{"network_ensure": 3 * time.Second},
		})
	}, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	registerReliability(env, probe)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	attempts := atomic.Int32{}
	onCreateActivity(env, "network_ensure", func(ctx context.Context, _ application.CreateAgentInput) (application.OperationView, error) {
		probe.record("network_ensure")
		if attempts.Add(1) <= 2 {
			return application.OperationView{}, errors.New("temporary dependency failure")
		}
		select {
		case <-ctx.Done():
			return application.OperationView{}, ctx.Err()
		case <-release:
			return application.OperationView{State: domain.OperationRunning}, nil
		}
	})
	for _, later := range createPhases[1:] {
		name := string(later)
		onCreateActivity(env, name, func(context.Context, application.CreateAgentInput) (application.OperationView, error) {
			probe.record(name)
			return application.OperationView{State: domain.OperationRunning}, nil
		})
	}
	env.ExecuteWorkflow("CreateAgentWorkflow", reliabilityCommand())
	require.True(t, env.IsWorkflowCompleted())
	var failure *temporal.ApplicationError
	require.ErrorAs(t, env.GetWorkflowError(), &failure)
	require.Equal(t, "phase_deadline_exceeded", failure.Type())
	require.Greater(t, attempts.Load(), int32(1), "retryable errors must retry before the deadline")
	require.Len(t, probe.terminations, 1)
	require.Equal(t, domain.PhaseNetworkEnsure, probe.terminations[0].Phase)
	require.False(t, slices.Contains(probe.order(), "runtime_initialize"))
	require.False(t, slices.Contains(probe.order(), "publish"))
}

func TestLifecycleWorkflowDisableDeadlineTerminates(t *testing.T) {
	probe := &reliabilityProbe{terminated: reliabilityDeadlineOperation(domain.PhaseDrain)}
	env := reliabilityEnvironment(t, probe)
	command := application.LifecycleCommand{
		Kind: domain.OperationDisable, RequestID: "request-lifecycle",
		AgentID: "agent-test", OrganizationID: "org-1", ActorPrincipalID: "admin-1",
	}
	probe.lifecycleStubs = map[string]func(context.Context, application.LifecycleCommand) (application.OperationView, error){
		lifecycleActivity(domain.PhaseDrain): func(context.Context, application.LifecycleCommand) (application.OperationView, error) {
			probe.record(lifecycleActivity(domain.PhaseDrain))
			return application.OperationView{}, temporal.NewTimeoutError(enums.TIMEOUT_TYPE_SCHEDULE_TO_CLOSE, errors.New("schedule-to-close expired"))
		},
	}
	env.ExecuteWorkflow(LifecycleWorkflow, command)
	require.True(t, env.IsWorkflowCompleted())
	var failure *temporal.ApplicationError
	require.ErrorAs(t, env.GetWorkflowError(), &failure)
	require.Equal(t, "phase_deadline_exceeded", failure.Type())
	require.Len(t, probe.terminations, 1)
	require.Equal(t, domain.PhaseDrain, probe.terminations[0].Phase)
	require.Equal(t, []string{lifecycleActivity(domain.PhaseDrain), "terminate_lifecycle"}, probe.order())
	require.Empty(t, probe.children)
}

type fakeTemporalClient struct {
	client.Client
	updateCalls []client.UpdateWorkflowOptions
	updateErr   error
	handle      client.WorkflowUpdateHandle
}

func (fake *fakeTemporalClient) UpdateWorkflow(_ context.Context, options client.UpdateWorkflowOptions) (client.WorkflowUpdateHandle, error) {
	fake.updateCalls = append(fake.updateCalls, options)
	return fake.handle, fake.updateErr
}

type fakeUpdateHandle struct {
	client.WorkflowUpdateHandle
	getErr error
}

func (handle *fakeUpdateHandle) Get(context.Context, interface{}) error { return handle.getErr }

type cancelLookupStoreStub struct {
	ports.LifecycleStore
	operation      ports.LifecycleOperationRecord
	operationErr   error
	operationNext  *ports.LifecycleOperationRecord
	operationCalls int
	base           ports.AgentLifecycleBase
	baseErr        error
	baseCalls      int
}

func (stub *cancelLookupStoreStub) GetLifecycleOperation(context.Context, string) (ports.LifecycleOperationRecord, error) {
	stub.operationCalls++
	if stub.operationCalls > 1 && stub.operationNext != nil {
		return *stub.operationNext, stub.operationErr
	}
	return stub.operation, stub.operationErr
}

func (stub *cancelLookupStoreStub) GetAgentLifecycleBase(context.Context, string) (ports.AgentLifecycleBase, error) {
	stub.baseCalls++
	return stub.base, stub.baseErr
}

type reliabilityClock struct{}

func (reliabilityClock) Now() time.Time { return time.Unix(0, 0).UTC() }

func cancelServiceFixture(store ports.LifecycleStore, temporalClient client.Client) *Service {
	return NewService(application.NewLifecycleService(nil, store, nil, nil, reliabilityClock{}), temporalClient)
}

func cancelOperationBase() ports.AgentLifecycleBase {
	return ports.AgentLifecycleBase{Agent: ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", LifecycleState: domain.AgentCreated,
	}}
}

func cancelInput() application.CancelLifecycleOperationInput {
	return application.CancelLifecycleOperationInput{
		OrganizationID: "org-1", ActorPrincipalID: "admin-1",
		AgentID: "agent-1", OperationRequestID: "request-1",
	}
}

func TestCancelLifecycleOperationSendsExactUpdate(t *testing.T) {
	store := &cancelLookupStoreStub{
		operation: ports.LifecycleOperationRecord{
			RequestID: "request-1", AgentID: "agent-1", Kind: domain.OperationCreate,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
		},
		base: cancelOperationBase(),
	}
	temporalClient := &fakeTemporalClient{handle: &fakeUpdateHandle{}}
	service := cancelServiceFixture(store, temporalClient)
	view, err := service.CancelLifecycleOperation(t.Context(), cancelInput())
	require.NoError(t, err)
	require.Equal(t, "request-1", view.RequestID)
	require.Len(t, temporalClient.updateCalls, 1)
	call := temporalClient.updateCalls[0]
	require.Equal(t, "agent-create/request-1", call.WorkflowID)
	require.Equal(t, "cancel_lifecycle_operation", call.UpdateName)
	require.Equal(t, []interface{}{"request-1"}, call.Args)
	require.Equal(t, client.WorkflowUpdateStageCompleted, call.WaitForStage)
	require.GreaterOrEqual(t, store.baseCalls, 1)
}

func TestCancelLifecycleOperationSkipsEngineForTerminalOrInvalid(t *testing.T) {
	temporalClient := &fakeTemporalClient{handle: &fakeUpdateHandle{}}
	store := &cancelLookupStoreStub{
		operation: ports.LifecycleOperationRecord{
			RequestID: "request-1", AgentID: "agent-1", Kind: domain.OperationDisable,
			Phase: domain.PhasePublish, State: domain.OperationCompleted,
		},
		base: cancelOperationBase(),
	}
	service := cancelServiceFixture(store, temporalClient)
	view, err := service.CancelLifecycleOperation(t.Context(), cancelInput())
	require.NoError(t, err)
	require.Equal(t, domain.OperationCompleted, view.State)
	require.Empty(t, temporalClient.updateCalls)
	for _, input := range []application.CancelLifecycleOperationInput{
		{OrganizationID: "", ActorPrincipalID: "admin-1", AgentID: "agent-1", OperationRequestID: "request-1"},
		{OrganizationID: "org-2", ActorPrincipalID: "admin-1", AgentID: "agent-1", OperationRequestID: "request-1"},
		{OrganizationID: "org-1", ActorPrincipalID: "admin-1", AgentID: "agent-2", OperationRequestID: "request-1"},
	} {
		_, err := service.CancelLifecycleOperation(t.Context(), input)
		require.Error(t, err)
	}
	require.Empty(t, temporalClient.updateCalls)
}

func TestCancelLifecycleOperationRereadsAfterEngineError(t *testing.T) {
	temporalClient := &fakeTemporalClient{updateErr: errors.New("engine unavailable")}
	store := &cancelLookupStoreStub{
		operation: ports.LifecycleOperationRecord{
			RequestID: "request-1", AgentID: "agent-1", Kind: domain.OperationCreate,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
		},
		base: cancelOperationBase(),
	}
	service := cancelServiceFixture(store, temporalClient)
	_, err := service.CancelLifecycleOperation(t.Context(), cancelInput())
	require.ErrorIs(t, err, application.ErrDependencyUnavailable)
	require.Len(t, temporalClient.updateCalls, 1)
	cancelled := store.operation
	cancelled.State = domain.OperationFailed
	cancelled.ErrorCode = "lifecycle_cancelled"
	store.operationNext = &cancelled
	store.operationCalls = 0
	temporalClient.updateCalls = nil
	temporalClient.updateErr = nil
	temporalClient.handle = &fakeUpdateHandle{getErr: errors.New("update lost")}
	view, err := service.CancelLifecycleOperation(t.Context(), cancelInput())
	require.NoError(t, err)
	require.Equal(t, domain.OperationFailed, view.State)
	require.Len(t, temporalClient.updateCalls, 1)
}
