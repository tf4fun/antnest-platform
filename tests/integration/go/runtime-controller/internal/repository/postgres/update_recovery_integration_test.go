package postgres

import (
	"errors"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestRepositoryUpdateRecoveryKeepsTargetAndAtomicCompletion(t *testing.T) {
	for _, state := range []deployment.OperationState{deployment.OperationRunning, deployment.OperationUnknown} {
		t.Run(string(state), func(t *testing.T) { testRepositoryUpdateRecovery(t, state) })
	}
}

func testRepositoryUpdateRecovery(t *testing.T, state deployment.OperationState) {
	t.Helper()
	repository, database, ctx := integrationRepository(t)
	now := time.Now().UTC()
	source := integrationOperation("recovery-init", deployment.OperationInitializeRuntime, now)
	source.Transition = deployment.LifecycleInitializing
	source, _, err := repository.BeginTransition(ctx, source)
	if err != nil {
		t.Fatal(err)
	}
	source.State, source.Effect = deployment.OperationCompleted, deployment.EffectCompleted
	source.Inspection = integrationEnvironment(source, deployment.LifecycleProvisioned, now)
	if _, err := repository.CompleteOperation(ctx, source, nil); err != nil {
		t.Fatal(err)
	}

	target := integrationOperation("recovery-update", deployment.OperationUpdateRuntime, now.Add(time.Second))
	target.SourceState, target.SourceRevision = deployment.LifecycleProvisioned, source.RuntimeRevision
	target.ExpectedRevision = source.RuntimeRevision
	target.SourceGeneration, target.SourceSpecDigest = source.Generation, source.SpecDigest
	target.Generation, target.Transition = source.Generation+1, deployment.LifecycleUpdating
	target.SpecDigest = integrationSpecDigest
	target, _, err = repository.BeginTransition(ctx, target)
	if err != nil {
		t.Fatal(err)
	}
	if state == deployment.OperationUnknown {
		target.State, target.Effect = deployment.OperationUnknown, deployment.EffectCompleted
		target.ErrorCode = "platform_unavailable"
		target.Inspection = integrationEnvironment(target, deployment.LifecycleUnknown, now)
		if _, err := repository.CompleteOperation(ctx, target, nil); err != nil {
			t.Fatal(err)
		}
	}
	loaded, err := repository.GetOperation(ctx, target.RequestID)
	if err != nil || loaded.State != state {
		t.Fatalf("nonterminal journal: %+v %v", loaded, err)
	}
	head, err := repository.GetEnvironment(ctx, target.AgentID)
	if err != nil || head.OperationID != target.RequestID || head.RuntimeRevision != target.RuntimeRevision {
		t.Fatalf("lost target ownership: %+v %v", head, err)
	}
	recovered, replay, err := repository.BeginTransition(ctx, loaded)
	if err != nil || !replay || recovered.Attempt != target.Attempt+1 || recovered.Generation != target.Generation || recovered.SpecDigest != target.SpecDigest || recovered.SourceRevision != source.RuntimeRevision || recovered.RuntimeRevision != target.RuntimeRevision {
		t.Fatalf("resume altered source or target identity: %+v %v", recovered, err)
	}
	claim, err := repository.GenerationClaim(ctx, recovered.RuntimeKey())
	if err != nil || claim.RuntimeRevision != target.RuntimeRevision || claim.SpecDigest != target.SpecDigest {
		t.Fatalf("target claim changed: %+v %v", claim, err)
	}
	stale := target
	stale.State, stale.Effect = deployment.OperationFailed, deployment.EffectNotStarted
	stale.ErrorCode = "runtime_drift"
	if _, err := repository.CompleteOperation(ctx, stale, nil); !errors.Is(err, repositoryport.ErrOperationFinalized) {
		t.Fatalf("stale attempt could restore source: %v", err)
	}
	recovered.State, recovered.Effect = deployment.OperationCompleted, deployment.EffectCompleted
	recovered.ErrorCode, recovered.ErrorDetail = "", ""
	recovered.Inspection = integrationEnvironment(recovered, deployment.LifecycleProvisioned, now)
	event := deployment.Observation{AgentID: target.AgentID, RuntimeRevision: target.RuntimeRevision, Kind: deployment.ObservationUpdated, Source: "lifecycle_operation", ObservedAt: now}
	if _, err := repository.CompleteOperation(ctx, recovered, &event); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.CompleteOperation(ctx, recovered, &event); !errors.Is(err, repositoryport.ErrOperationFinalized) {
		t.Fatalf("duplicate completion not fenced: %v", err)
	}
	head, err = repository.GetEnvironment(ctx, target.AgentID)
	if err != nil || head.RuntimeRevision != target.RuntimeRevision || head.LifecycleState != deployment.LifecycleProvisioned || head.OperationID != "" {
		t.Fatalf("target publication not committed: %+v %v", head, err)
	}
	var claims, events int
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.generation_claims WHERE agent_id=$1`, target.AgentID).Scan(&claims); err != nil {
		t.Fatal(err)
	}
	if err := database.QueryRowContext(ctx, `SELECT count(*) FROM runtime_controller.observations WHERE agent_id=$1`, target.AgentID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if claims != 2 || events != 1 {
		t.Fatalf("replay duplicated claims/events: %d/%d", claims, events)
	}
}
