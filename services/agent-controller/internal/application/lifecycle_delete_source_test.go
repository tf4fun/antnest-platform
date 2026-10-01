package application

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestDeleteFreezesFailedRuntimeBeforeEffectsAndSurvivesWorkerRestart(t *testing.T) {
	t.Parallel()
	base := deleteAgentBase(domain.RuntimeUnknown)
	base.Agent.RuntimeRevision, base.Agent.RuntimeExecutionID, base.Agent.RuntimeMCPEndpoint = "", "", ""
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.inspection = ports.RuntimeInspection{AgentID: base.Agent.AgentID,
		RuntimeRevision: "rtv_failed_owned", LifecycleState: "failed", Health: "unhealthy"}
	clock := fixedClock{now: time.Unix(716, 0).UTC()}
	service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, clock,
		WithLifecycleExecution(testExecutionForStore(store)),
	)
	ctx := context.Background()
	if _, err := service.DeleteAgent(ctx, DeleteAgentInput{RequestID: "request-delete-failed", AgentID: base.Agent.AgentID}); err != nil {
		t.Fatal(err)
	}
	if len(dependencies.calls) != 0 || store.begin.Operation.SourceRuntimeAbsent {
		t.Fatalf("admission performed RPC or fabricated absence: %+v %v", store.begin, dependencies.calls)
	}
	for range 2 {
		if _, err := service.stepAgentDelete(ctx, store.state); err != nil {
			t.Fatal(err)
		}
	}
	if store.state.Operation.Phase != domain.PhaseRuntimeDelete || store.state.Operation.SourceRuntimeRevision != "rtv_failed_owned" || slices.Contains(dependencies.calls, "runtime.delete") {
		t.Fatalf("source not frozen before delete: %+v %v", store.state.Operation, dependencies.calls)
	}
	childKey := store.state.Operation.ChildRequestID
	dependencies.runtime = ports.RuntimeOperation{State: "unknown", Effect: "unknown"}
	if _, err := service.stepAgentDelete(ctx, store.state); err != nil {
		t.Fatal(err)
	}
	dependencies.inspection.RuntimeRevision = "rtv_replacement_must_not_be_adopted"
	dependencies.calls = nil
	restarted := newTestLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, clock,
		WithLifecycleExecution(testExecutionForStore(store)),
	)
	if _, err := restarted.stepAgentDelete(ctx, store.state); err != nil {
		t.Fatal(err)
	}
	if dependencies.expectedRuntimeRevision != "rtv_failed_owned" || dependencies.runtimeRequestID != childKey || slices.Contains(dependencies.calls, "runtime.inspect") {
		t.Fatalf("retry rebased cleanup: expected=%s key=%s calls=%v", dependencies.expectedRuntimeRevision, dependencies.runtimeRequestID, dependencies.calls)
	}
}

func TestDeleteWaitsForUnresolvedRuntimeOwnership(t *testing.T) {
	t.Parallel()
	for _, lifecycle := range []string{"initializing", "unknown", "deleting"} {
		t.Run(lifecycle, func(t *testing.T) {
			base := deleteAgentBase(domain.RuntimeUnknown)
			base.Agent.RuntimeRevision, base.Agent.RuntimeExecutionID, base.Agent.RuntimeMCPEndpoint = "", "", ""
			store := &deleteLifecycleStoreStub{base: base}
			dependencies := newDeleteDependencies(base.Agent)
			dependencies.inspection = ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: "rtv_unresolved", LifecycleState: lifecycle, Health: "unknown"}
			service := newTestLifecycleService(lifecycleSpecSourceStub{}, store, dependencies, dependencies, fixedClock{now: time.Unix(717, 0).UTC()},
				WithLifecycleExecution(testExecutionForStore(store)),
			)
			_, err := executeDeleteForTest(service, context.Background(), DeleteAgentInput{RequestID: "request-delete-unresolved", AgentID: base.Agent.AgentID})
			if err != nil || store.state.Operation.Phase != domain.PhaseNetworkFence || store.state.Operation.SourceRuntimeAbsent || store.state.Operation.SourceRuntimeRevision != "" {
				t.Fatalf("unresolved ownership advanced or failed: %+v %v", store.state.Operation, err)
			}
			if slices.Contains(dependencies.calls, "runtime.delete") || slices.Contains(dependencies.calls, "egress.release") {
				t.Fatalf("unresolved ownership had effects: %v", dependencies.calls)
			}
		})
	}
}
