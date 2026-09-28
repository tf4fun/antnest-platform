package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeLossRebuildUsesHistoryWithoutReadmittingOldExecution(t *testing.T) {
	for _, kind := range []string{"runtime_missing", "runtime_deleted", "restarted"} {
		t.Run(kind, func(t *testing.T) {
			ctx, repository, _ := controllerTestConnection(t)
			base, seed := seedAvailableAgentForRebuild(t, ctx, repository)
			if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
				Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				Kind: kind, ObservedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
			assertNoExecutableRecoveryBase(t, ctx, repository, base.Agent.AgentID)
			deps := newRuntimeRebuildDependencies(base.Agent)
			service, worker := runtimeRebuildServices(t, repository, deps)
			input := application.RebuildAgentInput{
				RequestID: "recover-runtime", AgentID: base.Agent.AgentID,
				TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision(),
			}
			accepted, err := service.RebuildAgent(ctx, input)
			if err != nil {
				t.Fatalf("Runtime loss has no explicit rebuild path: %v", err)
			}
			if accepted.Operation.State != domain.OperationRunning || accepted.Agent.ExecutionRevisionID != "" ||
				(accepted.Agent.LifecycleState != domain.AgentCreated || accepted.Agent.ActivationState != domain.ActivationEnabled || accepted.Agent.RuntimeState != domain.RuntimeUnknown) || deps.updateCalls != 0 {
				t.Fatalf("recovery admission reactivated old execution or ran effects: %+v", accepted)
			}
			closed := publishedAgentForTest(t, repository, base.Agent)
			if closed.AcceptingRuns {
				t.Fatal("rebuilding Agent was published as executable")
			}
			finishOffboardingOperation(t, repository, worker, input.RequestID, domain.OperationCompleted)
			agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
			if err != nil || (agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeUnknown) || agent.ExecutionRevisionID != "" ||
				agent.RuntimeRevision != deps.runtime.RuntimeRevision || agent.FailureCode != "" || deps.updateCalls != 1 {
				t.Fatalf("rebuild publication=%+v updates=%d error=%v", agent, deps.updateCalls, err)
			}
			if _, err := service.RebuildAgent(ctx, input); err != nil || deps.updateCalls != 1 {
				t.Fatalf("replay repeated Runtime mutation: %v", err)
			}
			if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
				Sequence: 2, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				Kind: "runtime_deleted", ObservedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
			operation, err := repository.GetLifecycleOperation(ctx, input.RequestID)
			if err != nil {
				t.Fatal(err)
			}
			observeRuntimeForTest(t, ctx, repository, agent, operation, "recovered-execution", "recovered-process", "http://recovered:8091/mcp")
			agent, err = repository.GetAgent(ctx, agent.AgentID)
			if err != nil {
				t.Fatal(err)
			}
			published := publishedAgentForTest(t, repository, agent)
			if !published.AcceptingRuns || published.Runtime == nil || published.Runtime.RuntimeRevision != agent.RuntimeRevision {
				t.Fatalf("new binding unavailable after late old observation: %+v", published)
			}
		})
	}
}

func TestRuntimeLossRebuildEarlyFailureRemainsUnavailableAndRetryable(t *testing.T) {
	ctx, repository, _ := controllerTestConnection(t)
	base, seed := seedAvailableAgentForRebuild(t, ctx, repository)
	if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
		Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		Kind: "runtime_missing", ObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	deps := newRuntimeRebuildDependencies(base.Agent)
	deps.networkFailure = true
	service, worker := runtimeRebuildServices(t, repository, deps)
	input := application.RebuildAgentInput{RequestID: "recovery-failed", AgentID: base.Agent.AgentID,
		TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()}
	if _, err := service.RebuildAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	finishOffboardingOperation(t, repository, worker, input.RequestID, domain.OperationFailed)
	assertNoExecutableRecoveryBase(t, ctx, repository, base.Agent.AgentID)
	if deps.updateCalls != 0 || deps.network.AttachmentState != ports.NetworkAttachmentClosed {
		t.Fatal("early failure executed Runtime or opened historical network")
	}
	deps.networkFailure = false
	input.RequestID = "recovery-retry"
	if _, err := service.RebuildAgent(ctx, input); err != nil {
		t.Fatalf("failed early recovery cannot be retried: %v", err)
	}
	finishOffboardingOperation(t, repository, worker, input.RequestID, domain.OperationCompleted)
}

func TestRuntimeLossRebuildNotStartedFailureKeepsHistoryAndFence(t *testing.T) {
	ctx, repository, _ := controllerTestConnection(t)
	base, seed := seedAvailableAgentForRebuild(t, ctx, repository)
	if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
		Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		Kind: "runtime_missing", ObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	deps := newRuntimeRebuildDependencies(base.Agent)
	deps.runtime = ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "runtime_image_missing"}
	service, worker := runtimeRebuildServices(t, repository, deps)
	input := application.RebuildAgentInput{RequestID: "recovery-not-started", AgentID: base.Agent.AgentID,
		TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()}
	if _, err := service.RebuildAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	finishOffboardingOperation(t, repository, worker, input.RequestID, domain.OperationFailed)
	assertNoExecutableRecoveryBase(t, ctx, repository, base.Agent.AgentID)
	if deps.network.AttachmentState != ports.NetworkAttachmentClosed || deps.updateCalls != 1 {
		t.Fatal("failed recovery reopened network or repeated effects")
	}
	deps.runtime = newRuntimeRebuildDependencies(base.Agent).runtime
	input.RequestID = "recovery-after-correction"
	if _, err := service.RebuildAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	finishOffboardingOperation(t, repository, worker, input.RequestID, domain.OperationCompleted)
	agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.RuntimeRevision != deps.runtime.RuntimeRevision || agent.ActiveOperationRequestID != "" {
		t.Fatalf("corrected rebuild did not publish the new Runtime: %+v %v", agent, err)
	}
}

func assertNoExecutableRecoveryBase(t *testing.T, ctx context.Context, repository *Repository, agentID string) {
	t.Helper()
	base, err := repository.GetAgentLifecycleBase(ctx, agentID)
	if err != nil || (base.Agent.LifecycleState != domain.AgentCreated || base.Agent.ActivationState != domain.ActivationEnabled || base.Agent.RuntimeState != domain.RuntimeUnknown) || base.Agent.ExecutionRevisionID != "" ||
		base.SourceExecution.ID == "" || base.ConfiguredSpec.ID == "" {
		t.Fatalf("history was exposed as executable source: %+v error=%v", base, err)
	}
}

type runtimeRebuildDependencies struct {
	offboardingDependencies
	expectedRevision string
	updateCalls      int
	networkFailure   bool
	updateError      error
	inspection       *ports.RuntimeInspection
}

func newRuntimeRebuildDependencies(agent ports.AgentRecord) *runtimeRebuildDependencies {
	return &runtimeRebuildDependencies{expectedRevision: agent.RuntimeRevision, offboardingDependencies: offboardingDependencies{
		network: *closedNetworkAttachment(agent.AgentID),
		runtime: ports.RuntimeOperation{State: "completed", Effect: "completed", LifecycleState: "provisioned", Health: "unknown",
			RuntimeRevision: "rtv_22222222222222222222222222222222", RuntimeExecutionID: "", MCPEndpoint: ""},
	}}
}

func (deps *runtimeRebuildDependencies) GetAgentNetwork(ctx context.Context, agentID string) (ports.NetworkAttachment, error) {
	if deps.networkFailure {
		return ports.NetworkAttachment{}, &ports.DependencyError{Service: "runtime-egress", Code: "synthetic_configuration_error"}
	}
	return deps.offboardingDependencies.GetAgentNetwork(ctx, agentID)
}

func (deps *runtimeRebuildDependencies) UpdateRuntime(_ context.Context, _, _ string, revision string, _ ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	deps.updateCalls++
	if revision != deps.expectedRevision || deps.network.AttachmentState != ports.NetworkAttachmentClosed {
		return ports.RuntimeOperation{}, errors.New("incorrect Runtime source or missing network fence")
	}
	if deps.updateError != nil {
		return ports.RuntimeOperation{}, deps.updateError
	}
	return deps.runtime, nil
}

func (deps *runtimeRebuildDependencies) InspectRuntime(ctx context.Context, agentID string) (ports.RuntimeInspection, error) {
	if deps.inspection != nil {
		return *deps.inspection, nil
	}
	return deps.offboardingDependencies.InspectRuntime(ctx, agentID)
}

func TestRuntimeLossRebuildRejectedUpdateDoesNotWaitForDeadExecution(t *testing.T) {
	for _, health := range []string{"absent", "healthy"} {
		t.Run(health, func(t *testing.T) {
			ctx, repository, _ := controllerTestConnection(t)
			base, seed := seedAvailableAgentForRebuild(t, ctx, repository)
			if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
				Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				Kind: "runtime_missing", ObservedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
			deps := newRuntimeRebuildDependencies(base.Agent)
			deps.updateError = &ports.DependencyError{Service: "runtime-controller", Code: "image_not_found"}
			deps.inspection = &ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				LifecycleState: "provisioned", Health: health}
			if health == "healthy" {
				deps.inspection.RuntimeExecutionID = "unexpectedly-restarted-process"
				deps.inspection.MCPEndpoint = "http://restarted:8091/mcp"
			}
			service, worker := runtimeRebuildServices(t, repository, deps)
			input := application.RebuildAgentInput{RequestID: "recovery-rejected", AgentID: base.Agent.AgentID,
				TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()}
			if _, err := service.RebuildAgent(ctx, input); err != nil {
				t.Fatal(err)
			}
			finishOffboardingOperation(t, repository, worker, input.RequestID, domain.OperationFailed)
			assertNoExecutableRecoveryBase(t, ctx, repository, base.Agent.AgentID)
			if deps.network.AttachmentState != ports.NetworkAttachmentClosed || deps.updateCalls != 1 {
				t.Fatal("rejected update reopened network or retried forever")
			}
		})
	}
}

func runtimeRebuildServices(t *testing.T, repository *Repository, deps *runtimeRebuildDependencies) (*application.LifecycleService, *application.LifecycleService) {
	t.Helper()
	service := newIntegratedLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
	return service, service
}
