package application

import (
	"context"
	"errors"
	"slices"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"

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
			AttemptTimeout: 30 * time.Second,
			LeaseDuration:  45 * time.Second, RetryMax: time.Minute,
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
			WorkerID: "worker-1", PollInterval: time.Second,
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

func TestLifecycleRecoveryWorkerQuarantinesFatalInvariant(t *testing.T) {
	t.Parallel()

	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: recoveryOperation(domain.OperationEnable), WorkerID: "worker-1", Attempt: 2,
		},
		found: true,
	}
	fatalErr := errors.New("invalid persisted phase")
	attemptTraceID := trace.TraceID{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16}
	attemptSpanID := trace.SpanID{1, 2, 3, 4, 5, 6, 7, 8}
	worker, err := NewLifecycleRecoveryWorker(
		store, &recoveryResumerStub{err: fatalErr},
		func(
			ctx context.Context,
			_ ports.LifecycleRecoveryClaim,
			resume func(context.Context, string) (LifecycleRecoveryResult, error),
		) (LifecycleRecoveryResult, error) {
			spanContext := trace.NewSpanContext(trace.SpanContextConfig{
				TraceID: attemptTraceID, SpanID: attemptSpanID, TraceFlags: trace.FlagsSampled,
			})
			return resume(trace.ContextWithSpanContext(ctx, spanContext), "attempt-traceparent")
		},
		LifecycleRecoveryWorkerConfig{
			WorkerID: "worker-1", PollInterval: 2 * time.Second,
			AttemptTimeout: 30 * time.Second, LeaseDuration: 45 * time.Second,
			RetryMax: time.Minute,
		},
	)
	if err != nil {
		t.Fatalf("create recovery worker: %v", err)
	}

	processed, err := worker.RunOnce(context.Background())
	if !processed || err != nil {
		t.Fatalf("fatal recovery processed=%v err=%v", processed, err)
	}
	if store.quarantined.RequestID != store.claim.Operation.RequestID ||
		store.quarantined.WorkerID != "worker-1" || store.quarantined.Attempt != 2 ||
		store.quarantined.ErrorCode != "lifecycle_invariant_failed" ||
		store.quarantined.ErrorDetail != fatalErr.Error() || store.quarantined.EventID == "" ||
		store.quarantined.TraceID != attemptTraceID.String() {
		t.Fatalf("fatal recovery quarantine = %+v", store.quarantined)
	}
	if store.released.RequestID != "" {
		t.Fatalf("fatal recovery released instead of quarantining: %+v", store.released)
	}
}

func TestLifecycleRecoveryWorkerReportsQuarantineStorageFailure(t *testing.T) {
	t.Parallel()

	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: recoveryOperation(domain.OperationEnable), WorkerID: "worker-1", Attempt: 2,
		},
		found: true, quarantineErr: errors.New("database unavailable"),
	}
	worker := mustRecoveryWorker(t, store, &recoveryResumerStub{err: errors.New("invalid persisted phase")})

	processed, err := worker.RunOnce(context.Background())
	if !processed || err == nil || !strings.Contains(err.Error(), "database unavailable") {
		t.Fatalf("quarantine failure processed=%v err=%v", processed, err)
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

func TestLifecycleRecoveryWorkerReleasesClaimAfterGracefulCancellation(t *testing.T) {
	t.Parallel()

	operation := recoveryOperation(domain.OperationCreate)
	store := &recoveryStoreStub{
		claim: ports.LifecycleRecoveryClaim{
			Operation: operation, WorkerID: "worker-1", Attempt: 2,
			LeaseUntil: time.Now().Add(time.Minute),
		},
		found: true,
	}
	ctx, cancel := context.WithCancel(context.Background())
	worker := mustRecoveryWorker(t, store, &recoveryResumerStub{
		cancel: cancel, err: context.Canceled,
	})
	processed, err := worker.RunOnce(ctx)
	if !processed || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled recovery processed=%v err=%v", processed, err)
	}
	if store.released.RequestID != operation.RequestID || store.released.WorkerID != "worker-1" ||
		store.released.Attempt != 2 || store.released.RetryAfter != 0 ||
		store.releaseContextErr != nil {
		t.Fatalf("cancelled recovery release=%+v context_err=%v", store.released, store.releaseContextErr)
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
			if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
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

func TestResumeLifecycleOperationDefersLeaseExpiryToRepositoryClock(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
	}
	service := newLifecycleTestService(t, store, dependencies)
	result, err := service.CreateAgent(
		context.Background(), lifecycleCreateInput("request-database-clock-claim"),
	)
	if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("interrupt create: result=%+v err=%v", result, err)
	}
	store.replayed = true
	operation := &store.beginState.Operation
	attachment := validLifecycleNetwork()
	operation.Phase = domain.PhaseRuntimeInitialize
	operation.ChildRequestID = domain.ChildRequestID(operation.RequestID, domain.PhaseRuntimeInitialize)
	operation.NetworkAttachment = &attachment
	operation.Attempt++
	operation.RecoveryOwner = "recovery-worker"
	leaseBeforeApplicationClock := time.Unix(49, 0).UTC()
	operation.RecoveryLeaseUntil = &leaseBeforeApplicationClock
	token := ports.LifecycleRecoveryToken{
		RequestID: operation.RequestID, WorkerID: operation.RecoveryOwner, Attempt: operation.Attempt,
	}
	dependencies.runtime = readyRecoveryRuntime("database-clock")
	dependencies.calls = nil

	recovered, err := service.ResumeLifecycleOperation(
		ports.WithLifecycleRecoveryToken(context.Background(), token), *operation,
	)
	if err != nil || recovered.Phase != domain.PhasePublish || !recovered.Progressed {
		t.Fatalf("database-authoritative lease recovery = %+v err=%v", recovered, err)
	}
	if !slices.Equal(dependencies.calls, []string{"runtime.initialize"}) {
		t.Fatalf("database-authoritative lease calls = %v", dependencies.calls)
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
	if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("interrupt create: result=%+v err=%v", result, err)
	}
	store.replayed = true
	attachment := validLifecycleNetwork()
	store.beginState.Operation.Phase = domain.PhaseRuntimeInitialize
	store.beginState.Operation.ChildRequestID = domain.ChildRequestID(
		store.beginState.Operation.RequestID, domain.PhaseRuntimeInitialize,
	)
	store.beginState.Operation.NetworkAttachment = &attachment
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
			AttemptTimeout: time.Second,
			LeaseDuration:  2 * time.Second, RetryMax: 2 * time.Second,
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
		if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
			t.Fatalf("interrupt create: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.networkIndex = 0
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.beginState.Operation
			}}, &store.beginState.Operation, func() []string { return dependencies.calls },
			domain.PhaseRuntimeInitialize, []string{"egress.ensure"},
		)
	})

	t.Run("rebuild", func(t *testing.T) {
		template := mustLifecycleTemplate(t)
		model := mustLifecycleModel(t)
		base := rebuildLifecycleBase(t, template, model)
		store := &rebuildLifecycleStoreStub{base: base, drainBlocked: true}
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
		if err != nil || result.Operation.Phase != domain.PhaseDrain {
			t.Fatalf("interrupt rebuild: result=%+v err=%v", result, err)
		}
		store.replayed = true
		store.drainBlocked = false
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseNetworkFence, nil,
		)
	})

	t.Run("disable", func(t *testing.T) {
		base := disableLifecycleBase(t)
		store := &disableLifecycleStoreStub{base: base, drainBlocked: true}
		dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "running"})
		service := newLifecycleTestService(t, store, dependencies)
		result, err := service.DisableAgent(context.Background(), DisableAgentInput{
			RequestID: "request-worker-disable", AgentID: base.Agent.AgentID,
		})
		if err != nil || result.Operation.Phase != domain.PhaseDrain {
			t.Fatalf("interrupt disable: result=%+v err=%v", result, err)
		}
		store.replayed = true
		store.drainBlocked = false
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseNetworkFence, nil,
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
		if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
			t.Fatalf("interrupt enable: result=%+v err=%v", result, err)
		}
		store.replayed = true
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseRuntimeEnable,
			[]string{"egress.ensure"},
		)
	})

	t.Run("delete", func(t *testing.T) {
		base := deleteAgentBase(domain.AgentAvailable)
		store := &deleteLifecycleStoreStub{base: base, drainBlocked: true}
		dependencies := newDeleteDependencies(base.Agent)
		dependencies.runtime = ports.RuntimeOperation{State: "running"}
		service := NewLifecycleService(
			lifecycleSpecSourceStub{}, store, dependencies, dependencies,
			fixedClock{now: time.Unix(700, 0).UTC()},
		)
		result, err := service.DeleteAgent(context.Background(), DeleteAgentInput{
			RequestID: "request-worker-delete", AgentID: base.Agent.AgentID,
		})
		if err != nil || result.Operation.Phase != domain.PhaseDrain {
			t.Fatalf("interrupt delete: result=%+v err=%v", result, err)
		}
		store.replayed = true
		store.drainBlocked = false
		dependencies.calls = nil
		runClaimedLifecycleRecovery(
			t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
				return &store.state.Operation
			}}, &store.state.Operation, func() []string { return dependencies.calls },
			domain.PhaseNetworkFence, nil,
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
			AttemptTimeout: time.Second,
			LeaseDuration:  2 * time.Second, RetryMax: 2 * time.Second,
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

func (store *claimingRecoveryStore) QuarantineLifecycleRecoveryClaim(
	_ context.Context, _ ports.QuarantineLifecycleRecoveryClaim,
) error {
	return nil
}

func TestCreateLifecycleRecoveryAdvancesOneDurablePhasePerClaim(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
	}
	service := newLifecycleTestService(t, store, dependencies)
	result, err := service.CreateAgent(
		context.Background(), lifecycleCreateInput("request-recovery-create"),
	)
	if err != nil || result.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("start recoverable create: result=%+v err=%v", result, err)
	}
	store.replayed = true
	dependencies.runtime = readyRecoveryRuntime("created")
	dependencies.networkIndex = 0
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseRuntimeInitialize, domain.OperationRunning, false, []string{"egress.ensure"}},
		{domain.PhasePublish, domain.OperationRunning, false, []string{"runtime.initialize"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, []string{"egress.attachment.open"}},
	}
	assertLifecycleRecoveryPlan(t, domain.OperationCreate, steps)
	for _, step := range steps {
		resumeLifecycleRecoveryStep(
			t, service, &store.beginState.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestRebuildLifecycleRecoveryAdvancesOneDurablePhasePerClaim(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base, drainBlocked: true}
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
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted rebuild = %+v", result.Operation)
	}
	store.replayed = true
	store.drainBlocked = false
	dependencies.runtime = readyRecoveryRuntime("rebuilt")
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkFence, domain.OperationRunning, false, nil},
		{domain.PhaseRuntimeUpdate, domain.OperationRunning, false,
			[]string{"egress.get", "egress.attachment.closed"}},
		{domain.PhaseNetworkEnsure, domain.OperationRunning, false,
			[]string{"runtime.update"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.attachment.open"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleRecoveryPlan(t, domain.OperationRebuild, steps)
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
	store := &disableLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "running"})
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.DisableAgent(
		context.Background(),
		DisableAgentInput{RequestID: "request-recovery-disable", AgentID: base.Agent.AgentID},
	)
	if err != nil {
		t.Fatalf("start recoverable disable: %v", err)
	}
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted disable = %+v", result.Operation)
	}
	store.replayed = true
	store.drainBlocked = false
	dependencies.runtime = ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: base.Agent.RuntimeRevision,
		LifecycleState: "disabled", Health: "absent",
	}
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkFence, domain.OperationRunning, false, nil},
		{domain.PhaseRuntimeDisable, domain.OperationRunning, false,
			[]string{"egress.get", "egress.attachment.closed"}},
		{domain.PhasePublish, domain.OperationRunning, false, []string{"runtime.disable"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleRecoveryPlan(t, domain.OperationDisable, steps)
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
	if result.Operation.Phase != domain.PhaseNetworkEnsure || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted enable = %+v", result.Operation)
	}
	store.replayed = true
	dependencies.runtime = readyEnableRuntime()
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseRuntimeEnable, domain.OperationRunning, false,
			[]string{"egress.ensure"}},
		{domain.PhaseNetworkRestore, domain.OperationRunning, false, []string{"runtime.enable"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.attachment.open"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleRecoveryPlan(t, domain.OperationEnable, steps)
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
	store := &deleteLifecycleStoreStub{base: base, drainBlocked: true}
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
	if result.Operation.Phase != domain.PhaseDrain || result.Operation.State != domain.OperationRunning {
		t.Fatalf("interrupted delete = %+v", result.Operation)
	}
	store.replayed = true
	store.drainBlocked = false
	dependencies.runtime = ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_99999999999999999999999999999999",
		LifecycleState:  "deleted", Health: "absent",
	}
	dependencies.calls = nil

	steps := []lifecycleRecoveryStepExpectation{
		{domain.PhaseNetworkFence, domain.OperationRunning, false, nil},
		{domain.PhaseRuntimeDelete, domain.OperationRunning, false,
			[]string{"egress.network.get", "egress.attachment.closed"}},
		{domain.PhaseNetworkRelease, domain.OperationRunning, false, []string{"runtime.delete"}},
		{domain.PhasePublish, domain.OperationRunning, false,
			[]string{"egress.network.get", "egress.release"}},
		{domain.PhaseCompleted, domain.OperationCompleted, true, nil},
	}
	assertLifecycleRecoveryPlan(t, domain.OperationDelete, steps)
	for _, step := range steps {
		resumeLifecycleRecoveryStep(
			t, service, &store.state.Operation, func() []string { return dependencies.calls },
			step.phase, step.state, step.terminal, step.calls,
		)
	}
}

func TestRebuildRecoveryRetriesAttachmentCloseAfterFailure(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	base := rebuildLifecycleBase(t, template, model)
	store := &rebuildLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := &rebuildDependenciesStub{
		network: validLifecycleNetwork(), runtime: ports.RuntimeOperation{State: "running"},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(100, 0).UTC()},
	)
	result, err := service.RebuildAgent(context.Background(), RebuildAgentInput{
		RequestID: "request-recovery-rebuild-close", AgentID: base.Agent.AgentID,
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil || result.Operation.Phase != domain.PhaseDrain {
		t.Fatalf("start attachment recovery rebuild: result=%+v err=%v", result, err)
	}
	store.replayed = true
	store.drainBlocked = false
	runClaimedLifecycleRecovery(
		t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
			return &store.state.Operation
		}}, &store.state.Operation, func() []string { return dependencies.calls },
		domain.PhaseNetworkFence, nil,
	)

	dependencies.calls = nil
	dependencies.fenceErr = errors.New("fence response lost")
	runClaimedLifecycleRecovery(
		t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
			return &store.state.Operation
		}}, &store.state.Operation, func() []string { return dependencies.calls },
		domain.PhaseNetworkFence, []string{"egress.get", "egress.attachment.closed"},
	)

	dependencies.calls = nil
	dependencies.fenceErr = nil
	runClaimedLifecycleRecovery(
		t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
			return &store.state.Operation
		}}, &store.state.Operation, func() []string { return dependencies.calls },
		domain.PhaseRuntimeUpdate, []string{"egress.get", "egress.attachment.closed"},
	)
}

func TestDisableRecoveryRetriesAttachmentCloseAfterFailure(t *testing.T) {
	t.Parallel()

	base := disableLifecycleBase(t)
	store := &disableLifecycleStoreStub{base: base, drainBlocked: true}
	dependencies := newDisableDependencies(base, ports.RuntimeOperation{State: "running"})
	service := newLifecycleTestService(t, store, dependencies)
	result, err := service.DisableAgent(context.Background(), DisableAgentInput{
		RequestID: "request-recovery-disable-close", AgentID: base.Agent.AgentID,
	})
	if err != nil || result.Operation.Phase != domain.PhaseDrain {
		t.Fatalf("start attachment recovery disable: result=%+v err=%v", result, err)
	}
	store.replayed = true
	store.drainBlocked = false
	runClaimedLifecycleRecovery(
		t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
			return &store.state.Operation
		}}, &store.state.Operation, func() []string { return dependencies.calls },
		domain.PhaseNetworkFence, nil,
	)

	dependencies.calls = nil
	dependencies.fenceErr = errors.New("fence response lost")
	runClaimedLifecycleRecovery(
		t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
			return &store.state.Operation
		}}, &store.state.Operation, func() []string { return dependencies.calls },
		domain.PhaseNetworkFence, []string{"egress.get", "egress.attachment.closed"},
	)

	dependencies.calls = nil
	dependencies.fenceErr = nil
	runClaimedLifecycleRecovery(
		t, service, &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
			return &store.state.Operation
		}}, &store.state.Operation, func() []string { return dependencies.calls },
		domain.PhaseRuntimeDisable, []string{"egress.get", "egress.attachment.closed"},
	)
}

type lifecycleRecoveryStepExpectation struct {
	phase    domain.OperationPhase
	state    domain.OperationState
	terminal bool
	calls    []string
}

func assertLifecycleRecoveryPlan(
	t *testing.T, kind domain.OperationKind, steps []lifecycleRecoveryStepExpectation,
) {
	t.Helper()
	plan, err := domain.OperationPlan(kind)
	if err != nil {
		t.Fatalf("load %s operation plan: %v", kind, err)
	}
	want := append(slices.Clone(plan[1:]), domain.PhaseCompleted)
	got := make([]domain.OperationPhase, 0, len(steps))
	for _, step := range steps {
		got = append(got, step.phase)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("%s recovery phases = %v, want operation plan continuation %v", kind, got, want)
	}
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
	recoveryStore := &claimingRecoveryStore{operation: func() *ports.LifecycleOperationRecord {
		return operation
	}}
	worker, err := NewLifecycleRecoveryWorker(
		recoveryStore, service, nil,
		LifecycleRecoveryWorkerConfig{
			WorkerID: "recovery-worker", PollInterval: 10 * time.Millisecond,
			AttemptTimeout: time.Second,
			LeaseDuration:  2 * time.Second, RetryMax: 2 * time.Second,
		},
	)
	if err != nil {
		t.Fatalf("create %s recovery worker: %v", operation.Kind, err)
	}
	processed, err := worker.RunOnce(context.Background())
	if err != nil || !processed {
		t.Fatalf("resume %s at %s: processed=%v err=%v", operation.Kind, operation.Phase, processed, err)
	}
	if !wantTerminal {
		wantChildRequestID := domain.ChildRequestID(operation.RequestID, wantPhase)
		if operation.ChildRequestID != wantChildRequestID {
			t.Fatalf(
				"recovered %s child request = %q, want %q",
				operation.Kind, operation.ChildRequestID, wantChildRequestID,
			)
		}
	}
	assertRecoveryBoundary(
		t,
		OperationView{Phase: operation.Phase, State: operation.State},
		wantPhase,
		wantState,
		dependencyCalls()[before:],
		wantCalls,
	)
	if !recoveryStore.started || (!wantTerminal && !recoveryStore.released) {
		t.Fatalf(
			"%s recovery claim lifecycle started=%v released=%v terminal=%v",
			operation.Kind, recoveryStore.started, recoveryStore.released, wantTerminal,
		)
	}
	if operation.RecoveryOwner != "" || operation.RecoveryLeaseUntil != nil {
		t.Fatalf("recovery retained reservation: %+v", *operation)
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
			AttemptTimeout: 30 * time.Second,
			LeaseDuration:  45 * time.Second, RetryMax: time.Minute,
		},
	)
	if err != nil {
		t.Fatalf("create recovery worker: %v", err)
	}
	return worker
}

type recoveryStoreStub struct {
	claimInput        ports.ClaimLifecycleRecovery
	claim             ports.LifecycleRecoveryClaim
	found             bool
	claimErr          error
	started           ports.StartLifecycleRecoveryAttempt
	startErr          error
	released          ports.ReleaseLifecycleRecoveryClaim
	releaseErr        error
	releaseContextErr error
	quarantined       ports.QuarantineLifecycleRecoveryClaim
	quarantineErr     error
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
	ctx context.Context, input ports.ReleaseLifecycleRecoveryClaim,
) error {
	store.released = input
	store.releaseContextErr = ctx.Err()
	return store.releaseErr
}

func (store *recoveryStoreStub) QuarantineLifecycleRecoveryClaim(
	_ context.Context, input ports.QuarantineLifecycleRecoveryClaim,
) error {
	store.quarantined = input
	return store.quarantineErr
}

type recoveryResumerStub struct {
	operation ports.LifecycleOperationRecord
	result    LifecycleRecoveryResult
	err       error
	token     ports.LifecycleRecoveryToken
	hasToken  bool
	cancel    context.CancelFunc
}

func (resumer *recoveryResumerStub) ResumeLifecycleOperation(
	ctx context.Context, operation ports.LifecycleOperationRecord,
) (LifecycleRecoveryResult, error) {
	resumer.operation = operation
	resumer.token, resumer.hasToken = ports.LifecycleRecoveryTokenFromContext(ctx)
	if resumer.cancel != nil {
		resumer.cancel()
	}
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
