package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/domain"
)

func TestReconcilePrepareStartsExactlyOneGeneration(t *testing.T) {
	repository, service := preparedRuntime(t)
	driver := &fakeRuntimeDriver{
		ensureResult: DriverResult{
			Outcome:     domain.EffectOutcome{State: domain.EffectCompleted},
			ContainerID: "container-1",
		},
	}
	reconciler := newTestReconciler(t, repository, driver)

	result, err := reconciler.Reconcile(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if driver.ensureCalls != 1 || result.Settled {
		t.Fatalf("unexpected reconcile result: calls=%d result=%+v", driver.ensureCalls, result)
	}
	if driver.ensureRequest.RuntimeInstanceID == "" || driver.ensureRequest.TunnelIPv4 != "100.64.0.2" {
		t.Fatalf("missing bootstrap identity: %+v", driver.ensureRequest)
	}
	if repository.runtime.Status != domain.RuntimeStarting {
		t.Fatalf("runtime status = %s", repository.runtime.Status)
	}
	generation := repository.generations["agent-1/1"]
	if generation.Status != domain.GenerationStarting || generation.ContainerID != "container-1" {
		t.Fatalf("unexpected generation: %+v", generation)
	}
	operation := onlyOperation(t, repository)
	if operation.Status != domain.OperationRunning {
		t.Fatalf("operation status = %s", operation.Status)
	}

	_, err = service.RuntimeConnected(context.Background(), ConnectedInput{
		AgentID: "agent-1", Generation: 1, ConnectionEpoch: 1,
		RuntimeInstanceID: repository.generations["agent-1/1"].RuntimeInstanceID,
	})
	if err != nil {
		t.Fatalf("runtime connected: %v", err)
	}
	_, err = service.RuntimeHealthy(context.Background(), HealthyInput{
		AgentID: "agent-1", Generation: 1, ConnectionEpoch: 1, PolicyEpoch: 1,
	})
	if err != nil {
		t.Fatalf("runtime healthy: %v", err)
	}
	if repository.runtime.Status != domain.RuntimeReady || onlyOperation(t, repository).Status != domain.OperationSucceeded {
		t.Fatalf("connection did not finish operation: runtime=%+v operation=%+v", repository.runtime, onlyOperation(t, repository))
	}
}

func TestReconcileUnknownEffectIsObservedLaterNotBlindlyRetried(t *testing.T) {
	repository, _ := preparedRuntime(t)
	driver := &fakeRuntimeDriver{
		ensureResult: DriverResult{
			Outcome: domain.EffectOutcome{State: domain.EffectUnknown, Code: "response_lost"},
		},
	}
	reconciler := newTestReconciler(t, repository, driver)

	result, err := reconciler.Reconcile(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("reconcile: %v", err)
	}
	if result.RetryAt.IsZero() {
		t.Fatal("unknown result did not schedule an observation")
	}
	if operation := onlyOperation(t, repository); operation.Status != domain.OperationUnknown {
		t.Fatalf("operation status = %s", operation.Status)
	}
	if driver.ensureCalls != 1 {
		t.Fatalf("ensure calls = %d", driver.ensureCalls)
	}
}

func TestReconcileClaimsOperationBeforeDriverSideEffect(t *testing.T) {
	repository, _ := preparedRuntime(t)
	driver := &fakeRuntimeDriver{
		ensureResult: DriverResult{
			Outcome: domain.EffectOutcome{State: domain.EffectCompleted}, ContainerID: "container-1",
		},
		beforeEnsure: func() {
			if operation := onlyOperation(t, repository); operation.Status != domain.OperationRunning {
				t.Fatalf("driver observed unclaimed operation: %+v", operation)
			}
		},
	}
	if _, err := newTestReconciler(t, repository, driver).Reconcile(context.Background(), "agent-1"); err != nil {
		t.Fatalf("reconcile: %v", err)
	}
}

func TestClaimedPurgeCannotBeSupersededBeforeWorkspaceDeletion(t *testing.T) {
	repository := newMemoryRepository()
	service, err := NewService(
		repository, &recordingSignal{repository: repository},
		fixedIDs("prepare-operation", "purge-operation", "replacement-operation"), fixedClock(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Prepare(context.Background(), PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-1",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Purge(context.Background(), LifecycleInput{
		AgentID: "agent-1", IdempotencyKey: "purge-1",
	}); err != nil {
		t.Fatal(err)
	}
	var replacementErr error
	driver := &fakeRuntimeDriver{
		beforeRemove: func() {
			_, replacementErr = service.Prepare(context.Background(), PrepareInput{
				AgentID: "agent-1", ImageRef: "antnest/runtime:test",
				NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-2",
			})
		},
	}
	if _, err := newTestReconciler(t, repository, driver).Reconcile(context.Background(), "agent-1"); err != nil {
		t.Fatalf("reconcile purge: %v", err)
	}
	if !errors.Is(replacementErr, domain.ErrConcurrentWrite) {
		t.Fatalf("Prepare crossed dispatched Purge: %v", replacementErr)
	}
	if repository.runtime.Status != domain.RuntimePurged {
		t.Fatalf("Purge did not converge: %+v", repository.runtime)
	}
}

func TestReconcileReadyRuntimeDoesNotPollOrRequeue(t *testing.T) {
	repository, service := preparedRuntime(t)
	driver := &fakeRuntimeDriver{
		ensureResult: DriverResult{Outcome: domain.EffectOutcome{State: domain.EffectCompleted}, ContainerID: "container-1"},
	}
	reconciler := newTestReconciler(t, repository, driver)
	if _, err := reconciler.Reconcile(context.Background(), "agent-1"); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	if _, err := service.RuntimeConnected(context.Background(), ConnectedInput{
		AgentID: "agent-1", Generation: 1, ConnectionEpoch: 1,
		RuntimeInstanceID: repository.generations["agent-1/1"].RuntimeInstanceID,
	}); err != nil {
		t.Fatalf("runtime connected: %v", err)
	}
	if _, err := service.RuntimeHealthy(context.Background(), HealthyInput{
		AgentID: "agent-1", Generation: 1, ConnectionEpoch: 1, PolicyEpoch: 1,
	}); err != nil {
		t.Fatalf("runtime healthy: %v", err)
	}

	result, err := reconciler.Reconcile(context.Background(), "agent-1")
	if err != nil {
		t.Fatalf("settled reconcile: %v", err)
	}
	if !result.Settled || !result.RetryAt.IsZero() || driver.ensureCalls != 1 {
		t.Fatalf("settled runtime was polled: result=%+v calls=%d", result, driver.ensureCalls)
	}
}

func TestRestoreReadyRuntimeReappliesInfrastructureWithoutSteadyStatePolling(t *testing.T) {
	repository, service := preparedRuntime(t)
	driver := &fakeRuntimeDriver{
		ensureResult: DriverResult{
			Outcome: domain.EffectOutcome{State: domain.EffectCompleted}, ContainerID: "container-1",
		},
	}
	reconciler := newTestReconciler(t, repository, driver)
	if _, err := reconciler.Reconcile(context.Background(), "agent-1"); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	if _, err := service.RuntimeConnected(context.Background(), ConnectedInput{
		AgentID: "agent-1", Generation: 1, ConnectionEpoch: 1,
		RuntimeInstanceID: repository.generations["agent-1/1"].RuntimeInstanceID,
	}); err != nil {
		t.Fatalf("runtime connected: %v", err)
	}
	if _, err := service.RuntimeHealthy(context.Background(), HealthyInput{
		AgentID: "agent-1", Generation: 1, ConnectionEpoch: 1, PolicyEpoch: 1,
	}); err != nil {
		t.Fatalf("runtime healthy: %v", err)
	}
	writesBeforeRestore := repository.writes

	if err := reconciler.RestoreReady(context.Background()); err != nil {
		t.Fatalf("restore ready Runtime: %v", err)
	}
	if driver.ensureCalls != 2 {
		t.Fatalf("ensure calls = %d, want startup restore call", driver.ensureCalls)
	}
	if repository.writes != writesBeforeRestore {
		t.Fatalf("unchanged restore wrote database state: before=%d after=%d",
			writesBeforeRestore, repository.writes)
	}
	if _, err := reconciler.Reconcile(context.Background(), "agent-1"); err != nil {
		t.Fatalf("steady state reconcile: %v", err)
	}
	if driver.ensureCalls != 2 {
		t.Fatalf("steady state polled driver: calls=%d", driver.ensureCalls)
	}
}

func TestRuntimeConnectedFencesStaleGenerationBeforeWriting(t *testing.T) {
	repository, service := preparedRuntime(t)
	before := repository.writes
	_, err := service.RuntimeConnected(context.Background(), ConnectedInput{
		AgentID: "agent-1", Generation: 2, ConnectionEpoch: 1, RuntimeInstanceID: "stale",
	})
	if !errors.Is(err, domain.ErrGenerationFenced) {
		t.Fatalf("expected generation fence, got %v", err)
	}
	if repository.writes != before {
		t.Fatalf("stale connection wrote state: before=%d after=%d", before, repository.writes)
	}
}

func preparedRuntime(t *testing.T) (*memoryRepository, *Service) {
	t.Helper()
	repository := newMemoryRepository()
	service, err := NewService(repository, &recordingSignal{repository: repository}, fixedIDs("operation-1"), fixedClock())
	if err != nil {
		t.Fatalf("new service: %v", err)
	}
	_, err = service.Prepare(context.Background(), PrepareInput{
		AgentID: "agent-1", ImageRef: "antnest/runtime:test",
		NetworkMode: domain.NetworkRestricted, IdempotencyKey: "prepare-1",
	})
	if err != nil {
		t.Fatalf("prepare: %v", err)
	}
	return repository, service
}

func newTestReconciler(t *testing.T, repository *memoryRepository, driver *fakeRuntimeDriver) *Reconciler {
	t.Helper()
	reconciler, err := NewReconciler(repository, driver, successfulNetwork{}, staticTokens("bootstrap-token"), func() time.Time {
		return time.Date(2026, 8, 28, 6, 7, 8, 0, time.UTC)
	})
	if err != nil {
		t.Fatalf("new reconciler: %v", err)
	}
	return reconciler
}

type successfulNetwork struct{}

func (successfulNetwork) Apply(context.Context, NetworkRequest) domain.EffectOutcome {
	return domain.EffectOutcome{State: domain.EffectCompleted}
}

func (successfulNetwork) Release(context.Context, RuntimeTarget) domain.EffectOutcome {
	return domain.EffectOutcome{State: domain.EffectCompleted}
}

type fakeRuntimeDriver struct {
	ensureCalls   int
	ensureRequest EnsureRequest
	ensureResult  DriverResult
	beforeEnsure  func()
	beforeRemove  func()
}

func (d *fakeRuntimeDriver) Ensure(_ context.Context, request EnsureRequest) DriverResult {
	d.ensureCalls++
	d.ensureRequest = request
	if d.beforeEnsure != nil {
		d.beforeEnsure()
	}
	if request.AgentID == "" || request.Generation == 0 || request.BootstrapToken == "" {
		return DriverResult{Outcome: domain.EffectOutcome{State: domain.EffectNotStarted, Code: "invalid_request"}}
	}
	return d.ensureResult
}

func (d *fakeRuntimeDriver) Stop(context.Context, RuntimeTarget) DriverResult {
	return DriverResult{Outcome: domain.EffectOutcome{State: domain.EffectCompleted}}
}

func (d *fakeRuntimeDriver) Remove(_ context.Context, target RuntimeTarget, _ bool) DriverResult {
	if d.beforeRemove != nil {
		d.beforeRemove()
	}
	return DriverResult{Outcome: domain.EffectOutcome{State: domain.EffectCompleted}, ContainerID: target.ContainerID}
}

type staticTokenSource string

func staticTokens(token string) staticTokenSource { return staticTokenSource(token) }

func (s staticTokenSource) Token(string, uint64) (string, error) { return string(s), nil }

func onlyOperation(t *testing.T, repository *memoryRepository) domain.Operation {
	t.Helper()
	if len(repository.operations) != 1 {
		t.Fatalf("operations = %d, want 1", len(repository.operations))
	}
	for _, operation := range repository.operations {
		return operation
	}
	return domain.Operation{}
}
