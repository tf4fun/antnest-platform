package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRecoveryWorkerResumesClaimAndReleasesLease(t *testing.T) {
	t.Parallel()

	now := time.Unix(100, 0).UTC()
	operation := recoveryOperation(domain.OperationCreate)
	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: operation, WorkerID: "worker-1", Attempt: 2,
			LeaseUntil: now.Add(45 * time.Second), ConsecutiveFailures: 0,
		},
		found: true,
	}
	resumer := &recoveryResumerStub{}
	worker, err := NewLifecycleRecoveryWorker(
		store, resumer,
		func(
			ctx context.Context,
			claim ports.LifecycleRecoveryClaim,
			resume func(context.Context, string) (LifecycleRecoveryResult, error),
		) (LifecycleRecoveryResult, error) {
			if claim.Operation.RequestID != operation.RequestID {
				t.Fatalf("instrumented claim = %+v", claim)
			}
			return resume(ctx, "00-22222222222222222222222222222222-2222222222222222-01")
		},
		LifecycleRecoveryWorkerConfig{
			WorkerID: "worker-1", PollInterval: 2 * time.Second,
			StaleAfter: 45 * time.Second, AttemptTimeout: 30 * time.Second,
			LeaseDuration: 45 * time.Second, RetryMax: time.Minute,
		},
	)
	if err != nil {
		t.Fatalf("create recovery worker: %v", err)
	}

	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("run recovery once: %v", err)
	}
	if !processed || resumer.operation.RequestID != operation.RequestID {
		t.Fatalf("processed=%v resumed=%+v", processed, resumer.operation)
	}
	if store.claimInput.WorkerID != "worker-1" ||
		store.claimInput.StaleAfter != 45*time.Second ||
		store.claimInput.LeaseDuration != 45*time.Second {
		t.Fatalf("claim input = %+v", store.claimInput)
	}
	if store.started.RequestID != operation.RequestID || store.started.Attempt != 2 ||
		store.started.TraceParent != "00-22222222222222222222222222222222-2222222222222222-01" {
		t.Fatalf("started attempt = %+v", store.started)
	}
	if store.released.RequestID != operation.RequestID || store.released.Attempt != 2 ||
		store.released.Failed || store.released.RetryAfter != 2*time.Second {
		t.Fatalf("released claim = %+v", store.released)
	}
}

func TestLifecycleRecoveryWorkerBacksOffFailedAttempt(t *testing.T) {
	t.Parallel()

	now := time.Unix(200, 0).UTC()
	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: recoveryOperation(domain.OperationRebuild),
			WorkerID:  "worker-1", Attempt: 5,
			LeaseUntil: now.Add(45 * time.Second), ConsecutiveFailures: 2,
		},
		found: true,
	}
	resumer := &recoveryResumerStub{err: ErrDependencyUnavailable}
	worker := mustRecoveryWorker(t, store, resumer)

	processed, err := worker.RunOnce(context.Background())
	if err != nil {
		t.Fatalf("run failed recovery attempt: %v", err)
	}
	if !processed || !store.released.Failed ||
		store.released.RetryAfter != 8*time.Second {
		t.Fatalf("failed release = %+v", store.released)
	}
}

func TestLifecycleRecoveryWorkerDoesNothingWithoutClaim(t *testing.T) {
	t.Parallel()

	store := &recoveryStoreStub{}
	resumer := &recoveryResumerStub{}
	worker := mustRecoveryWorker(t, store, resumer)

	processed, err := worker.RunOnce(context.Background())
	if err != nil || processed || resumer.operation.RequestID != "" ||
		store.started.RequestID != "" || store.released.RequestID != "" {
		t.Fatalf("idle recovery processed=%v err=%v store=%+v", processed, err, store)
	}
}

func TestLifecycleRecoveryWorkerRejectsLeaseShorterThanAttempt(t *testing.T) {
	t.Parallel()

	_, err := NewLifecycleRecoveryWorker(
		&recoveryStoreStub{}, &recoveryResumerStub{}, nil,
		LifecycleRecoveryWorkerConfig{
			WorkerID: "worker-1", PollInterval: time.Second, StaleAfter: time.Second,
			AttemptTimeout: 10 * time.Second, LeaseDuration: 10 * time.Second,
			RetryMax: time.Minute,
		},
	)
	if err == nil {
		t.Fatal("recovery worker accepted a lease that cannot fence the attempt")
	}
}

func TestLifecycleRecoveryWorkerLeavesTerminalClaimToAtomicSagaCommit(t *testing.T) {
	t.Parallel()

	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: recoveryOperation(domain.OperationDelete), WorkerID: "worker-1", Attempt: 2,
		},
		found: true,
	}
	worker := mustRecoveryWorker(t, store, &recoveryResumerStub{
		result: LifecycleRecoveryResult{
			Phase: domain.PhaseCompleted, State: domain.OperationCompleted, Progressed: true, Terminal: true,
		},
	})

	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("terminal recovery processed=%v err=%v", processed, err)
	}
	if store.released.RequestID != "" {
		t.Fatalf("terminal recovery issued a second lease release: %+v", store.released)
	}
}

func TestLifecycleRecoveryWorkerPropagatesFatalInvariant(t *testing.T) {
	t.Parallel()

	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: recoveryOperation(domain.OperationEnable), WorkerID: "worker-1", Attempt: 2,
		},
		found: true,
	}
	fatalErr := errors.New("invalid persisted phase")
	worker := mustRecoveryWorker(t, store, &recoveryResumerStub{err: fatalErr})

	processed, err := worker.RunOnce(context.Background())
	if !processed || !errors.Is(err, fatalErr) {
		t.Fatalf("fatal recovery processed=%v err=%v", processed, err)
	}
	if store.released.RequestID != "" {
		t.Fatalf("fatal recovery hid invariant behind retry: %+v", store.released)
	}
}

func TestLifecycleRecoveryWorkerTreatsLostClaimAsSuperseded(t *testing.T) {
	t.Parallel()

	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: recoveryOperation(domain.OperationDisable), WorkerID: "worker-1", Attempt: 2,
		},
		found: true, startErr: ports.ErrLifecycleRecoveryClaimLost,
	}
	worker := mustRecoveryWorker(t, store, &recoveryResumerStub{})

	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("lost claim processed=%v err=%v", processed, err)
	}
	if store.released.RequestID != "" {
		t.Fatalf("lost claim released a newer lease: %+v", store.released)
	}
}

func TestResumeLifecycleOperationDispatchesPersistedKind(t *testing.T) {
	t.Parallel()

	for _, kind := range []domain.OperationKind{
		domain.OperationCreate,
		domain.OperationRebuild,
		domain.OperationDisable,
		domain.OperationEnable,
		domain.OperationDelete,
	} {
		kind := kind
		t.Run(string(kind), func(t *testing.T) {
			t.Parallel()
			store := &recoveryDispatchStore{}
			service := &LifecycleService{store: store}
			operation := recoveryOperation(kind)

			if _, err := service.ResumeLifecycleOperation(context.Background(), operation); err != nil {
				t.Fatalf("resume %s: %v", kind, err)
			}
			if store.replayedKind != kind || store.requestID != operation.RequestID ||
				store.fingerprint != operation.RequestFingerprint {
				t.Fatalf("dispatch = kind:%s request:%q fingerprint:%q", store.replayedKind, store.requestID, store.fingerprint)
			}
		})
	}
}

func recoveryOperation(kind domain.OperationKind) ports.LifecycleOperationRecord {
	return ports.LifecycleOperationRecord{
		RequestID: "request-recovery-1", RequestFingerprint: strings.Repeat("f", 64),
		AgentID: "agent-recovery-1", Kind: kind,
		Phase: domain.PhaseRuntimeInitialize, State: domain.OperationRunning,
		ChildRequestID: "child-recovery-1", Attempt: 1,
		InitialTraceParent: "00-11111111111111111111111111111111-1111111111111111-01",
	}
}

func mustRecoveryWorker(
	t *testing.T, store *recoveryStoreStub, resumer *recoveryResumerStub,
) *LifecycleRecoveryWorker {
	t.Helper()
	worker, err := NewLifecycleRecoveryWorker(
		store, resumer, nil,
		LifecycleRecoveryWorkerConfig{
			WorkerID: "worker-1", PollInterval: 2 * time.Second,
			StaleAfter: 45 * time.Second, AttemptTimeout: 30 * time.Second,
			LeaseDuration: 45 * time.Second, RetryMax: time.Minute,
		},
	)
	if err != nil {
		t.Fatalf("create recovery worker: %v", err)
	}
	return worker
}

type recoveryStoreStub struct {
	claimInput ports.ClaimLifecycleRecovery
	claim      ports.LifecycleRecoveryClaim
	found      bool
	claimErr   error
	started    ports.StartLifecycleRecoveryAttempt
	startErr   error
	released   ports.ReleaseLifecycleRecoveryClaim
	releaseErr error
}

func (store *recoveryStoreStub) ClaimLifecycleRecovery(
	_ context.Context, input ports.ClaimLifecycleRecovery,
) (ports.LifecycleRecoveryClaim, bool, error) {
	store.claimInput = input
	return store.claim, store.found, store.claimErr
}

func (store *recoveryStoreStub) StartLifecycleRecoveryAttempt(
	_ context.Context, input ports.StartLifecycleRecoveryAttempt,
) error {
	store.started = input
	return store.startErr
}

func (store *recoveryStoreStub) ReleaseLifecycleRecoveryClaim(
	_ context.Context, input ports.ReleaseLifecycleRecoveryClaim,
) error {
	store.released = input
	return store.releaseErr
}

type recoveryResumerStub struct {
	operation ports.LifecycleOperationRecord
	result    LifecycleRecoveryResult
	err       error
}

func (resumer *recoveryResumerStub) ResumeLifecycleOperation(
	_ context.Context, operation ports.LifecycleOperationRecord,
) (LifecycleRecoveryResult, error) {
	resumer.operation = operation
	return resumer.result, resumer.err
}

type recoveryDispatchStore struct {
	ports.LifecycleStore
	replayedKind domain.OperationKind
	requestID    string
	fingerprint  string
}

func (store *recoveryDispatchStore) remember(
	kind domain.OperationKind, requestID string, fingerprint string,
) {
	store.replayedKind = kind
	store.requestID = requestID
	store.fingerprint = fingerprint
}

func (store *recoveryDispatchStore) ReplayAgentCreate(
	_ context.Context, requestID string, fingerprint string,
) (ports.AgentCreateState, bool, error) {
	store.remember(domain.OperationCreate, requestID, fingerprint)
	return ports.AgentCreateState{Operation: completedRecoveryOperation(domain.OperationCreate)}, true, nil
}

func (store *recoveryDispatchStore) ReplayAgentRebuild(
	_ context.Context, requestID string, fingerprint string,
) (ports.AgentRebuildState, bool, error) {
	store.remember(domain.OperationRebuild, requestID, fingerprint)
	return ports.AgentRebuildState{Operation: completedRecoveryOperation(domain.OperationRebuild)}, true, nil
}

func (store *recoveryDispatchStore) ReplayAgentDisable(
	_ context.Context, requestID string, fingerprint string,
) (ports.AgentDisableState, bool, error) {
	store.remember(domain.OperationDisable, requestID, fingerprint)
	return ports.AgentDisableState{Operation: completedRecoveryOperation(domain.OperationDisable)}, true, nil
}

func (store *recoveryDispatchStore) ReplayAgentEnable(
	_ context.Context, requestID string, fingerprint string,
) (ports.AgentEnableState, bool, error) {
	store.remember(domain.OperationEnable, requestID, fingerprint)
	return ports.AgentEnableState{Operation: completedRecoveryOperation(domain.OperationEnable)}, true, nil
}

func (store *recoveryDispatchStore) ReplayAgentDelete(
	_ context.Context, requestID string, fingerprint string,
) (ports.AgentDeleteState, bool, error) {
	store.remember(domain.OperationDelete, requestID, fingerprint)
	return ports.AgentDeleteState{Operation: completedRecoveryOperation(domain.OperationDelete)}, true, nil
}

func completedRecoveryOperation(kind domain.OperationKind) ports.LifecycleOperationRecord {
	return ports.LifecycleOperationRecord{
		RequestID: "request-recovery-1", RequestFingerprint: strings.Repeat("f", 64),
		AgentID: "agent-recovery-1", Kind: kind,
		Phase: domain.PhaseCompleted, State: domain.OperationCompleted,
	}
}
