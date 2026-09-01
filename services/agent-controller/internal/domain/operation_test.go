package domain

import (
	"testing"
	"time"
)

func TestLifecycleOperationAdvancesOnlyInPlanOrder(t *testing.T) {
	t.Parallel()

	operation, err := NewLifecycleOperation(NewLifecycleOperationInput{
		RequestID:               "request-1",
		RequestFingerprint:      "fingerprint-1",
		AgentID:                 "agent-1",
		Kind:                    OperationRebuild,
		SourceSpecRevision:      "spec-1",
		SourceExecutionRevision: "execution-1",
		SourceRuntimeRevision:   "runtime-1",
		TargetSpecRevision:      "spec-2",
		InitialTraceParent:      "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
		Now:                     time.Unix(1, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("create operation: %v", err)
	}
	if operation.Phase() != PhaseDrain {
		t.Fatalf("initial phase = %s, want %s", operation.Phase(), PhaseDrain)
	}
	if operation.ChildRequestID() == "" {
		t.Fatal("current phase has no durable child request ID")
	}
	firstChild := operation.ChildRequestID()

	if err := operation.ApplyPhaseSuccess(PhaseRuntimeUpdate, time.Unix(2, 0).UTC()); err == nil {
		t.Fatal("operation skipped phases")
	}
	if operation.Phase() != PhaseDrain || operation.ChildRequestID() != firstChild {
		t.Fatal("rejected phase transition mutated operation")
	}

	plan, err := OperationPlan(OperationRebuild)
	if err != nil {
		t.Fatalf("operation plan: %v", err)
	}
	for index, phase := range plan {
		previousChild := operation.ChildRequestID()
		if err := operation.ApplyPhaseSuccess(phase, time.Unix(int64(index+2), 0).UTC()); err != nil {
			t.Fatalf("advance %s: %v", phase, err)
		}
		if index < len(plan)-1 && operation.ChildRequestID() == previousChild {
			t.Fatalf("phase %s did not advance child request identity", phase)
		}
	}
	if operation.State() != OperationCompleted || operation.Phase() != PhaseCompleted {
		t.Fatalf("operation ended as %s/%s", operation.State(), operation.Phase())
	}
}

func TestLifecycleOperationRetryKeepsSamePhaseAndChildIdentity(t *testing.T) {
	t.Parallel()

	operation, err := NewLifecycleOperation(NewLifecycleOperationInput{
		RequestID:          "request-1",
		RequestFingerprint: "fingerprint-1",
		AgentID:            "agent-1",
		Kind:               OperationCreate,
		TargetSpecRevision: "spec-1",
		Now:                time.Unix(1, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("create operation: %v", err)
	}
	childRequestID := operation.ChildRequestID()
	if err := operation.Fail("dependency_unavailable", "runtime controller unavailable", true, time.Unix(2, 0).UTC()); err != nil {
		t.Fatalf("fail operation: %v", err)
	}
	if err := operation.Retry(time.Unix(3, 0).UTC()); err != nil {
		t.Fatalf("retry operation: %v", err)
	}
	if operation.Phase() != PhaseNetworkEnsure || operation.ChildRequestID() != childRequestID {
		t.Fatal("retry changed phase or child request identity")
	}
}

func TestLifecycleOperationRejectsIncompleteOrContradictoryPreconditions(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name  string
		input NewLifecycleOperationInput
	}{
		{
			name:  "create with source",
			input: operationInput(OperationCreate, "spec-old", "", false, "spec-new"),
		},
		{
			name:  "rebuild without source spec",
			input: operationInput(OperationRebuild, "", "runtime-old", false, "spec-new"),
		},
		{
			name:  "disable with target",
			input: operationInput(OperationDisable, "spec-old", "runtime-old", false, "spec-new"),
		},
		{
			name:  "enable without target",
			input: operationInput(OperationEnable, "spec-old", "runtime-old", false, ""),
		},
		{
			name:  "delete with ambiguous Runtime",
			input: operationInput(OperationDelete, "spec-old", "runtime-old", true, ""),
		},
	}
	for _, testCase := range tests {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			if _, err := NewLifecycleOperation(testCase.input); err == nil {
				t.Fatal("invalid lifecycle preconditions were accepted")
			}
		})
	}
}

func TestDeleteWithoutRuntimeSkipsRuntimeDeletePhase(t *testing.T) {
	t.Parallel()

	operation, err := NewLifecycleOperation(operationInput(OperationDelete, "", "", true, ""))
	if err != nil {
		t.Fatalf("create delete operation: %v", err)
	}
	for operation.State() == OperationRunning {
		phase := operation.Phase()
		if phase == PhaseRuntimeDelete {
			t.Fatal("delete operation attempted to delete a Runtime already proven absent")
		}
		if err := operation.ApplyPhaseSuccess(phase, time.Unix(2, 0).UTC()); err != nil {
			t.Fatalf("advance %s: %v", phase, err)
		}
	}
}

func TestEnableRestoresNetworkAfterRuntimeIsReady(t *testing.T) {
	t.Parallel()

	plan, err := OperationPlan(OperationEnable)
	if err != nil {
		t.Fatalf("enable operation plan: %v", err)
	}
	want := []OperationPhase{
		PhaseNetworkEnsure,
		PhaseRuntimeEnable,
		PhaseNetworkRestore,
		PhasePublish,
	}
	if len(plan) != len(want) {
		t.Fatalf("enable plan = %v, want %v", plan, want)
	}
	for index := range want {
		if plan[index] != want[index] {
			t.Fatalf("enable plan = %v, want %v", plan, want)
		}
	}
}

func operationInput(
	kind OperationKind,
	sourceSpec string,
	sourceRuntime string,
	sourceRuntimeAbsent bool,
	targetSpec string,
) NewLifecycleOperationInput {
	return NewLifecycleOperationInput{
		RequestID: "request-1", RequestFingerprint: "fingerprint-1", AgentID: "agent-1",
		Kind: kind, SourceSpecRevision: sourceSpec, SourceRuntimeRevision: sourceRuntime,
		SourceExecutionRevision: func() string {
			if sourceSpec == "" {
				return ""
			}
			return "execution-old"
		}(),
		SourceRuntimeAbsent: sourceRuntimeAbsent, TargetSpecRevision: targetSpec,
		Now: time.Unix(1, 0).UTC(),
	}
}
