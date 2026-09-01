package application

import (
	"context"
	"errors"
	"slices"
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
	if !resumer.hasToken || resumer.token.RequestID != operation.RequestID ||
		resumer.token.WorkerID != "worker-1" || resumer.token.Attempt != 2 {
		t.Fatalf("recovery token = %+v present=%v", resumer.token, resumer.hasToken)
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
			ctx := ports.WithLifecycleRecoveryToken(context.Background(), ports.LifecycleRecoveryToken{
				RequestID: operation.RequestID, WorkerID: "worker-1", Attempt: operation.Attempt,
			})

			if _, err := service.ResumeLifecycleOperation(ctx, operation); err != nil {
				t.Fatalf("resume %s: %v", kind, err)
			}
			if store.replayedKind != kind || store.requestID != operation.RequestID ||
				store.fingerprint != operation.RequestFingerprint {
				t.Fatalf("dispatch = kind:%s request:%q fingerprint:%q", store.replayedKind, store.requestID, store.fingerprint)
			}
		})
	}
}

func TestResumeLifecycleOperationRequiresMatchingRecoveryToken(t *testing.T) {
	t.Parallel()

	service := &LifecycleService{store: &recoveryDispatchStore{}}
	operation := recoveryOperation(domain.OperationCreate)
	for name, ctx := range map[string]context.Context{
		"missing": context.Background(),
		"wrong request": ports.WithLifecycleRecoveryToken(
			context.Background(),
			ports.LifecycleRecoveryToken{RequestID: "another-request", WorkerID: "worker-1", Attempt: 1},
		),
	} {
		if _, err := service.ResumeLifecycleOperation(ctx, operation); !errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
			t.Errorf("%s token error = %v", name, err)
		}
	}
}

func TestResumeLifecycleOperationRejectsStaleAuthoritativeClaim(t *testing.T) {
	t.Parallel()

	tests := map[string]func(*ports.LifecycleOperationRecord, *ports.LifecycleRecoveryToken){
		"missing owner": func(operation *ports.LifecycleOperationRecord, _ *ports.LifecycleRecoveryToken) {
			operation.RecoveryOwner = ""
		},
		"wrong worker": func(_ *ports.LifecycleOperationRecord, token *ports.LifecycleRecoveryToken) {
			token.WorkerID = "another-worker"
		},
		"wrong attempt": func(_ *ports.LifecycleOperationRecord, token *ports.LifecycleRecoveryToken) {
			token.Attempt++
		},
		"missing lease": func(operation *ports.LifecycleOperationRecord, _ *ports.LifecycleRecoveryToken) {
			operation.RecoveryLeaseUntil = nil
		},
		"expired lease": func(operation *ports.LifecycleOperationRecord, _ *ports.LifecycleRecoveryToken) {
			expired := time.Unix(49, 0).UTC()
			operation.RecoveryLeaseUntil = &expired
		},
	}
	for name, mutate := range tests {
		t.Run(name, func(t *testing.T) {
			store := &lifecycleStoreStub{}
			dependencies := &lifecycleDependenciesStub{
				network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
			}
			service := newLifecycleTestService(t, store, dependencies)
			result, err := service.CreateAgent(
				context.Background(), lifecycleCreateInput("request-stale-claim-"+strings.ReplaceAll(name, " ", "-")),
			)
			if err != nil || result.Operation.Phase != domain.PhaseRuntimeInitialize {
				t.Fatalf("interrupt create: result=%+v err=%v", result, err)
			}
			store.replayed = true
			operation := &store.beginState.Operation
			operation.Attempt++
			operation.RecoveryOwner = "recovery-worker"
			leaseUntil := time.Unix(60, 0).UTC()
			operation.RecoveryLeaseUntil = &leaseUntil
			token := ports.LifecycleRecoveryToken{
				RequestID: operation.RequestID, WorkerID: operation.RecoveryOwner, Attempt: operation.Attempt,
			}
			mutate(operation, &token)
			dependencies.calls = nil

			ctx := ports.WithLifecycleRecoveryToken(context.Background(), token)
			if _, err := service.ResumeLifecycleOperation(ctx, *operation); !errors.Is(err, ports.ErrLifecycleRecoveryClaimLost) {
				t.Fatalf("stale claim error = %v", err)
			}
			if len(dependencies.calls) != 0 {
				t.Fatalf("stale claim reached dependency: %v", dependencies.calls)
			}
		})
	}
}

func TestLifecycleRecoveryDoesNotExecuteSecondPhaseAfterConcurrentAdvance(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{State: "running"},
	}
	service := newLifecycleTestService(t, store, dependencies)
	result, err := service.CreateAgent(context.Background(), lifecycleCreateInput("request-recovery-concurrent"))
	if err != nil || result.Operation.Phase != domain.PhaseRuntimeInitialize {
		t.Fatalf("interrupt create: result=%+v err=%v", result, err)
	}
	store.replayed = true
	store.concurrentPhase = "runtime"
	dependencies.runtime = readyRecoveryRuntime("concurrent")
	dependencies.calls = nil
	recoveryStore := &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
		return &store.beginState.Operation
	}}
	worker, err := NewLifecycleRecoveryWorker(
		recoveryStore, service, nil,
		LifecycleRecoveryWorkerConfig{
			WorkerID: "recovery-worker", PollInterval: 10 * time.Millisecond,
			StaleAfter: 2 * time.Second, AttemptTimeout: time.Second,
			LeaseDuration: 2 * time.Second, RetryMax: 2 * time.Second,
		},
	)
	if err != nil {
		t.Fatalf("create recovery worker: %v", err)
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("run concurrent recovery: processed=%v err=%v", processed, err)
	}
	if store.beginState.Operation.Phase != domain.PhasePublish {
		t.Fatalf("concurrent transaction did not publish its phase advance: %+v", store.beginState.Operation)
	}
	if !slices.Equal(dependencies.calls, []string{"runtime.initialize"}) {
		t.Fatalf("concurrent recovery crossed phase boundary: %v", dependencies.calls)
	}
	if store.published.Execution.ID != "" {
		t.Fatalf("concurrent recovery published in the same claim: %+v", store.published)
	}
	if !recoveryStore.released || store.beginState.Operation.RecoveryOwner != "" ||
		store.beginState.Operation.RecoveryLeaseUntil != nil {
		t.Fatalf("concurrent recovery retained claim: %+v", store.beginState.Operation)
	}
}

func TestLifecycleRecoveryWorkerAdvancesEachSagaByOneClaimedPhase(t *testing.T) {
	t.Run("create", func(t *testing.T) {
		store := &lifecycleStoreStub{}
		dependencies := &lifecycleDependenciesStub{
			network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
		}
		service := newLifecycleTestService(t, store, dependencies)
		result, err := service.CreateAgent(context.Background(), lifecycleCreateInput("request-worker-create"))
		if err != nil || result.Operation.Phase != domain.PhaseRuntimeInitialize {
			t.Fatalf("interrupt create: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.runtime = readyRecoveryRuntime("created")
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.beginState.Operation
			}}, &store.beginState.Operation, func() []string { return dependencies.calls },
			domain.PhasePublish, []string{"runtime.initialize"},
		)
	})

	t.Run("rebuild", func(t *testing.T) {
		template := mustLifecycleTemplate(t)
		model := mustLifecycleModel(t)
		base := rebuildLifecycleBase(t, template, model)
		store := &rebuildLifecycleStoreStub{base: base}
		dependencies := &rebuildDependenciesStub{
			network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
		}
		service := NewLifecycleService(
			lifecycleSpecSourceStub{template: template, model: model},
			store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
		)
		result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
			RequestID: "request-worker-rebuild", AgentID: base.Agent.AgentID,
			TemplateID: "template-1", TemplateRevision: 1,
		})
		if err != nil || result.Operation.Phase != domain.PhaseRuntimeUpdate {
			t.Fatalf("interrupt rebuild: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.runtime = readyRecoveryRuntime("rebuilt")
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseNetworkEnsure, []string{"runtime.update"},
		)
	})

	t.Run("disable", func(t *testing.T) {
		base := disableLifecycleBase(t)
		store := &disableLifecycleStoreStub{base: base}
		dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "running"})
		service := newLifecycleTestService(t, store, dependencies)
		result, err := service.DisableAgent(context.Background(), DisableAgentInput{
			RequestID: "request-worker-disable", AgentID: base.Agent.AgentID,
		})
		if err != nil || result.Operation.Phase != domain.PhaseRuntimeDisable {
			t.Fatalf("interrupt disable: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.runtime = ports.RuntimeOperation{
			State: "completed", Effect: "completed", RuntimeRevision: base.Agent.RuntimeRevision,
			LifecycleState: "disabled", Health: "absent",
		}
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhasePublish, []string{"runtime.disable"},
		)
	})

	t.Run("enable", func(t *testing.T) {
		base := enableLifecycleBase(t)
		store := &enableLifecycleStoreStub{base: base}
		dependencies := newEnableDependencies(base, ports.RuntimeOperation{State: "running"})
		service := newLifecycleTestService(t, store, dependencies)
		result, err := service.EnableAgent(context.Background(), EnableAgentInput{
			RequestID: "request-worker-enable", AgentID: base.Agent.AgentID,
		})
		if err != nil || result.Operation.Phase != domain.PhaseRuntimeEnable {
			t.Fatalf("interrupt enable: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.runtime = readyEnableRuntime()
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseNetworkRestore, []string{"runtime.enable"},
		)
	})

	t.Run("delete", func(t *testing.T) {
		base := deleteAgentBase(domain.AgentAvailable)
		store := &deleteLifecycleStoreStub{base: base}
		dependencies := newDeleteDependencies(base.Agent)
		dependencies.runtime = ports.RuntimeOperation{State: "running"}
		service := NewLifecycleService(
			lifecycleSpecSourceStub{}, store, dependencies, dependencies,
			fixedClock{now: time.Unix(700, 0).UTC()},
		)
		result, err := service.DeleteAgent(context.Background(), DeleteAgentInput{
			RequestID: "request-worker-delete", AgentID: base.Agent.AgentID,
		})
		if err != nil || result.Operation.Phase != domain.PhaseRuntimeDelete {
			t.Fatalf("interrupt delete: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.runtime = ports.RuntimeOperation{
			State: "completed", Effect: "completed",
			RuntimeRevision: "rtv_99999999999999999999999999999999",
			LifecycleState:  "deleted", Health: "absent",
		}
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseNetworkRelease, []string{"runtime.delete"},
		)
	})
}

func readyRecoveryRuntime(suffix string) ports.RuntimeOperation {
	return ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_22222222222222222222222222222222",
		RuntimeExecutionID: "runtime-execution-" + suffix,
		MCPEndpoint:        "http://runtime-" + suffix + ":8091/mcp",
		LifecycleState:     "ready", Health: "healthy",
	}
}

func runClaimedLifecycleRecovery(
	t *testing.T,
	service *LifecycleService,
	recoveryStore *claimingRecoveryStore,
	operation *ports.LifecycleOperationRecord,
	dependencyCalls func() []string,
	wantPhase domain.OperationPhase,
	wantCalls []string,
) {
	t.Helper()
	worker, err := NewLifecycleRecoveryWorker(
		recoveryStore, service, nil,
		LifecycleRecoveryWorkerConfig{
			WorkerID: "recovery-worker", PollInterval: 10 * time.Millisecond,
			StaleAfter: 2 * time.Second, AttemptTimeout: time.Second,
			LeaseDuration: 2 * time.Second, RetryMax: 2 * time.Second,
		},
	)
	if err != nil {
		t.Fatalf("create recovery worker: %v", err)
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("run claimed recovery: processed=%v err=%v", processed, err)
	}
	if operation.Phase != wantPhase || operation.State != domain.OperationRunning {
		t.Fatalf("recovered operation = %+v, want phase=%s", *operation, wantPhase)
	}
	if operation.RecoveryOwner != "" || operation.RecoveryLeaseUntil != nil {
		t.Fatalf("nonterminal recovery retained reservation: %+v", *operation)
	}
	if !slices.Equal(dependencyCalls(), wantCalls) {
		t.Fatalf("recovery dependency calls = %v, want %v", dependencyCalls(), wantCalls)
	}
	if !recoveryStore.started || !recoveryStore.released {
		t.Fatalf("recovery lease lifecycle started=%v released=%v", recoveryStore.started, recoveryStore.released)
	}
}

type claimingRecoveryStore struct {
	operation func() *ports.LifecycleOperationRecord
	started   bool
	released  bool
}

func (store *claimingRecoveryStore) ClaimLifecycleRecovery(
	_ context.Context, input ports.ClaimLifecycleRecovery,
) (ports.LifecycleRecoveryClaim, bool, error) {
	operation := store.operation()
	operation.Attempt++
	operation.RecoveryOwner = input.WorkerID
	leaseUntil := time.Now().Add(input.LeaseDuration)
	operation.RecoveryLeaseUntil = &leaseUntil
	return ports.LifecycleRecoveryClaim{
		Operation: *operation, WorkerID: input.WorkerID, Attempt: operation.Attempt,
		LeaseUntil: leaseUntil,
	}, true, nil
}

func (store *claimingRecoveryStore) StartLifecycleRecoveryAttempt(
	_ context.Context, input ports.StartLifecycleRecoveryAttempt,
) error {
	operation := store.operation()
	if operation.RequestID != input.RequestID || operation.RecoveryOwner != input.WorkerID ||
		operation.Attempt != input.Attempt || operation.RecoveryLeaseUntil == nil {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	store.started = true
	return nil
}

func (store *claimingRecoveryStore) ReleaseLifecycleRecoveryClaim(
	_ context.Context, input ports.ReleaseLifecycleRecoveryClaim,
) error {
	operation := store.operation()
	if operation.RequestID != input.RequestID || operation.RecoveryOwner != input.WorkerID ||
		operation.Attempt != input.Attempt || operation.RecoveryLeaseUntil == nil {
		return ports.ErrLifecycleRecoveryClaimLost
	}
	operation.RecoveryOwner = ""
	operation.RecoveryLeaseUntil = nil
	store.released = true
	return nil
}

func TestRebuildLifecycleRecoveryAdvancesOneDurablePhasePerClaim(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base}
	dependencies := &rebuildDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{State: "running"},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
	)

	result, err := service.RebuildAgent(
		context.Background(),
		RebuildAgentInput{
			RequestID: "request-recovery-rebuild", AgentID: base.Agent.AgentID,
			TemplateID: "template-1", TemplateRevision: 1,
		},
	)
	if err != nil {
		t.Fatalf("start recoverable rebuild: %v", err)
	}
	if result.Operation.Phase != domain.PhaseRuntimeUpdate || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted rebuild = %+v", result.Operation)
	}
	store.replayed = true
	dependencies.runtime = readyRecoveryRuntime("rebuilt")
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkEnsure, domain.OperationRunning, false,
			[]string{"runtime.update"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.policy.get", "egress.policy.assign", "egress.ensure"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	for _, step := range steps {
		resumeLifecycleRecoveryStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestDisableLifecycleRecoveryAdvancesOneDurablePhasePerClaim(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "running"})
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.DisableAgent(
		context.Background(),
		DisableAgentInput{RequestID: "request-recovery-disable", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable disable: %v", err)
	}
	if result.Operation.Phase != domain.PhaseRuntimeDisable || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted disable = %+v", result.Operation)
	}
	store.replayed = true
	dependencies.runtime = ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: base.Agent.RuntimeRevision,
		LifecycleState: "disabled", Health: "absent",
	}
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhasePublish, domain.OperationRunning, false, []string{"runtime.disable"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	for _, step := range steps {
		resumeLifecycleRecoveryStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestEnableLifecycleRecoveryAdvancesOneDurablePhasePerClaim(t *testing.T) {
	t.Parallel()

	base := enableLifecycleBase(t)
	store := &enableLifecycleStoreStub{base: base}
	dependencies := newEnableDependencies(base, ports.RuntimeOperation{State: "running"})
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.EnableAgent(
		context.Background(),
		EnableAgentInput{RequestID: "request-recovery-enable", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable enable: %v", err)
	}
	if result.Operation.Phase != domain.PhaseRuntimeEnable || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted enable = %+v", result.Operation)
	}
	store.replayed = true
	dependencies.runtime = readyEnableRuntime()
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkRestore, domain.OperationRunning, false, []string{"runtime.enable"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.policy.get", "egress.policy.assign", "egress.ensure"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	for _, step := range steps {
		resumeLifecycleRecoveryStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestDeleteLifecycleRecoveryAdvancesOneDurablePhasePerClaim(t *testing.T) {
	t.Parallel()

	base := deleteAgentBase(domain.AgentAvailable)
	store := &deleteLifecycleStoreStub{base: base}
	dependencies := newDeleteDependencies(base.Agent)
	dependencies.runtime = ports.RuntimeOperation{State: "running"}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{}, store, dependencies, dependencies,
		fixedClock{now: time.Unix(700, 0).UTC()},
	)

	result, err := service.DeleteAgent(
		context.Background(),
		DeleteAgentInput{RequestID: "request-recovery-delete", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable delete: %v", err)
	}
	if result.Operation.Phase != domain.PhaseRuntimeDelete || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted delete = %+v", result.Operation)
	}
	store.replayed = true
	dependencies.runtime = ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_99999999999999999999999999999999",
		LifecycleState:  "deleted", Health: "absent",
	}
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkRelease, domain.OperationRunning, false, []string{"runtime.delete"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.policy.get", "egress.release"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	for _, step := range steps {
		resumeLifecycleRecoveryStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

type lifecycleRecoveryStepExpectation struct {
	phase    domain.OperationPhase
	state    domain.OperationState
	terminal bool
	calls    []string
}

func resumeLifecycleRecoveryStep(
	t *testing.T,
	service *LifecycleService,
	operation *ports.LifecycleOperationRecord,
	dependencyCalls func() []string,
	wantPhase domain.OperationPhase,
	wantState domain.OperationState,
	wantTerminal bool,
	wantCalls []string,
) {
	t.Helper()

	before := len(dependencyCalls())
	operation.RecoveryOwner = "recovery-worker"
	operation.Attempt++
	leaseUntil := time.Now().Add(time.Minute)
	operation.RecoveryLeaseUntil = &leaseUntil
	ctx := ports.WithLifecycleRecoveryToken(context.Background(), ports.LifecycleRecoveryToken{
		RequestID: operation.RequestID, WorkerID: operation.RecoveryOwner, Attempt: operation.Attempt,
	})
	result, err := service.ResumeLifecycleOperation(ctx, *operation)
	if err != nil {
		t.Fatalf("resume %s at %s: %v", operation.Kind, operation.Phase, err)
	}
	if !result.Progressed || result.Terminal != wantTerminal {
		t.Fatalf("recovery result = %+v, want progressed=true terminal=%v", result, wantTerminal)
	}
	assertRecoveryBoundary(
		t,
		OperationView{Phase: result.Phase, State: result.State},
		wantPhase,
		wantState,
		dependencyCalls()[before:],
		wantCalls,
	)
	if wantTerminal && (operation.RecoveryOwner != "" || operation.RecoveryLeaseUntil != nil) {
		t.Fatalf("terminal recovery retained reservation: %+v", *operation)
	}
}

func assertRecoveryBoundary(
	t *testing.T,
	operation OperationView,
	wantPhase domain.OperationPhase,
	wantState domain.OperationState,
	gotCalls []string,
	wantCalls []string,
) {
	t.Helper()
	if operation.Phase != wantPhase || operation.State != wantState {
		t.Fatalf("operation = %+v, want phase=%s state=%s", operation, wantPhase, wantState)
	}
	if !slices.Equal(gotCalls, wantCalls) {
		t.Fatalf("dependency calls = %v, want %v", gotCalls, wantCalls)
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
	token     ports.LifecycleRecoveryToken
	hasToken  bool
}

func (resumer *recoveryResumerStub) ResumeLifecycleOperation(
	ctx context.Context, operation ports.LifecycleOperationRecord,
) (LifecycleRecoveryResult, error) {
	resumer.operation = operation
	resumer.token, resumer.hasToken = ports.LifecycleRecoveryTokenFromContext(ctx)
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
