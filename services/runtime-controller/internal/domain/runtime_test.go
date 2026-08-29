package domain

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestPlanPrepareCreatesFirstGeneration(t *testing.T) {
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)

	plan, err := PlanPrepare(nil, nil, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:test",
		NetworkMode:    NetworkRestricted,
		IdempotencyKey: "prepare-1",
		Now:            now,
	})
	if err != nil {
		t.Fatalf("plan prepare: %v", err)
	}
	if plan.Runtime.AgentID != "agent-1" || plan.Runtime.DesiredGeneration != 1 {
		t.Fatalf("unexpected runtime: %+v", plan.Runtime)
	}
	if plan.Runtime.Status != RuntimePending || plan.Operation.Status != OperationPending {
		t.Fatalf("new prepare must remain pending: runtime=%s operation=%s", plan.Runtime.Status, plan.Operation.Status)
	}
	if plan.Operation.Generation != 1 || plan.Operation.IdempotencyKey != "prepare-1" {
		t.Fatalf("unexpected operation: %+v", plan.Operation)
	}
	if plan.Generation == nil || plan.Generation.Number != 1 || plan.Generation.Status != GenerationPending {
		t.Fatalf("first prepare did not create generation: %+v", plan.Generation)
	}
}

func TestPlanPrepareRejectsOversizedIdempotencyKey(t *testing.T) {
	_, err := PlanPrepare(nil, nil, PrepareCommand{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test", NetworkMode: NetworkRestricted,
		IdempotencyKey: strings.Repeat("界", MaxIdempotencyKeyCharacters+1), Now: time.Now().UTC(),
	})
	if err == nil {
		t.Fatal("oversized idempotency key was accepted")
	}
}

func TestValidateAgentIDMatchesPublicContract(t *testing.T) {
	for _, value := range []string{"agent-1", "Agent.example_2"} {
		if err := ValidateAgentID(value); err != nil {
			t.Fatalf("valid agent id %q: %v", value, err)
		}
	}
	for _, value := range []string{"", "agent/1", "agent 1", strings.Repeat("a", MaxAgentIDCharacters+1)} {
		if err := ValidateAgentID(value); err == nil {
			t.Fatalf("invalid agent id %q was accepted", value)
		}
	}
}

func TestPlanPrepareReplaysTheOriginalOperation(t *testing.T) {
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	first, err := PlanPrepare(nil, nil, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:test",
		NetworkMode:    NetworkRestricted,
		IdempotencyKey: "prepare-1",
		Now:            now,
	})
	if err != nil {
		t.Fatalf("first prepare: %v", err)
	}

	replay, err := PlanPrepare(&first.Runtime, &first.Operation, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:test",
		NetworkMode:    NetworkRestricted,
		IdempotencyKey: "prepare-1",
		Now:            now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("replay prepare: %v", err)
	}
	if !replay.Replayed || replay.Operation != first.Operation || replay.Runtime != first.Runtime {
		t.Fatalf("replay changed the original plan: first=%+v replay=%+v", first, replay)
	}
}

func TestPlanPrepareRejectsIdempotencyConflict(t *testing.T) {
	now := time.Date(2026, 8, 28, 1, 2, 3, 0, time.UTC)
	first, err := PlanPrepare(nil, nil, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:test",
		NetworkMode:    NetworkRestricted,
		IdempotencyKey: "prepare-1",
		Now:            now,
	})
	if err != nil {
		t.Fatalf("first prepare: %v", err)
	}

	_, err = PlanPrepare(&first.Runtime, &first.Operation, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:other",
		NetworkMode:    NetworkRestricted,
		IdempotencyKey: "prepare-1",
		Now:            now.Add(time.Minute),
	})
	if !errors.Is(err, ErrIdempotencyConflict) {
		t.Fatalf("expected idempotency conflict, got %v", err)
	}
}

func TestPlanPrepareAdvancesGenerationForChangedSpec(t *testing.T) {
	first, err := PlanPrepare(nil, nil, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:v1",
		NetworkMode:    NetworkRestricted,
		IdempotencyKey: "prepare-1",
		Now:            time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("first prepare: %v", err)
	}

	next, err := PlanPrepare(&first.Runtime, nil, PrepareCommand{
		AgentID:        "agent-1",
		ImageRef:       "antnest/runtime:v2",
		NetworkMode:    NetworkUnrestricted,
		IdempotencyKey: "prepare-2",
		Now:            time.Now().UTC(),
	})
	if err != nil {
		t.Fatalf("next prepare: %v", err)
	}
	if next.Runtime.DesiredGeneration != 2 || next.Operation.Generation != 2 {
		t.Fatalf("changed spec did not advance generation: %+v", next)
	}
	if next.Generation == nil || next.Generation.Number != 2 || next.Generation.ImageRef != "antnest/runtime:v2" {
		t.Fatalf("changed spec did not create generation: %+v", next.Generation)
	}
}

func TestPlanPrepareCreatesNewGenerationAfterRetire(t *testing.T) {
	now := time.Date(2026, 8, 28, 5, 6, 7, 0, time.UTC)
	current := Runtime{
		AgentID: "agent-1", ImageRef: "antnest/runtime:v1", NetworkMode: NetworkRestricted,
		DesiredState: DesiredRetired, Status: RuntimeRetired, DesiredGeneration: 2,
		SpecDigest:      prepareDigest(PrepareCommand{ImageRef: "antnest/runtime:v1", NetworkMode: NetworkRestricted}),
		ResourceVersion: 4, CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Minute),
	}

	plan, err := PlanPrepare(&current, nil, PrepareCommand{
		AgentID: "agent-1", ImageRef: "antnest/runtime:v1", NetworkMode: NetworkRestricted,
		IdempotencyKey: "prepare-again", OperationID: "operation-3", Now: now,
	})
	if err != nil {
		t.Fatalf("plan prepare: %v", err)
	}
	if plan.Runtime.DesiredGeneration != 3 || plan.Generation == nil || plan.Generation.Number != 3 {
		t.Fatalf("retired runtime reused dead generation: %+v", plan)
	}
}

func TestPlanPrepareRetriesFailedRuntimeWithNewGeneration(t *testing.T) {
	now := time.Date(2026, 8, 28, 5, 6, 7, 0, time.UTC)
	current := Runtime{
		AgentID: "agent-1", ImageRef: "antnest/runtime:v1", NetworkMode: NetworkRestricted,
		DesiredState: DesiredActive, Status: RuntimeFailed, DesiredGeneration: 2,
		SpecDigest:      prepareDigest(PrepareCommand{ImageRef: "antnest/runtime:v1", NetworkMode: NetworkRestricted}),
		ResourceVersion: 4, CreatedAt: now.Add(-time.Hour), UpdatedAt: now.Add(-time.Minute),
		FailureCode: "docker_unavailable", FailureDetail: "Docker was not ready",
	}

	plan, err := PlanPrepare(&current, nil, PrepareCommand{
		AgentID: "agent-1", ImageRef: "antnest/runtime:v1", NetworkMode: NetworkRestricted,
		IdempotencyKey: "prepare-retry", OperationID: "operation-3", Now: now,
	})
	if err != nil {
		t.Fatalf("plan prepare retry: %v", err)
	}
	if plan.Runtime.DesiredGeneration != 3 || plan.Runtime.Status != RuntimePending ||
		plan.Runtime.FailureCode != "" || plan.Generation == nil || plan.Generation.Number != 3 {
		t.Fatalf("failed runtime reused terminal generation: %+v", plan)
	}
}

func TestPlanGenerationConnectedUpdatesRuntimeAndGenerationTogether(t *testing.T) {
	now := time.Date(2026, 8, 28, 5, 6, 7, 0, time.UTC)
	runtime := Runtime{
		AgentID: "agent-1", DesiredState: DesiredActive, Status: RuntimeStarting,
		DesiredGeneration: 2, NetworkPolicyEpoch: 1, ResourceVersion: 3,
	}
	generation := RuntimeGeneration{
		AgentID: "agent-1", Number: 2, Status: GenerationStarting,
		ContainerID: "container-1", RuntimeInstanceID: "instance-1", ResourceVersion: 2,
	}

	nextRuntime, nextGeneration, err := PlanGenerationConnected(runtime, generation, RuntimeConnected{
		Generation: 2, ConnectionEpoch: 1, RuntimeInstanceID: "instance-1", ConnectedAt: now,
	})
	if err != nil {
		t.Fatalf("plan connected: %v", err)
	}
	if nextRuntime.Status != RuntimeStarting || nextRuntime.ObservedGeneration != 2 {
		t.Fatalf("runtime connection was not observed: %+v", nextRuntime)
	}
	if nextGeneration.Status != GenerationStarting || nextGeneration.RuntimeInstanceID != "instance-1" {
		t.Fatalf("generation connection was not observed: %+v", nextGeneration)
	}
	healthyRuntime, healthyGeneration, err := PlanGenerationHealthy(
		nextRuntime, nextGeneration, RuntimeHealthy{
			Generation: 2, ConnectionEpoch: 1, PolicyEpoch: 1, ObservedAt: now.Add(time.Second),
		},
	)
	if err != nil {
		t.Fatalf("plan healthy: %v", err)
	}
	if healthyRuntime.Status != RuntimeReady || healthyGeneration.Status != GenerationReady {
		t.Fatalf("healthy runtime is not ready: runtime=%+v generation=%+v", healthyRuntime, healthyGeneration)
	}
}

func TestPlanRuntimeConnectedFencesStaleGeneration(t *testing.T) {
	current := Runtime{
		AgentID:             "agent-1",
		DesiredGeneration:   2,
		ObservedGeneration:  1,
		Status:              RuntimeStarting,
		DesiredState:        DesiredActive,
		NetworkMode:         NetworkRestricted,
		ResourceVersion:     4,
		NetworkPolicyEpoch:  1,
		ObservedPolicyEpoch: 0,
	}

	_, err := PlanRuntimeConnected(current, RuntimeConnected{
		Generation:      1,
		ConnectionEpoch: 2,
		ConnectedAt:     time.Now().UTC(),
	})
	if !errors.Is(err, ErrGenerationFenced) {
		t.Fatalf("expected generation fence, got %v", err)
	}
}
