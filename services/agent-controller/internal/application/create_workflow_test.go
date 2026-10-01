package application

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestCreateWorkflowStageReplayAndOrdering(t *testing.T) {
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{network: validLifecycleNetwork()}
	service := newLifecycleTestService(t, store, dependencies)
	input := lifecycleCreateInput("workflow-stage-replay")
	ctx := context.Background()
	if _, err := service.CreateAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdvanceAgentCreate(ctx, input, domain.PhasePublish); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("future phase accepted: %v", err)
	}
	if len(dependencies.calls) != 0 {
		t.Fatal("future phase executed a side effect")
	}
	first, err := service.AdvanceAgentCreate(ctx, input, domain.PhaseNetworkEnsure)
	if err != nil || first.Phase != domain.PhaseRuntimeInitialize {
		t.Fatalf("network stage: %+v %v", first, err)
	}
	calls := len(dependencies.calls)
	replayed, err := service.AdvanceAgentCreate(ctx, input, domain.PhaseNetworkEnsure)
	if err != nil || replayed.Phase != first.Phase || len(dependencies.calls) != calls {
		t.Fatalf("stage replay repeated effects: %+v %v %v", replayed, err, dependencies.calls)
	}
	input.OrganizationID = "other-org"
	if _, _, err := service.ReplayCreateAgent(ctx, input); !errors.Is(err, ErrAgentNotFound) {
		t.Fatalf("cross-organization replay accepted: %v", err)
	}
}

func TestCreateWorkflowPendingRuntimeRemainsRetryable(t *testing.T) {
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "unknown"}}
	service := newLifecycleTestService(t, store, dependencies)
	input := lifecycleCreateInput("workflow-runtime-pending")
	ctx := context.Background()
	if _, err := service.CreateAgent(ctx, input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdvanceAgentCreate(ctx, input, domain.PhaseNetworkEnsure); err != nil {
		t.Fatal(err)
	}
	if _, err := service.AdvanceAgentCreate(ctx, input, domain.PhaseRuntimeInitialize); !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("pending Runtime was treated as completed: %v", err)
	}
	result, found, err := service.ReplayCreateAgent(ctx, input)
	if err != nil || !found || result.Operation.Phase != domain.PhaseRuntimeInitialize {
		t.Fatalf("pending effect lost durable phase: %+v %v %v", result, found, err)
	}
}
