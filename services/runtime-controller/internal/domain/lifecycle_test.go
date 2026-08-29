package domain

import (
	"errors"
	"testing"
	"time"
)

func TestPlanLifecycleCommands(t *testing.T) {
	now := time.Date(2026, 8, 28, 3, 4, 5, 0, time.UTC)
	base := Runtime{
		AgentID:            "agent-1",
		ImageRef:           "antnest/runtime:test",
		NetworkMode:        NetworkRestricted,
		DesiredState:       DesiredActive,
		Status:             RuntimeReady,
		DesiredGeneration:  3,
		ObservedGeneration: 3,
		SpecDigest:         "spec",
		ResourceVersion:    7,
		CreatedAt:          now.Add(-time.Hour),
		UpdatedAt:          now.Add(-time.Minute),
	}

	tests := []struct {
		name       string
		kind       OperationKind
		desired    DesiredState
		wantStatus RuntimeStatus
		wantRetain bool
	}{
		{name: "stop", kind: OperationStop, desired: DesiredStopped, wantStatus: RuntimeStopping, wantRetain: true},
		{name: "retire", kind: OperationRetire, desired: DesiredRetired, wantStatus: RuntimeRetiring, wantRetain: true},
		{name: "purge", kind: OperationPurge, desired: DesiredPurged, wantStatus: RuntimePurging, wantRetain: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			plan, err := PlanLifecycle(base, nil, LifecycleCommand{
				AgentID: "agent-1", Kind: test.kind, IdempotencyKey: test.name + "-1",
				OperationID: "operation-" + test.name, Now: now,
			})
			if err != nil {
				t.Fatalf("plan lifecycle: %v", err)
			}
			if plan.Runtime.DesiredState != test.desired || plan.Runtime.Status != test.wantStatus {
				t.Fatalf("unexpected runtime: %+v", plan.Runtime)
			}
			if plan.Operation.Kind != test.kind || plan.Operation.Generation != 3 {
				t.Fatalf("unexpected operation: %+v", plan.Operation)
			}
			if plan.RetainWorkspace != test.wantRetain {
				t.Fatalf("retain workspace = %t, want %t", plan.RetainWorkspace, test.wantRetain)
			}
		})
	}
}

func TestPlanLifecycleReplaysOriginalOperation(t *testing.T) {
	now := time.Date(2026, 8, 28, 3, 4, 5, 0, time.UTC)
	runtime := Runtime{AgentID: "agent-1", DesiredGeneration: 1, ResourceVersion: 1}
	first, err := PlanLifecycle(runtime, nil, LifecycleCommand{
		AgentID: "agent-1", Kind: OperationStop, IdempotencyKey: "stop-1",
		OperationID: "operation-stop", Now: now,
	})
	if err != nil {
		t.Fatalf("first plan: %v", err)
	}

	replay, err := PlanLifecycle(first.Runtime, &first.Operation, LifecycleCommand{
		AgentID: "agent-1", Kind: OperationStop, IdempotencyKey: "stop-1",
		OperationID: "ignored", Now: now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replay.Replayed || replay.Operation != first.Operation || replay.Runtime != first.Runtime {
		t.Fatalf("replay changed plan: first=%+v replay=%+v", first, replay)
	}
}

func TestPlanLifecycleRejectsCrossCommandIdempotencyReuse(t *testing.T) {
	now := time.Date(2026, 8, 28, 3, 4, 5, 0, time.UTC)
	runtime := Runtime{AgentID: "agent-1", DesiredGeneration: 1, ResourceVersion: 1}
	first, err := PlanLifecycle(runtime, nil, LifecycleCommand{
		AgentID: "agent-1", Kind: OperationStop, IdempotencyKey: "request-1", Now: now,
	})
	if err != nil {
		t.Fatalf("first plan: %v", err)
	}

	_, err = PlanLifecycle(first.Runtime, &first.Operation, LifecycleCommand{
		AgentID: "agent-1", Kind: OperationPurge, IdempotencyKey: "request-1", Now: now,
	})
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected idempotency conflict, got %v", err)
	}
}

func TestPlanNetworkPolicyCreatesReplacementGeneration(t *testing.T) {
	now := time.Date(2026, 8, 28, 3, 4, 5, 0, time.UTC)
	runtime := Runtime{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test", SpecDigest: "old-spec",
		NetworkMode: NetworkRestricted, DesiredState: DesiredActive, Status: RuntimeReady,
		DesiredGeneration: 4, ObservedGeneration: 4,
		NetworkPolicyEpoch: 2, ObservedPolicyEpoch: 2, ResourceVersion: 9,
	}

	plan, err := PlanNetworkPolicy(runtime, nil, NetworkPolicyCommand{
		AgentID: "agent-1", NetworkMode: NetworkUnrestricted,
		IdempotencyKey: "network-1", OperationID: "operation-network", Now: now,
	})
	if err != nil {
		t.Fatalf("plan network policy: %v", err)
	}
	if plan.Runtime.DesiredGeneration != 5 || plan.Runtime.Status != RuntimePending {
		t.Fatalf("network policy did not request replacement: %+v", plan.Runtime)
	}
	if plan.Runtime.NetworkPolicyEpoch != 3 || plan.Runtime.NetworkMode != NetworkUnrestricted {
		t.Fatalf("network policy did not advance: %+v", plan.Runtime)
	}
	if plan.Generation == nil || plan.Generation.Number != 5 ||
		plan.Generation.NetworkPolicyEpoch != 3 || plan.Generation.ImageRef != runtime.ImageRef {
		t.Fatalf("replacement generation missing: %+v", plan.Generation)
	}
	if plan.Operation.Kind != OperationUpdateNetwork || plan.Operation.Generation != 5 {
		t.Fatalf("unexpected operation: %+v", plan.Operation)
	}
}

func TestPlanNetworkPolicyRejectsInactiveRuntime(t *testing.T) {
	now := time.Date(2026, 8, 28, 3, 4, 5, 0, time.UTC)
	runtime := Runtime{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test", NetworkMode: NetworkRestricted,
		DesiredState: DesiredStopped, DesiredGeneration: 4, NetworkPolicyEpoch: 2,
	}

	_, err := PlanNetworkPolicy(runtime, nil, NetworkPolicyCommand{
		AgentID: "agent-1", NetworkMode: NetworkUnrestricted,
		IdempotencyKey: "network-1", OperationID: "operation-network", Now: now,
	})
	if err == nil {
		t.Fatal("inactive Runtime accepted network policy update")
	}
}
