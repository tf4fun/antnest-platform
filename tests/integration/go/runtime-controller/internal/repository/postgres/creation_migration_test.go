package postgres

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRepositoryUpgradeSeparatesReadinessWithoutLosingHistory(t *testing.T) {
	for _, state := range []deployment.OperationState{deployment.OperationCompleted, deployment.OperationRunning, deployment.OperationUnknown, deployment.OperationFailed} {
		t.Run(string(state), func(t *testing.T) {
			testCreationUpgrade(t, state)
		})
	}
}

func testCreationUpgrade(t *testing.T, state deployment.OperationState) {
	t.Helper()
	repository, database, ctx := integrationRepository(t)
	installCreationPredecessor(t, ctx, database)
	now := time.Now().UTC()
	initial := integrationOperation("old-init", deployment.OperationInitializeRuntime, now)
	initial.Transition = deployment.LifecycleInitializing
	initial, _, err := repository.BeginTransition(ctx, initial)
	if err != nil {
		t.Fatal(err)
	}
	initial.State, initial.Effect = deployment.OperationCompleted, deployment.EffectCompleted
	initial.Inspection = integrationEnvironment(initial, "ready", now)
	initial.Inspection.RuntimeExecutionID = "old-execution"
	if _, err := repository.CompleteOperation(ctx, initial, nil); err != nil {
		t.Fatal(err)
	}
	update := integrationOperation("old-update", deployment.OperationUpdateRuntime, now)
	update.SourceState, update.SourceRevision, update.ExpectedRevision = "ready", initial.RuntimeRevision, initial.RuntimeRevision
	update.SourceGeneration, update.SourceSpecDigest = initial.Generation, initial.SpecDigest
	update.Generation, update.Transition = initial.Generation+1, deployment.LifecycleUpdating
	update, _, err = repository.BeginTransition(ctx, update)
	if err != nil {
		t.Fatal(err)
	}
	update.State = state
	if state == deployment.OperationCompleted {
		update.Effect = deployment.EffectCompleted
		update.Inspection = integrationEnvironment(update, "ready", now)
	}
	if state == deployment.OperationFailed {
		update.Effect, update.ErrorCode = deployment.EffectCompleted, "runtime_not_ready"
		update.Inspection = integrationEnvironment(update, deployment.LifecycleFailed, now)
	}
	if state != deployment.OperationRunning {
		if _, err := repository.CompleteOperation(ctx, update, nil); err != nil {
			t.Fatal(err)
		}
	}
	before, err := repository.GetEnvironment(ctx, initial.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Migrate(ctx, database); err != nil {
			t.Fatal(err)
		}
	}
	completed, err := repository.GetOperation(ctx, initial.RequestID)
	if err != nil || completed.Inspection.LifecycleState != deployment.LifecycleProvisioned || completed.Inspection.RuntimeExecutionID != "old-execution" {
		t.Fatalf("completed history lost on upgrade: %+v %v", completed, err)
	}
	resumed, err := repository.GetOperation(ctx, update.RequestID)
	if err != nil || resumed.SourceState != deployment.LifecycleProvisioned || resumed.State != state || resumed.Effect != update.Effect || resumed.ErrorCode != update.ErrorCode {
		t.Fatalf("recovery/history changed on upgrade: %+v %v", resumed, err)
	}
	after, err := repository.GetEnvironment(ctx, initial.AgentID)
	if before.LifecycleState == "ready" {
		before.LifecycleState = deployment.LifecycleProvisioned
	}
	if err != nil || after.LifecycleState != before.LifecycleState || after.OperationID != before.OperationID || after.RuntimeRevision != before.RuntimeRevision {
		t.Fatalf("ownership changed on upgrade: before=%+v after=%+v err=%v", before, after, err)
	}
}

func installCreationPredecessor(t *testing.T, ctx context.Context, database *sql.DB) {
	t.Helper()
	if _, err := database.ExecContext(ctx, `DROP SCHEMA runtime_controller CASCADE`); err != nil {
		t.Fatal(err)
	}
	if _, err := database.ExecContext(ctx, bootstrapSQL); err != nil {
		t.Fatal(err)
	}
	for _, migration := range schemaMigrations[:5] {
		if _, err := database.ExecContext(ctx, migration.sql); err != nil {
			t.Fatal(err)
		}
		if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.schema_migrations(version, name, checksum) VALUES ($1,$2,$3)`, migration.version, migration.name, migration.checksum); err != nil {
			t.Fatal(err)
		}
	}
}
