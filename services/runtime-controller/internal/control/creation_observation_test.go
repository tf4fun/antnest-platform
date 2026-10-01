package control

import (
	"context"
	"reflect"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestCreationCompletesWithoutRuntimeReadiness(t *testing.T) {
	t.Parallel()
	store := newLifecycleRepository()
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, store, platform)
	verifier := &countingUnavailableVerifier{}
	service.verifier = verifier
	created, err := service.InitializeRuntime(context.Background(), "init-unready", "agent-1", lifecycleConfiguration())
	if err != nil || created.State != deployment.OperationCompleted || created.Effect != deployment.EffectCompleted {
		t.Fatalf("creation waited for readiness: %+v %v", created, err)
	}
	if verifier.calls != 0 || created.Inspection == nil || created.Inspection.LifecycleState != "provisioned" ||
		created.Inspection.Health != deployment.HealthUnknown || created.Inspection.RuntimeExecutionID != "" {
		t.Fatalf("creation asserted runtime readiness: %+v calls=%d", created, verifier.calls)
	}
	environment, err := store.GetEnvironment(context.Background(), "agent-1")
	if err != nil || environment.OperationID != "" {
		t.Fatalf("completed creation retained mutation ownership: %+v %v", environment, err)
	}
	current := platform.containers["agent-1"]
	current.Health = deployment.HealthStarting
	platform.containers["agent-1"] = current
	inspection, err := service.InspectRuntime(context.Background(), "agent-1")
	if err != nil || inspection.Health != deployment.HealthStarting {
		t.Fatalf("independent starting inspection: %+v %v", inspection, err)
	}
	replayed, err := service.InitializeRuntime(context.Background(), "init-unready", "agent-1", lifecycleConfiguration())
	if err != nil || replayed.State != deployment.OperationCompleted || replayed.Inspection.Health != deployment.HealthUnknown || platform.createCalls != 1 {
		t.Fatalf("observation changed the command result: %+v %v", replayed, err)
	}
	updated, err := service.UpdateRuntime(context.Background(), "update-unready", "agent-1", created.RuntimeRevision, lifecycleConfiguration())
	if err != nil || updated.State != deployment.OperationCompleted || verifier.calls != 0 {
		t.Fatalf("update waited for readiness: %+v %v calls=%d", updated, err, verifier.calls)
	}
	assertUnverifiedCompletion(t, updated)
	current = platform.containers["agent-1"]
	current.Health = deployment.HealthUnhealthy
	platform.containers["agent-1"] = current
	inventory, err := service.ListRuntimes(context.Background())
	if err != nil || len(inventory) != 1 || inventory[0].Health != deployment.HealthUnhealthy {
		t.Fatalf("independent unhealthy inventory: %+v %v", inventory, err)
	}
	replayedUpdate, err := service.UpdateRuntime(context.Background(), "update-unready", "agent-1", created.RuntimeRevision, lifecycleConfiguration())
	if err != nil || !reflect.DeepEqual(replayedUpdate.Inspection, updated.Inspection) {
		t.Fatalf("health changed the update completion snapshot: %+v %v", replayedUpdate, err)
	}
	disabled, err := service.DisableRuntime(context.Background(), "disable-unready", "agent-1", updated.RuntimeRevision)
	if err != nil || disabled.State != deployment.OperationCompleted {
		t.Fatalf("cannot disable unready runtime: %+v %v", disabled, err)
	}
	enabled, err := service.EnableRuntime(context.Background(), "enable-unready", "agent-1", disabled.RuntimeRevision, lifecycleConfiguration())
	if err != nil || enabled.State != deployment.OperationCompleted || verifier.calls != 0 {
		t.Fatalf("enable waited for readiness: %+v %v calls=%d", enabled, err, verifier.calls)
	}
	assertUnverifiedCompletion(t, enabled)
	current = platform.containers["agent-1"]
	current.Health = deployment.HealthStarting
	platform.containers["agent-1"] = current
	replayedEnable, err := service.EnableRuntime(context.Background(), "enable-unready", "agent-1", disabled.RuntimeRevision, lifecycleConfiguration())
	if err != nil || !reflect.DeepEqual(replayedEnable.Inspection, enabled.Inspection) {
		t.Fatalf("health changed the enable completion snapshot: %+v %v", replayedEnable, err)
	}
	deleted, err := service.DeleteRuntime(context.Background(), "delete-unready", "agent-1", enabled.RuntimeRevision)
	if err != nil || deleted.State != deployment.OperationCompleted || verifier.calls != 0 {
		t.Fatalf("cannot delete starting runtime: %+v %v calls=%d", deleted, err, verifier.calls)
	}
}

func assertUnverifiedCompletion(t *testing.T, operation deployment.Operation) {
	t.Helper()
	if operation.Inspection == nil || operation.Inspection.LifecycleState != deployment.LifecycleProvisioned ||
		operation.Inspection.Health != deployment.HealthUnknown || operation.Inspection.RuntimeExecutionID != "" {
		t.Fatalf("completion asserted readiness: %+v", operation)
	}
}

type countingUnavailableVerifier struct{ calls int }

func (v *countingUnavailableVerifier) Verify(ctx context.Context, value deployment.Inspection) (deployment.Inspection, error) {
	v.calls++
	return (unavailableVerifier{}).Verify(ctx, value)
}
