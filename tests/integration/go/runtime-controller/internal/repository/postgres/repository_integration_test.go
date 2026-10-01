package postgres

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	repositoryport "github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestRepositoryFailedInitializeRetainsDeleteFence(t *testing.T) {
	for _, effect := range []deployment.EffectState{deployment.EffectNotStarted, deployment.EffectCompleted} {
		t.Run(string(effect), func(t *testing.T) {
			testFailedInitializeDeleteFence(t, effect)
		})
	}
}

func testFailedInitializeDeleteFence(t *testing.T, effect deployment.EffectState) {
	t.Helper()
	repository, database, ctx := integrationRepository(t)
	now := time.Now().UTC()
	initialize := integrationOperation("failed-init", deployment.OperationInitializeRuntime, now)
	initialize.ImageReference = "antnest/runtime:latest"
	initialize.ImageID = integrationSpecDigest
	initialize.Transition = deployment.LifecycleInitializing
	started, _, err := repository.BeginTransition(ctx, initialize)
	if err != nil {
		t.Fatal(err)
	}
	started.State = deployment.OperationFailed
	started.Effect = effect
	started.ErrorCode = "platform_unavailable"
	started.Inspection = integrationEnvironment(started, deployment.LifecycleFailed, now)
	if _, err := repository.CompleteOperation(ctx, started, nil); err != nil {
		t.Fatal(err)
	}
	environment, err := repository.GetEnvironment(ctx, started.AgentID)
	if err != nil || environment.RuntimeRevision != started.RuntimeRevision || environment.LifecycleState != deployment.LifecycleFailed || environment.OperationID != "" {
		t.Fatalf("failed head was not retained/released: %+v %v", environment, err)
	}
	if environment.Generation != started.Generation || environment.SpecDigest != started.SpecDigest {
		t.Fatalf("failed head changed physical identity: %+v", environment)
	}
	claim, err := repository.GenerationClaim(ctx, started.RuntimeKey())
	if err != nil || claim.RuntimeRevision != environment.RuntimeRevision || claim.SpecDigest != environment.SpecDigest {
		t.Fatalf("failed head disagrees with generation claim: %+v %v", claim, err)
	}
	var claims int
	if err := database.QueryRowContext(ctx, `SELECT COUNT(*) FROM runtime_controller.generation_claims WHERE agent_id = $1`, started.AgentID).Scan(&claims); err != nil || claims != 1 {
		t.Fatalf("failed init claim count %d: %v", claims, err)
	}
	deleted := integrationOperation("delete-failed-init", deployment.OperationDeleteRuntime, now.Add(time.Second))
	deleted.SourceState = environment.LifecycleState
	deleted.SourceRevision = environment.RuntimeRevision
	deleted.ExpectedRevision = environment.RuntimeRevision
	deleted.SourceGeneration = environment.Generation
	deleted.Generation = environment.Generation
	deleted.SourceSpecDigest = environment.SpecDigest
	deleted.Transition = deployment.LifecycleDeleting
	deleted, _, err = repository.BeginTransition(ctx, deleted)
	if err != nil {
		t.Fatalf("failed Environment not deletable: %v", err)
	}
	deleted.State = deployment.OperationCompleted
	deleted.Effect = deployment.EffectCompleted
	deleted.Inspection = integrationEnvironment(deleted, deployment.LifecycleDeleted, now.Add(2*time.Second))
	if _, err := repository.CompleteOperation(ctx, deleted, nil); err != nil {
		t.Fatal(err)
	}
	tombstone, err := repository.GetEnvironment(ctx, started.AgentID)
	if err != nil || tombstone.LifecycleState != deployment.LifecycleDeleted || tombstone.OperationID != "" {
		t.Fatalf("delete tombstone: %+v %v", tombstone, err)
	}
	retained, err := repository.GetOperation(ctx, initialize.RequestID)
	if err != nil || retained.ImageReference != initialize.ImageReference || retained.ImageID != initialize.ImageID {
		t.Fatalf("image audit lost after deletion: %+v %v", retained, err)
	}
}

func TestRepositoryLifecycleRoundTrip(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	now := time.Date(2026, 8, 30, 0, 0, 0, 0, time.UTC)
	initialize := integrationOperation("request-init", deployment.OperationInitializeRuntime, now)
	initialize.ImageReference = "antnest/runtime:latest"
	initialize.ImageID = integrationSpecDigest
	initialize.Transition = deployment.LifecycleInitializing

	started, replay, err := repository.BeginTransition(ctx, initialize)
	if err != nil || replay || started.Attempt != 1 {
		t.Fatalf("begin initialization: operation=%+v replay=%t err=%v", started, replay, err)
	}
	persisted, err := repository.GetOperation(ctx, initialize.RequestID)
	if err != nil || persisted.ImageReference != initialize.ImageReference || persisted.ImageID != initialize.ImageID {
		t.Fatalf("image identity not persisted before execution: %+v %v", persisted, err)
	}
	transitioning, err := repository.GetEnvironment(ctx, initialize.AgentID)
	if err != nil || transitioning.LifecycleState != deployment.LifecycleInitializing ||
		transitioning.OperationID != initialize.RequestID {
		t.Fatalf("initializing environment: %+v err=%v", transitioning, err)
	}
	replayed, replay, err := repository.BeginTransition(ctx, initialize)
	if err != nil || !replay || replayed.Attempt != 2 {
		t.Fatalf("replay initialization: operation=%+v replay=%t err=%v", replayed, replay, err)
	}

	replayed.State = deployment.OperationCompleted
	replayed.Effect = deployment.EffectCompleted
	replayed.Inspection = integrationEnvironment(replayed, deployment.LifecycleProvisioned, now.Add(time.Second))
	replayed.UpdatedAt = now.Add(time.Second)
	observation := deployment.Observation{
		AgentID: replayed.AgentID, RuntimeRevision: replayed.RuntimeRevision,
		Kind: deployment.ObservationInitialized, Source: "integration_test", ObservedAt: replayed.UpdatedAt,
	}
	storedObservation, err := repository.CompleteOperation(ctx, replayed, &observation)
	if err != nil || storedObservation == nil || storedObservation.Sequence != 1 {
		t.Fatalf("complete initialization: observation=%+v err=%v", storedObservation, err)
	}
	ready, err := repository.GetEnvironment(ctx, initialize.AgentID)
	if err != nil || ready.LifecycleState != deployment.LifecycleProvisioned || ready.OperationID != "" {
		t.Fatalf("ready environment: %+v err=%v", ready, err)
	}
	claim, err := repository.GenerationClaim(ctx, mustRuntimeKey(t, ready))
	if err != nil || claim.RuntimeRevision != ready.RuntimeRevision || claim.SpecDigest != ready.SpecDigest {
		t.Fatalf("generation claim: %+v err=%v", claim, err)
	}

	update := integrationOperation("request-update", deployment.OperationUpdateRuntime, now.Add(2*time.Second))
	update.ExpectedRevision = ready.RuntimeRevision
	update.SourceState = ready.LifecycleState
	update.SourceRevision = ready.RuntimeRevision
	update.SourceGeneration = ready.Generation
	update.SourceSpecDigest = ready.SpecDigest
	update.Transition = deployment.LifecycleUpdating
	update.Generation = ready.Generation + 1
	update.RuntimeRevision = deployment.RevisionFor(update.RequestID, update.RequestDigest)
	update.SpecDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if _, _, err := repository.BeginTransition(ctx, update); err != nil {
		t.Fatal(err)
	}
	stale := update
	stale.RequestID = "request-stale"
	stale.RequestDigest = "sha256:stale"
	stale.RuntimeRevision = deployment.RevisionFor(stale.RequestID, stale.RequestDigest)
	if _, _, err := repository.BeginTransition(ctx, stale); !errors.Is(err, repositoryport.ErrTransitionConflict) &&
		!errors.Is(err, repositoryport.ErrConcurrentMutation) {
		t.Fatalf("second transition error=%v", err)
	}
	update.State = deployment.OperationFailed
	update.Effect = deployment.EffectNotStarted
	update.ErrorCode = "platform_unavailable"
	update.UpdatedAt = now.Add(3 * time.Second)
	if _, err := repository.CompleteOperation(ctx, update, nil); err != nil {
		t.Fatal(err)
	}
	restored, err := repository.GetEnvironment(ctx, ready.AgentID)
	if err != nil || restored.RuntimeRevision != ready.RuntimeRevision || restored.Generation != ready.Generation {
		t.Fatalf("failed update did not restore source: %+v err=%v", restored, err)
	}

	window, err := repository.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 1 ||
		window.Observations[0].RuntimeRevision != ready.RuntimeRevision ||
		window.OldestSequence != 1 || window.LatestSequence != 1 {
		t.Fatalf("observations: %+v err=%v", window, err)
	}
	var environmentCount int
	if err := database.QueryRowContext(ctx,
		`SELECT count(*) FROM runtime_controller.runtime_environments`,
	).Scan(&environmentCount); err != nil || environmentCount != 1 {
		t.Fatalf("environment row count=%d err=%v", environmentCount, err)
	}
}

func TestAcceptedMaintenanceVerifiersSurviveRepositoryReplay(t *testing.T) {
	store, database, ctx := integrationRepository(t)
	operation := integrationOperation("maintenance-snapshot", deployment.OperationInitializeRuntime, time.Now().UTC())
	operation.ImageReference = "antnest/runtime:latest"
	operation.ImageID = integrationSpecDigest
	operation.Transition = deployment.LifecycleInitializing
	operation.MaintenanceVerifiers = &deployment.MaintenanceVerifiers{Keys: []deployment.MaintenanceVerifierKey{{
		KID: "current", Algorithm: "Ed25519",
		PublicKeyBase64URL: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
	}}}
	accepted, replay, err := store.BeginTransition(ctx, operation)
	if err != nil || replay || accepted.MaintenanceVerifiers == nil {
		t.Fatalf("accept operation: %+v replay=%t err=%v", accepted, replay, err)
	}
	var persisted []byte
	if err := database.QueryRowContext(ctx, `SELECT maintenance_verifiers FROM runtime_controller.operations WHERE request_id=$1`, operation.RequestID).Scan(&persisted); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(persisted), `"kid": "current"`) && !strings.Contains(string(persisted), `"kid":"current"`) {
		t.Fatalf("maintenance verifier snapshot missing from accepted operation: %s", persisted)
	}
	operation.MaintenanceVerifiers = &deployment.MaintenanceVerifiers{Keys: []deployment.MaintenanceVerifierKey{}}
	recovered, replay, err := store.BeginTransition(ctx, operation)
	if err != nil || !replay || recovered.MaintenanceVerifiers == nil ||
		len(recovered.MaintenanceVerifiers.Keys) != 1 || recovered.MaintenanceVerifiers.Keys[0].KID != "current" {
		t.Fatalf("replay did not retain accepted verifier: %+v replay=%t err=%v", recovered, replay, err)
	}
}

func TestRepositoryMigrationJournalAndReadinessProbe(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	if err := Migrate(ctx, database); err != nil {
		t.Fatalf("repeat migration: %v", err)
	}
	var migrationCount int
	if err := database.QueryRowContext(ctx,
		`SELECT count(*) FROM runtime_controller.schema_migrations`,
	).Scan(&migrationCount); err != nil || migrationCount != len(schemaMigrations) {
		t.Fatalf("migration count=%d err=%v", migrationCount, err)
	}
	if err := repository.ProbeObservationJournal(ctx); err != nil {
		t.Fatal(err)
	}
	var probeRows int
	if err := database.QueryRowContext(ctx,
		`SELECT count(*) FROM runtime_controller.observations WHERE source = 'readiness_probe'`,
	).Scan(&probeRows); err != nil || probeRows != 0 {
		t.Fatalf("probe rows=%d err=%v", probeRows, err)
	}
}

func TestRepositoryListExcludesDeletedEnvironmentButDirectReadRetainsTombstone(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	now := time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC)
	for _, fixture := range []struct {
		agentID string
		state   deployment.LifecycleState
	}{
		{agentID: "active-agent", state: deployment.LifecycleProvisioned},
		{agentID: "deleted-agent", state: deployment.LifecycleDeleted},
	} {
		if _, err := database.ExecContext(ctx, insertEnvironmentSQL,
			fixture.agentID, testRevision, fixture.state, uint64(1),
			integrationSpecDigest, nil, now,
		); err != nil {
			t.Fatal(err)
		}
	}

	values, err := repository.ListEnvironments(ctx)
	if err != nil || len(values) != 1 || values[0].AgentID != "active-agent" {
		t.Fatalf("active Runtime inventory = %+v err=%v", values, err)
	}
	deleted, err := repository.GetEnvironment(ctx, "deleted-agent")
	if err != nil || deleted.LifecycleState != deployment.LifecycleDeleted {
		t.Fatalf("deleted Runtime tombstone = %+v err=%v", deleted, err)
	}
}

func TestRepositoryObservationWindowReportsBoundsAfterRetentionPruning(t *testing.T) {
	repository, database, ctx := integrationRepository(t)
	old := time.Now().UTC().Add(-2 * time.Hour)
	if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations (
    agent_id, runtime_revision, generation, spec_digest, kind, source, observed_at, recorded_at
) VALUES ('', '', 0, '', 'reconciled', 'expired_fixture', $1, $1)`, old); err != nil {
		t.Fatal(err)
	}
	stored, err := repository.AppendObservation(ctx, deployment.Observation{
		Kind: deployment.ObservationReconciled, Source: "current_fixture", ObservedAt: time.Now().UTC(),
	})
	if err != nil {
		t.Fatal(err)
	}
	window, err := repository.ListObservations(ctx, 0, 10)
	if err != nil || len(window.Observations) != 1 ||
		window.OldestSequence != stored.Sequence || window.LatestSequence != stored.Sequence {
		t.Fatalf("retained observation window = %+v stored=%+v err=%v", window, stored, err)
	}
}

func TestRepositoryAgentMutationLockSerializesCalls(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	firstEntered := make(chan struct{})
	release := make(chan struct{})
	secondEntered := make(chan struct{})
	results := make(chan error, 2)
	go func() {
		results <- repository.WithAgentLock(ctx, "agent-lock-test", func(context.Context) error {
			close(firstEntered)
			<-release
			return nil
		})
	}()
	select {
	case <-firstEntered:
	case <-time.After(time.Second):
		t.Fatal("first lock was not acquired")
	}
	go func() {
		results <- repository.WithAgentLock(ctx, "agent-lock-test", func(context.Context) error {
			close(secondEntered)
			return nil
		})
	}()
	select {
	case <-secondEntered:
		t.Fatal("second mutation entered concurrently")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	for range 2 {
		select {
		case err := <-results:
			if err != nil {
				t.Fatal(err)
			}
		case <-time.After(time.Second):
			t.Fatal("locked mutation did not finish")
		}
	}
}

func TestRepositoryObservationNotificationAndLeadership(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	leadership, acquired, err := repository.TryAcquireObservationLeadership(ctx)
	if err != nil || !acquired {
		t.Fatalf("acquire observation leadership: acquired=%t err=%v", acquired, err)
	}
	if second, secondAcquired, secondErr := repository.TryAcquireObservationLeadership(ctx); secondErr != nil || secondAcquired || second != nil {
		t.Fatalf("second leader was admitted: lease=%v acquired=%t err=%v",
			second, secondAcquired, secondErr)
	}
	if ready, readyErr := repository.ObservationMonitorReady(ctx); readyErr != nil || ready {
		t.Fatalf("unannounced observation leader was ready: ready=%t err=%v", ready, readyErr)
	}
	if err := leadership.MarkObservationReady(ctx); err != nil {
		t.Fatalf("mark observation Watch ready: %v", err)
	}
	if ready, readyErr := repository.ObservationMonitorReady(ctx); readyErr != nil || !ready {
		t.Fatalf("active observation Watch was not visible: ready=%t err=%v", ready, readyErr)
	}
	if err := leadership.MarkObservationUnready(ctx); err != nil {
		t.Fatalf("mark observation Watch unready: %v", err)
	}
	if ready, readyErr := repository.ObservationMonitorReady(ctx); readyErr != nil || ready {
		t.Fatalf("stopped observation Watch remained ready: ready=%t err=%v", ready, readyErr)
	}
	if err := leadership.Release(ctx); err != nil {
		t.Fatalf("release observation leadership: %v", err)
	}

	listenerCtx, listenerCancel := context.WithCancel(ctx)
	listenerReady := make(chan struct{})
	notified := make(chan string, 2)
	listenerResult := make(chan error, 1)
	go func() {
		listenerResult <- repository.ListenObservationNotifications(
			listenerCtx,
			func() { close(listenerReady) },
			func(payload string) { notified <- payload },
		)
	}()
	select {
	case <-listenerReady:
	case <-time.After(time.Second):
		t.Fatal("observation listener did not become ready")
	}
	const probePayload = "readiness_probe:integration-test"
	if err := repository.ProbeObservationNotification(ctx, probePayload); err != nil {
		t.Fatal(err)
	}
	select {
	case payload := <-notified:
		if payload != probePayload {
			t.Fatalf("notification payload=%q want=%q", payload, probePayload)
		}
	case <-time.After(time.Second):
		t.Fatal("notification probe did not reach the listener")
	}
	if _, err := repository.AppendObservation(ctx, deployment.Observation{
		Kind: deployment.ObservationReconciled, Source: "integration_test", ObservedAt: time.Now().UTC(),
	}); err != nil {
		t.Fatal(err)
	}
	select {
	case payload := <-notified:
		if payload != "" {
			t.Fatalf("journal notification payload=%q want empty", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("journal commit did not notify the listener")
	}
	listenerCancel()
	select {
	case err := <-listenerResult:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("stop observation listener: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("observation listener did not stop")
	}
}

func integrationRepository(t *testing.T) (*Repository, *sql.DB, context.Context) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_RUNTIME_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	database, err := OpenDatabase(ctx, databaseURL, 20, 5)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })
	lockDatabase, err := OpenDatabase(ctx, databaseURL, 8, 8)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = lockDatabase.Close() })
	if _, err := database.ExecContext(ctx, `DROP SCHEMA IF EXISTS runtime_controller CASCADE`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cleanupCancel()
		_, _ = database.ExecContext(cleanupCtx, `DROP SCHEMA IF EXISTS runtime_controller CASCADE`)
	})
	if err := Migrate(ctx, database); err != nil {
		t.Fatal(err)
	}
	repository, err := New(database, lockDatabase, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return repository, database, ctx
}

func integrationOperation(requestID string, kind deployment.OperationKind, now time.Time) deployment.Operation {
	digest := "sha256:" + strings.Repeat("c", 64)
	requestDigest := "sha256:" + strings.Repeat("d", 64)
	return deployment.Operation{
		RequestID: requestID, RequestDigest: requestDigest, Kind: kind, AgentID: "agent-1",
		RuntimeRevision: deployment.RevisionFor(requestID, requestDigest),
		SourceState:     deployment.LifecycleUninitialized,
		Generation:      1, SpecDigest: digest, Attempt: 1,
		State: deployment.OperationRunning, Effect: deployment.EffectUnknown,
		MaintenanceVerifiers: &deployment.MaintenanceVerifiers{Keys: []deployment.MaintenanceVerifierKey{}},
		CreatedAt:            now, UpdatedAt: now,
	}
}

func integrationEnvironment(
	operation deployment.Operation, state deployment.LifecycleState, now time.Time,
) *deployment.Environment {
	return &deployment.Environment{
		AgentID: operation.AgentID, RuntimeRevision: operation.RuntimeRevision,
		LifecycleState: state, Health: deployment.HealthHealthy,
		MCPEndpoint: "http://runtime:8093/mcp", RuntimeExecutionID: "execution-1",
		Generation: operation.Generation, SpecDigest: operation.SpecDigest, ObservedAt: now,
	}
}

func mustRuntimeKey(t *testing.T, environment deployment.Environment) deployment.Key {
	t.Helper()
	key, ok := environment.RuntimeKey()
	if !ok {
		t.Fatalf("invalid Runtime key in environment: %+v", environment)
	}
	return key
}
