package postgres

import (
	"context"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestDeleteWorkflowFailureAndExplicitRetry(t *testing.T) {
	repository, base := identityTestRepository(t)
	deps := &deleteRetryDependencies{offboardingDependencies: &offboardingDependencies{
		network: *closedNetworkAttachment(base.Agent.AgentID),
		runtime: ports.RuntimeOperation{RuntimeRevision: base.Agent.RuntimeRevision, RuntimeExecutionID: base.Agent.RuntimeExecutionID,
			MCPEndpoint: base.Agent.RuntimeMCPEndpoint, LifecycleState: "ready", Health: "healthy"},
	}, reject: true, calls: make(map[string]int)}
	service := application.NewLifecycleService(repository, repository, deps, deps, offboardingClock{})
	ctx := context.Background()
	input := application.DeleteAgentInput{RequestID: "delete-rejected", AgentID: base.Agent.AgentID}
	if _, err := service.DeleteAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	executeLifecycleWorkflowForTest(t, repository, service, input.RequestID, domain.OperationFailed)
	failed, err := repository.GetLifecycleOperation(ctx, input.RequestID)
	if err != nil || failed.ErrorCode != "docker_denied" || failed.ErrorDetail != "Docker rejected deletion" {
		t.Fatalf("failure diagnostics: %+v %v", failed, err)
	}
	agent, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil || agent.DesiredState != domain.DesiredDeleted || agent.LifecycleState != domain.AgentUnavailable || agent.ActiveOperationRequestID != "" || deps.releases != 0 {
		t.Fatalf("failure escaped isolation: %+v %v", agent, err)
	}
	visible, err := repository.ListAgents(ctx, ports.AgentQuery{OwnerUserID: base.Agent.OwnerUserID, Limit: 10})
	if err != nil || len(visible) != 1 || visible[0].AgentID != base.Agent.AgentID {
		t.Fatalf("administrator cannot discover failed deletion: %+v %v", visible, err)
	}
	if _, err := service.DeleteAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	deps.reject = false
	const replacementRevision = "rtv_replacement_after_failure"
	deps.runtime.RuntimeRevision = replacementRevision
	input.RequestID = "delete-explicit-retry"
	if _, err := service.DeleteAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	executeLifecycleWorkflowForTest(t, repository, service, input.RequestID, domain.OperationCompleted)
	visible, err = repository.ListAgents(ctx, ports.AgentQuery{OwnerUserID: base.Agent.OwnerUserID, Limit: 10})
	if err != nil || len(visible) != 0 {
		t.Fatalf("completed deletion remains in current fleet: %+v %v", visible, err)
	}
	if deps.releases != 1 || len(deps.calls) != 2 {
		t.Fatalf("wrong effect counts: deletes=%v releases=%d", deps.calls, deps.releases)
	}
	if len(deps.revisions) != 2 || deps.revisions[1] != replacementRevision {
		t.Fatalf("retry used stale Runtime projection: %v", deps.revisions)
	}
	for _, count := range deps.calls {
		if count != 1 {
			t.Fatalf("terminal request was retried: %v", deps.calls)
		}
	}
}

type deleteRetryDependencies struct {
	*offboardingDependencies
	reject    bool
	calls     map[string]int
	releases  int
	revisions []string
}

func (deps *deleteRetryDependencies) DeleteRuntime(_ context.Context, requestID, _, revision string) (ports.RuntimeOperation, error) {
	deps.calls[requestID]++
	deps.revisions = append(deps.revisions, revision)
	if deps.reject {
		return ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "docker_denied", ErrorDetail: "Docker rejected deletion"}, nil
	}
	deps.runtime = ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_deleted", LifecycleState: "deleted", Health: "absent"}
	return deps.runtime, nil
}

func (deps *deleteRetryDependencies) ReleaseAgentNetwork(_ context.Context, agentID string, _ uint64) (ports.NetworkAttachment, error) {
	deps.releases++
	deps.network.AgentID = agentID
	deps.network.State = ports.NetworkStateQuarantined
	deps.network.AttachmentState = ports.NetworkAttachmentClosed
	return deps.network, nil
}
