package orchestration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/require"
	commonpb "go.temporal.io/api/common/v1"
	enums "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/serviceerror"
	taskqueuepb "go.temporal.io/api/taskqueue/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	workflowservice "go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/converter"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryEnsureStartUsesOriginalEngineIdentityForAllKnownStatuses(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		status  enums.WorkflowExecutionStatus
		already bool
	}{
		{"new-running", enums.WORKFLOW_EXECUTION_STATUS_RUNNING, false},
		{"existing-running", enums.WORKFLOW_EXECUTION_STATUS_RUNNING, false},
		{"closed-completed", enums.WORKFLOW_EXECUTION_STATUS_COMPLETED, true},
		{"closed-failed", enums.WORKFLOW_EXECUTION_STATUS_FAILED, true},
		{"closed-canceled", enums.WORKFLOW_EXECUTION_STATUS_CANCELED, true},
		{"closed-terminated", enums.WORKFLOW_EXECUTION_STATUS_TERMINATED, true},
		{"closed-continued-as-new", enums.WORKFLOW_EXECUTION_STATUS_CONTINUED_AS_NEW, true},
		{"closed-timed-out", enums.WORKFLOW_EXECUTION_STATUS_TIMED_OUT, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierRecoveryStartFixture(t)
			fixture.client.description.WorkflowExecutionInfo.Status = scenario.status
			if scenario.already {
				fixture.client.startErr = serviceerror.NewWorkflowExecutionAlreadyStarted("already started", "original-start", fixture.runID)
			}
			original := cloneRuntimeBarrierRecoveryStartReceipt(fixture.receipt)

			err := fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), fixture.receipt)

			require.NoError(t, err)
			require.Equal(t, original, fixture.receipt)
			fixture.assertEngineIdentity(t)
			require.Equal(t, []string{"execute", "describe", "history", "history.next"}, fixture.client.snapshot().calls)
		})
	}
}

func TestRuntimeBarrierRecoveryEnsureStartRejectsMismatchedExecutionAndOriginalInput(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(*testing.T, *runtimeBarrierRecoveryStartFixture)
	}{
		{"nil-description", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) { fixture.client.description = nil }},
		{"missing-execution-info", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo = nil
		}},
		{"missing-execution", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.Execution = nil
		}},
		{"different-workflow-ID", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.Execution.WorkflowId = "agent-rebuild/foreign-request"
		}},
		{"different-run-ID", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.Execution.RunId = "foreign-run"
		}},
		{"different-described-workflow-type", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.Type.Name = "CreateAgentWorkflow"
		}},
		{"different-described-config-task-queue", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.ExecutionConfig.TaskQueue.Name = "foreign-task-queue"
		}},
		{"different-described-info-task-queue", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.TaskQueue = "foreign-task-queue"
		}},
		{"unspecified-status", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.Status = enums.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED
		}},
		{"unknown-status", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.description.WorkflowExecutionInfo.Status = enums.WorkflowExecutionStatus(999)
		}},
		{"nil-history", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) { fixture.client.history = nil }},
		{"empty-history", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) { fixture.client.history.events = nil }},
		{"missing-started-attributes", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.history.events = []*historypb.HistoryEvent{{EventId: 1}}
		}},
		{"different-started-event-ID", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.history.events[0].EventId = 2
		}},
		{"different-started-event-type", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.history.events[0].EventType = enums.EVENT_TYPE_WORKFLOW_TASK_SCHEDULED
		}},
		{"different-started-workflow-type", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.started().WorkflowType.Name = "CreateAgentWorkflow"
		}},
		{"different-started-task-queue", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.started().TaskQueue.Name = "foreign-task-queue"
		}},
		{"nil-original-input", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) { fixture.started().Input = nil }},
		{"empty-original-input", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.started().Input = &commonpb.Payloads{}
		}},
		{"extra-original-input", func(t *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.started().Input = runtimeBarrierRecoveryStartPayloads(t, fixture.command, fixture.command)
		}},
		{"invalid-original-input", func(_ *testing.T, fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.started().Input.Payloads[0].Data = []byte("{")
		}},
	} {
		for _, already := range []bool{false, true} {
			t.Run(scenario.name+map[bool]string{false: "/running", true: "/closed"}[already], func(t *testing.T) {
				fixture := newRuntimeBarrierRecoveryStartFixture(t)
				if already {
					fixture.client.startErr = serviceerror.NewWorkflowExecutionAlreadyStarted("already started", "original-start", fixture.runID)
					fixture.client.description.WorkflowExecutionInfo.Status = enums.WORKFLOW_EXECUTION_STATUS_COMPLETED
				}
				scenario.change(t, fixture)

				err := fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), fixture.receipt)

				require.Error(t, err)
				fixture.assertEngineIdentity(t)
				require.Len(t, fixture.client.snapshot().executions, 1, "a conflicting or unverifiable execution cannot trigger a second start")
			})
		}
	}

	for _, scenario := range []struct {
		name   string
		change func(*application.LifecycleCommand)
	}{
		{"kind", func(command *application.LifecycleCommand) { command.Kind = domain.OperationDelete }},
		{"request", func(command *application.LifecycleCommand) { command.RequestID = "another-request" }},
		{"organization", func(command *application.LifecycleCommand) { command.OrganizationID = "another-organization" }},
		{"actor", func(command *application.LifecycleCommand) { command.ActorPrincipalID = "another-actor" }},
		{"Agent", func(command *application.LifecycleCommand) { command.AgentID = "another-Agent" }},
		{"Template", func(command *application.LifecycleCommand) { command.TemplateID = "another-Template" }},
		{"Template-revision", func(command *application.LifecycleCommand) { command.TemplateRevision++ }},
		{"owner-revocation-sequence", func(command *application.LifecycleCommand) { command.OwnerRevocationSequence = 1 }},
	} {
		for _, already := range []bool{false, true} {
			t.Run("command/"+scenario.name+map[bool]string{false: "/running", true: "/closed"}[already], func(t *testing.T) {
				fixture := newRuntimeBarrierRecoveryStartFixture(t)
				if already {
					fixture.client.startErr = serviceerror.NewWorkflowExecutionAlreadyStarted("already started", "original-start", fixture.runID)
					fixture.client.description.WorkflowExecutionInfo.Status = enums.WORKFLOW_EXECUTION_STATUS_FAILED
				}
				other := fixture.command
				scenario.change(&other)
				fixture.started().Input = runtimeBarrierRecoveryStartPayloads(t, other)

				err := fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), fixture.receipt)

				require.Error(t, err)
				fixture.assertEngineIdentity(t)
				require.Equal(t, []string{"execute", "describe", "history", "history.next"}, fixture.client.snapshot().calls)
			})
		}
	}
}

func TestRuntimeBarrierRecoveryEnsureStartDoesNotAcceptUnknownDependencyResults(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(*runtimeBarrierRecoveryStartFixture)
		calls  []string
	}{
		{"start-error", func(fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.startErr = errors.New("engine start unavailable")
		}, []string{"execute"}},
		{"nil-run", func(fixture *runtimeBarrierRecoveryStartFixture) { fixture.client.run = nil }, []string{"execute"}},
		{"different-returned-workflow-ID", func(fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.run.workflowID = "agent-rebuild/foreign-request"
		}, []string{"execute"}},
		{"empty-run-ID", func(fixture *runtimeBarrierRecoveryStartFixture) { fixture.client.run.runID = "" }, []string{"execute"}},
		{"closed-without-run-ID", func(fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.startErr = serviceerror.NewWorkflowExecutionAlreadyStarted("already started", "original-start", "")
		}, []string{"execute"}},
		{"describe-error", func(fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.describeErr = errors.New("engine describe unavailable")
		}, []string{"execute", "describe"}},
		{"history-error", func(fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.history.nextErr = errors.New("engine history unavailable")
		}, []string{"execute", "describe", "history", "history.next"}},
		{"expired-closed-history", func(fixture *runtimeBarrierRecoveryStartFixture) {
			fixture.client.startErr = serviceerror.NewWorkflowExecutionAlreadyStarted("already started", "original-start", fixture.runID)
			fixture.client.description.WorkflowExecutionInfo.Status = enums.WORKFLOW_EXECUTION_STATUS_COMPLETED
			fixture.client.history.nextErr = serviceerror.NewNotFound("history is unavailable")
		}, []string{"execute", "describe", "history", "history.next"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierRecoveryStartFixture(t)
			scenario.change(fixture)

			err := fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), fixture.receipt)

			require.Error(t, err)
			fixture.assertEngineIdentity(t)
			require.Equal(t, scenario.calls, fixture.client.snapshot().calls)
		})
	}
}

func TestRuntimeBarrierRecoveryEnsureStartCancellationJoinsTheActualDependency(t *testing.T) {
	for _, boundary := range []string{"execute", "describe", "history.next"} {
		for _, deadline := range []bool{false, true} {
			t.Run(boundary+map[bool]string{false: "/cancel", true: "/deadline"}[deadline], func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					fixture := newRuntimeBarrierRecoveryStartFixture(t)
					ctx, cancel := context.WithCancel(context.Background())
					if deadline {
						cancel()
						ctx, cancel = context.WithTimeout(context.Background(), time.Second)
					}
					entered, cancellationSeen := make(chan struct{}), make(chan struct{})
					release, dependencyReturned := make(chan struct{}), make(chan struct{})
					returned := make(chan struct{})
					results := make(chan error, 1)
					var releaseOnce sync.Once
					releaseHeld := func() { releaseOnce.Do(func() { close(release) }) }
					held := func(callContext context.Context) {
						close(entered)
						defer close(dependencyReturned)
						select {
						case <-callContext.Done():
						case <-release:
							// Independent cleanup also releases a broken implementation
							// that dispatched with an unrelated context.
							return
						}
						close(cancellationSeen)
						<-release
						// Deliberately return the ordinary successful SDK value after
						// cancellation. The caller must join and recheck its context.
					}
					switch boundary {
					case "execute":
						fixture.client.executeHook = held
					case "describe":
						fixture.client.describeHook = held
					case "history.next":
						fixture.client.history.nextHook = held
					}
					defer func() {
						cancel()
						releaseHeld()
						select {
						case <-entered:
							select {
							case <-dependencyReturned:
							case <-time.After(5 * time.Second):
								t.Error("the held SDK call did not join during independent cleanup")
							}
						default:
						}
						select {
						case <-returned:
						case <-time.After(5 * time.Second):
							t.Error("ensure-start did not join during independent cleanup")
						}
					}()
					go func() {
						defer close(returned)
						results <- fixture.service.EnsureRuntimeBarrierRecoveryStarted(ctx, fixture.receipt)
					}()
					awaitRuntimeBarrierRecoveryStartSignal(t, entered, "the actual SDK boundary was not entered")
					if deadline {
						awaitRuntimeBarrierRecoveryStartSignal(t, ctx.Done(), "the actual parent deadline did not expire")
					} else {
						cancel()
					}
					awaitRuntimeBarrierRecoveryStartSignal(t, cancellationSeen, "the actual SDK call did not observe parent cancellation")
					synctest.Wait()
					select {
					case <-returned:
						t.Fatal("ensure-start returned before its held SDK call actually settled")
					default:
					}
					releaseHeld()
					awaitRuntimeBarrierRecoveryStartSignal(t, dependencyReturned, "the actual held SDK call did not settle")
					awaitRuntimeBarrierRecoveryStartSignal(t, returned, "ensure-start did not join its settled SDK call")
					err := <-results
					if deadline {
						require.ErrorIs(t, err, context.DeadlineExceeded)
					} else {
						require.ErrorIs(t, err, context.Canceled)
					}
					fixture.assertEngineIdentity(t)
					wanted := map[string][]string{
						"execute":      {"execute"},
						"describe":     {"execute", "describe"},
						"history.next": {"execute", "describe", "history", "history.next"},
					}
					require.Equal(t, wanted[boundary], fixture.client.snapshot().calls, "no new dependency dispatch after cancellation")
				})
			})
		}
	}
}

func TestRuntimeBarrierRecoveryEnsureStartRejectsInvalidReceiptBeforeEngineCalls(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(*ports.RuntimeBarrierRecoveryReceipt)
	}{
		{"zero-receipt", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { *receipt = ports.RuntimeBarrierRecoveryReceipt{} }},
		{"nil-barrier", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Fact.Barrier = nil }},
		{"invalid-reason", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Fact.Barrier.Reason = "worker_lost" }},
		{"missing-original-execution", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Fact.Barrier.RuntimeExecutionID = "" }},
		{"wrong-derived-request", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Command.RequestID = "another-request" }},
		{"wrong-organization", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Command.OrganizationID = "another-organization"
		}},
		{"wrong-Agent", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Command.AgentID = "another-Agent" }},
		{"wrong-actor", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Command.ActorPrincipalID = "ordinary-owner"
		}},
		{"invalid-template-with-valid-fingerprint", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Command.TemplateID = "template/invalid"
			receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(receipt.Command)
		}},
		{"zero-template-revision-with-valid-fingerprint", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Command.TemplateRevision = 0
			receipt.RequestFingerprint = runtimeBarrierRecoveryStartFingerprint(receipt.Command)
		}},
		{"wrong-fingerprint", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.RequestFingerprint = strings.Repeat("f", 64)
		}},
		{"default-policy-is-not-auto", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Policy.Revision = 0 }},
		{"manual-policy", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Policy.Mode = "manual" }},
		{"notify-policy", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.Policy.Mode = "notify" }},
		{"foreign-policy", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.Policy.OrganizationID = "another-organization"
		}},
		{"missing-acceptance", func(receipt *ports.RuntimeBarrierRecoveryReceipt) { receipt.AcceptedAt = time.Time{} }},
		{"changed-cooldown", func(receipt *ports.RuntimeBarrierRecoveryReceipt) {
			receipt.CooldownUntil = receipt.CooldownUntil.Add(time.Second)
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRuntimeBarrierRecoveryStartFixture(t)
			receipt := cloneRuntimeBarrierRecoveryStartReceipt(fixture.receipt)
			scenario.change(&receipt)

			err := fixture.service.EnsureRuntimeBarrierRecoveryStarted(t.Context(), receipt)

			require.Error(t, err)
			require.Empty(t, fixture.client.snapshot().calls)
		})
	}
	for _, dependency := range []string{"nil-service", "nil-client", "already-cancelled"} {
		t.Run(dependency, func(t *testing.T) {
			fixture := newRuntimeBarrierRecoveryStartFixture(t)
			service, ctx := fixture.service, t.Context()
			switch dependency {
			case "nil-service":
				service = nil
			case "nil-client":
				service = NewService(nil, nil)
			case "already-cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			err := service.EnsureRuntimeBarrierRecoveryStarted(ctx, fixture.receipt)
			require.Error(t, err)
			if dependency == "already-cancelled" {
				require.ErrorIs(t, err, context.Canceled)
			}
			require.Empty(t, fixture.client.snapshot().calls)
		})
	}
}

type runtimeBarrierRecoveryStartExecution struct {
	options  client.StartWorkflowOptions
	workflow any
	args     []any
}

type runtimeBarrierRecoveryStartHistoryQuery struct {
	workflowID string
	runID      string
	longPoll   bool
	filter     enums.HistoryEventFilterType
}

type runtimeBarrierRecoveryStartCalls struct {
	calls      []string
	executions []runtimeBarrierRecoveryStartExecution
	describes  [][2]string
	histories  []runtimeBarrierRecoveryStartHistoryQuery
	forbidden  []string
}

type runtimeBarrierRecoveryStartClient struct {
	client.Client
	mu           sync.Mutex
	observed     runtimeBarrierRecoveryStartCalls
	run          *runtimeBarrierRecoveryStartRun
	startErr     error
	description  *workflowservice.DescribeWorkflowExecutionResponse
	describeErr  error
	history      *runtimeBarrierRecoveryStartHistory
	executeHook  func(context.Context)
	describeHook func(context.Context)
}

func (spy *runtimeBarrierRecoveryStartClient) record(call string) {
	spy.mu.Lock()
	defer spy.mu.Unlock()
	spy.observed.calls = append(spy.observed.calls, call)
}

func (spy *runtimeBarrierRecoveryStartClient) snapshot() runtimeBarrierRecoveryStartCalls {
	spy.mu.Lock()
	defer spy.mu.Unlock()
	return runtimeBarrierRecoveryStartCalls{
		calls: append([]string(nil), spy.observed.calls...), executions: append([]runtimeBarrierRecoveryStartExecution(nil), spy.observed.executions...),
		describes: append([][2]string(nil), spy.observed.describes...), histories: append([]runtimeBarrierRecoveryStartHistoryQuery(nil), spy.observed.histories...),
		forbidden: append([]string(nil), spy.observed.forbidden...),
	}
}

func (spy *runtimeBarrierRecoveryStartClient) ExecuteWorkflow(ctx context.Context, options client.StartWorkflowOptions, workflow any, args ...any) (client.WorkflowRun, error) {
	spy.mu.Lock()
	spy.observed.calls = append(spy.observed.calls, "execute")
	spy.observed.executions = append(spy.observed.executions, runtimeBarrierRecoveryStartExecution{options: options, workflow: workflow, args: append([]any(nil), args...)})
	spy.mu.Unlock()
	if spy.executeHook != nil {
		spy.executeHook(ctx)
	}
	if spy.startErr != nil {
		return nil, spy.startErr
	}
	if spy.run == nil {
		return nil, nil
	}
	return spy.run, nil
}

func (spy *runtimeBarrierRecoveryStartClient) DescribeWorkflowExecution(ctx context.Context, workflowID, runID string) (*workflowservice.DescribeWorkflowExecutionResponse, error) {
	spy.mu.Lock()
	spy.observed.calls = append(spy.observed.calls, "describe")
	spy.observed.describes = append(spy.observed.describes, [2]string{workflowID, runID})
	spy.mu.Unlock()
	if spy.describeHook != nil {
		spy.describeHook(ctx)
	}
	return spy.description, spy.describeErr
}

func (spy *runtimeBarrierRecoveryStartClient) GetWorkflowHistory(ctx context.Context, workflowID, runID string, longPoll bool, filter enums.HistoryEventFilterType) client.HistoryEventIterator {
	spy.mu.Lock()
	spy.observed.calls = append(spy.observed.calls, "history")
	spy.observed.histories = append(spy.observed.histories, runtimeBarrierRecoveryStartHistoryQuery{workflowID: workflowID, runID: runID, longPoll: longPoll, filter: filter})
	spy.mu.Unlock()
	if spy.history == nil {
		return nil
	}
	spy.history.ctx = ctx
	return spy.history
}

func (spy *runtimeBarrierRecoveryStartClient) forbid(name string) {
	spy.mu.Lock()
	defer spy.mu.Unlock()
	spy.observed.forbidden = append(spy.observed.forbidden, name)
}

func (spy *runtimeBarrierRecoveryStartClient) NewWithStartWorkflowOperation(client.StartWorkflowOptions, any, ...any) client.WithStartWorkflowOperation {
	spy.forbid("NewWithStartWorkflowOperation")
	return nil
}

func (spy *runtimeBarrierRecoveryStartClient) UpdateWithStartWorkflow(context.Context, client.UpdateWithStartWorkflowOptions) (client.WorkflowUpdateHandle, error) {
	spy.forbid("UpdateWithStartWorkflow")
	return nil, errors.New("ensure-start must not use the ordinary admission update")
}

func (spy *runtimeBarrierRecoveryStartClient) GetWorkflowUpdateHandle(client.GetWorkflowUpdateHandleOptions) client.WorkflowUpdateHandle {
	spy.forbid("GetWorkflowUpdateHandle")
	return nil
}

type runtimeBarrierRecoveryStartRun struct {
	client.WorkflowRun
	spy        *runtimeBarrierRecoveryStartClient
	workflowID string
	runID      string
}

func (run *runtimeBarrierRecoveryStartRun) GetID() string                  { return run.workflowID }
func (run *runtimeBarrierRecoveryStartRun) GetRunID() string               { return run.runID }
func (run *runtimeBarrierRecoveryStartRun) GetFirstExecutionRunID() string { return run.runID }
func (run *runtimeBarrierRecoveryStartRun) Get(context.Context, any) error {
	run.spy.forbid("WorkflowRun.Get")
	return errors.New("ensure-start must not wait for lifecycle completion")
}

type runtimeBarrierRecoveryStartHistory struct {
	spy       *runtimeBarrierRecoveryStartClient
	ctx       context.Context
	events    []*historypb.HistoryEvent
	index     int
	nextErr   error
	nextHook  func(context.Context)
	errorRead bool
}

func (history *runtimeBarrierRecoveryStartHistory) HasNext() bool {
	return history.index < len(history.events) || (history.nextErr != nil && !history.errorRead)
}

func (history *runtimeBarrierRecoveryStartHistory) Next() (*historypb.HistoryEvent, error) {
	history.spy.record("history.next")
	if history.nextHook != nil {
		history.nextHook(history.ctx)
	}
	if history.nextErr != nil && !history.errorRead {
		history.errorRead = true
		return nil, history.nextErr
	}
	if history.index >= len(history.events) {
		return nil, io.EOF
	}
	event := history.events[history.index]
	history.index++
	return event, nil
}

type runtimeBarrierRecoveryStartFixture struct {
	receipt    ports.RuntimeBarrierRecoveryReceipt
	command    application.LifecycleCommand
	workflowID string
	runID      string
	client     *runtimeBarrierRecoveryStartClient
	service    *Service
}

func newRuntimeBarrierRecoveryStartFixture(t *testing.T) *runtimeBarrierRecoveryStartFixture {
	t.Helper()
	fact := ports.RuntimeBarrierResult{
		OrganizationID: "org-recovery", AgentID: "agent-recovery", RuntimeRevision: "rtv_original_recovery",
		Barrier: &ports.RuntimeBarrier{BarrierID: "barrier-e\u0301-\x00-🧪", Reason: ports.ExecutionRuntimeBarrierRequired, RuntimeExecutionID: "original-execution-\x00-🧪"},
	}
	requestID, err := ports.RuntimeBarrierRecoveryRequestID(fact.OrganizationID, fact.AgentID, fact.Barrier.BarrierID)
	require.NoError(t, err)
	command := ports.RuntimeBarrierRebuildCommand{
		RequestID: requestID, OrganizationID: fact.OrganizationID, ActorPrincipalID: "agent-controller", AgentID: fact.AgentID,
		TemplateID: "template-recovery-original", TemplateRevision: 3,
	}
	acceptedAt := time.Unix(1700000000, 123456000).UTC()
	receipt := ports.RuntimeBarrierRecoveryReceipt{
		Fact: fact, Policy: domain.RuntimeBarrierRecoveryPolicy{OrganizationID: fact.OrganizationID, Revision: 7, Mode: "auto", CooldownMS: 60000},
		Command: command, RequestFingerprint: runtimeBarrierRecoveryStartFingerprint(command), AcceptedAt: acceptedAt, CooldownUntil: acceptedAt.Add(time.Minute),
	}
	input := application.LifecycleCommand{
		Kind: domain.OperationRebuild, RequestID: command.RequestID, OrganizationID: command.OrganizationID,
		ActorPrincipalID: command.ActorPrincipalID, AgentID: command.AgentID,
		TemplateID: command.TemplateID, TemplateRevision: command.TemplateRevision,
	}
	workflowID, runID := "agent-rebuild/"+requestID, "11111111-1111-4111-8111-111111111111"
	spy := &runtimeBarrierRecoveryStartClient{}
	spy.run = &runtimeBarrierRecoveryStartRun{spy: spy, workflowID: workflowID, runID: runID}
	spy.description = &workflowservice.DescribeWorkflowExecutionResponse{
		ExecutionConfig: &workflowpb.WorkflowExecutionConfig{TaskQueue: &taskqueuepb.TaskQueue{Name: TaskQueue}},
		WorkflowExecutionInfo: &workflowpb.WorkflowExecutionInfo{
			Execution: &commonpb.WorkflowExecution{WorkflowId: workflowID, RunId: runID},
			Type:      &commonpb.WorkflowType{Name: "LifecycleWorkflow"}, Status: enums.WORKFLOW_EXECUTION_STATUS_RUNNING, TaskQueue: TaskQueue,
		},
	}
	spy.history = &runtimeBarrierRecoveryStartHistory{spy: spy, events: []*historypb.HistoryEvent{{
		EventId: 1, EventType: enums.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED,
		Attributes: &historypb.HistoryEvent_WorkflowExecutionStartedEventAttributes{
			WorkflowExecutionStartedEventAttributes: &historypb.WorkflowExecutionStartedEventAttributes{
				WorkflowType: &commonpb.WorkflowType{Name: "LifecycleWorkflow"}, TaskQueue: &taskqueuepb.TaskQueue{Name: TaskQueue},
				Input: runtimeBarrierRecoveryStartPayloads(t, input), WorkflowId: workflowID,
				OriginalExecutionRunId: runID, FirstExecutionRunId: runID,
			},
		},
	}}}
	fixture := &runtimeBarrierRecoveryStartFixture{receipt: receipt, command: input, workflowID: workflowID, runID: runID, client: spy, service: NewService(nil, spy)}
	t.Cleanup(func() {
		require.Empty(t, spy.snapshot().forbidden, "ensure-start must not use business replay, an admission update or workflow completion")
	})
	return fixture
}

func (fixture *runtimeBarrierRecoveryStartFixture) started() *historypb.WorkflowExecutionStartedEventAttributes {
	return fixture.client.history.events[0].GetWorkflowExecutionStartedEventAttributes()
}

func (fixture *runtimeBarrierRecoveryStartFixture) assertEngineIdentity(t *testing.T) {
	t.Helper()
	observed := fixture.client.snapshot()
	require.Len(t, observed.executions, 1)
	start := observed.executions[0]
	require.Equal(t, fixture.workflowID, start.options.ID)
	require.Equal(t, TaskQueue, start.options.TaskQueue)
	require.Equal(t, enums.WORKFLOW_ID_CONFLICT_POLICY_USE_EXISTING, start.options.WorkflowIDConflictPolicy)
	require.Equal(t, enums.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE, start.options.WorkflowIDReusePolicy)
	require.True(t, start.options.WorkflowExecutionErrorWhenAlreadyStarted)
	require.NotNil(t, start.workflow)
	require.Equal(t, reflect.Func, reflect.ValueOf(start.workflow).Kind())
	require.Equal(t, reflect.ValueOf(LifecycleWorkflow).Pointer(), reflect.ValueOf(start.workflow).Pointer())
	require.Equal(t, []any{fixture.command}, start.args, "only the original lifecycle intent enters Temporal; no fact, policy or refreshed command")
	for _, description := range observed.describes {
		require.Equal(t, [2]string{fixture.workflowID, fixture.runID}, description)
	}
	for _, query := range observed.histories {
		require.Equal(t, runtimeBarrierRecoveryStartHistoryQuery{
			workflowID: fixture.workflowID, runID: fixture.runID, longPoll: false, filter: enums.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT,
		}, query)
	}
}

func runtimeBarrierRecoveryStartPayloads(t *testing.T, values ...any) *commonpb.Payloads {
	t.Helper()
	payloads, err := converter.GetDefaultDataConverter().ToPayloads(values...)
	require.NoError(t, err)
	return payloads
}

func runtimeBarrierRecoveryStartFingerprint(command ports.RuntimeBarrierRebuildCommand) string {
	// The original six fields contain only strings and int64, so this encoding
	// cannot invoke a failing custom marshaler or encounter unsupported values.
	payload, _ := json.Marshal(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		AgentID          string
		TemplateID       string
		TemplateRevision int64
	}{command.RequestID, command.OrganizationID, command.ActorPrincipalID, command.AgentID, command.TemplateID, command.TemplateRevision})
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

func cloneRuntimeBarrierRecoveryStartReceipt(receipt ports.RuntimeBarrierRecoveryReceipt) ports.RuntimeBarrierRecoveryReceipt {
	if receipt.Fact.Barrier != nil {
		barrier := *receipt.Fact.Barrier
		receipt.Fact.Barrier = &barrier
	}
	return receipt
}

func awaitRuntimeBarrierRecoveryStartSignal(t *testing.T, signal <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(5 * time.Second):
		t.Fatal(message)
	}
}
