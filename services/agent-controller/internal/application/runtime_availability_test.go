package application

import (
	"context"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestCreateCompletesBeforeRuntimeBecomesExecutable(t *testing.T) {
	t.Parallel()
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed", RuntimeRevision: "runtime-created",
			LifecycleState: "provisioned", Health: "unknown",
		},
	}
	result, err := executeCreateForTest(newLifecycleTestService(t, store, dependencies),
		context.Background(), lifecycleCreateInput("create-before-ready"))
	if err != nil {
		t.Fatal(err)
	}
	if result.Operation.State != domain.OperationCompleted || (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) {
		t.Fatalf("creation must finish independently of readiness: %+v", result)
	}
	if result.Agent.ExecutionRevisionID != "" || result.Agent.RuntimeExecutionID != "" || result.Agent.RuntimeMCPEndpoint != "" {
		t.Fatalf("creation manufactured an executable binding: %+v", result.Agent)
	}
}
