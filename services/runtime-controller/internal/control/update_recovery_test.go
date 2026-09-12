package control

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	repositoryport "soft/antnest-platform/services/runtime-controller/internal/repository"
)

// Unlike the permissive lifecycle fixture, this adapter preserves the
// single Agent-named container and rejects a different immutable identity.
type recoveryPlatform struct {
	*lifecyclePlatform
	lostCreate   bool
	lostDelete   bool
	inspectErr   error
	foreignScope bool
	onDelete     func()
	inspection   *deployment.Inspection
	created      int
	removed      int
}

func (p *recoveryPlatform) Inspect(ctx context.Context, key deployment.Key) (deployment.Inspection, error) {
	if p.inspectErr != nil {
		return deployment.Inspection{}, p.inspectErr
	}
	if p.inspection != nil {
		return *p.inspection, nil
	}
	value, err := p.lifecyclePlatform.Inspect(ctx, key)
	if err == nil && value.PlatformPhase != deployment.PhaseAbsent && (value.RuntimeKey() != key || p.foreignScope) {
		return deployment.Inspection{}, deployment.ErrIdentityConflict
	}
	return value, err
}

func (p *recoveryPlatform) Create(ctx context.Context, physical deployment.Deployment, digest string) deployment.EffectOutcome {
	if outcome := p.VerifyStorage(ctx, physical.RuntimeSpec.AgentID); outcome.State != deployment.EffectCompleted {
		return outcome
	}
	key := deployment.Key{AgentID: physical.RuntimeSpec.AgentID, Generation: physical.RuntimeSpec.Generation}
	if existing, ok := p.containers[key.AgentID]; ok {
		if existing.RuntimeKey() != key || existing.SpecDigest != digest || p.foreignScope {
			return deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "runtime_drift"}
		}
		return deployment.EffectOutcome{State: deployment.EffectCompleted}
	}
	outcome := p.lifecyclePlatform.Create(ctx, physical, digest)
	if outcome.State == deployment.EffectCompleted {
		p.created++
		if p.lostCreate {
			p.lostCreate = false
			return deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
		}
	}
	return outcome
}

func (p *recoveryPlatform) Delete(ctx context.Context, key deployment.Key, digest string) deployment.EffectOutcome {
	if p.onDelete != nil {
		p.onDelete()
	}
	if existing, ok := p.containers[key.AgentID]; ok {
		if existing.RuntimeKey() != key || existing.SpecDigest != digest || p.foreignScope {
			return deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "runtime_drift"}
		}
		if p.deleteOutcome.State == deployment.EffectCompleted {
			p.removed++
		}
	}
	outcome := p.lifecyclePlatform.Delete(ctx, key, digest)
	if p.lostDelete && outcome.State == deployment.EffectCompleted {
		p.lostDelete = false
		return deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
	}
	return outcome
}

type completionLossRepository struct {
	*lifecycleRepository
	loseCompletion bool
	loseResponse   bool
}

var errCompletionLost = errors.New("completion write unavailable")

func (r *completionLossRepository) CompleteOperation(ctx context.Context, operation deployment.Operation, observation *deployment.Observation) (*deployment.Observation, error) {
	if r.loseCompletion && operation.Kind == deployment.OperationUpdateRuntime && operation.State == deployment.OperationCompleted {
		r.loseCompletion = false
		return nil, errCompletionLost
	}
	result, err := r.lifecycleRepository.CompleteOperation(ctx, operation, observation)
	if err == nil && r.loseResponse && operation.Kind == deployment.OperationUpdateRuntime && operation.State == deployment.OperationCompleted {
		r.loseResponse = false
		return nil, errCompletionLost
	}
	return result, err
}

type recoveryVerifier struct{ unavailable bool }

func (v *recoveryVerifier) Verify(ctx context.Context, inspection deployment.Inspection) (deployment.Inspection, error) {
	if v.unavailable {
		return deployment.Inspection{}, errors.New("status not yet available")
	}
	return lifecycleVerifier{}.Verify(ctx, inspection)
}

type updateRecoveryFixture struct {
	repository *completionLossRepository
	platform   *recoveryPlatform
	verifier   *recoveryVerifier
	source     deployment.Operation
}

func newUpdateRecoveryFixture(t *testing.T) *updateRecoveryFixture {
	t.Helper()
	f := &updateRecoveryFixture{
		repository: &completionLossRepository{lifecycleRepository: newLifecycleRepository()},
		platform:   &recoveryPlatform{lifecyclePlatform: newLifecyclePlatform()},
		verifier:   &recoveryVerifier{},
	}
	var err error
	f.source, err = f.service(t).InitializeRuntime(context.Background(), "initialize-recovery", "agent-1", lifecycleConfiguration())
	if err != nil || f.source.State != deployment.OperationCompleted {
		t.Fatalf("initialize fixture: %+v %v", f.source, err)
	}
	return f
}

func (f *updateRecoveryFixture) service(t *testing.T) *Service {
	t.Helper()
	service, err := NewService(f.repository, f.repository, lifecycleObservationReadiness{}, f.platform, f.verifier, time.Now, time.Second, 5*time.Millisecond, time.Millisecond)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func (f *updateRecoveryFixture) update(t *testing.T) (deployment.Operation, error) {
	t.Helper()
	return f.service(t).UpdateRuntime(context.Background(), "update-recovery", "agent-1", f.source.RuntimeRevision, lifecycleConfiguration())
}

func (f *updateRecoveryFixture) requireUnresolved(t *testing.T) deployment.Operation {
	t.Helper()
	operation, err := f.repository.GetOperation(context.Background(), "update-recovery")
	if err != nil || operationIsTerminal(operation) {
		t.Fatalf("lost recovery slot: %+v %v", operation, err)
	}
	head, err := f.repository.GetEnvironment(context.Background(), "agent-1")
	if err != nil || head.OperationID != operation.RequestID || head.RuntimeRevision != operation.RuntimeRevision || head.RuntimeRevision == f.source.RuntimeRevision {
		t.Fatalf("destroyed source was restored: %+v %v", head, err)
	}
	_, err = f.service(t).DeleteRuntime(context.Background(), "delete-recovery", "agent-1", head.RuntimeRevision)
	if !errors.Is(err, repositoryport.ErrConcurrentMutation) {
		t.Fatalf("another request bypassed unresolved Update: %v", err)
	}
	return operation
}

func TestUpdateRecoversCreatedTargetWithoutRepeatingPhysicalEffects(t *testing.T) {
	t.Parallel()
	for _, phase := range []string{"create-response", "readiness", "completion-write"} {
		t.Run(phase, func(t *testing.T) {
			f := newUpdateRecoveryFixture(t)
			f.platform.lostCreate = phase == "create-response"
			f.verifier.unavailable = phase == "readiness"
			f.repository.loseCompletion = phase == "completion-write"
			first, err := f.update(t)
			if phase == "completion-write" {
				if !errors.Is(err, errCompletionLost) {
					t.Fatalf("completion failure not injected: %v", err)
				}
			} else if err != nil || first.State != deployment.OperationUnknown {
				t.Fatalf("effect did not become unknown: %+v %v", first, err)
			}
			pending := f.requireUnresolved(t)
			physical := f.platform.containers["agent-1"]
			if physical.RuntimeKey() != pending.RuntimeKey() || physical.SpecDigest != pending.SpecDigest {
				t.Fatalf("target was not created: %+v", physical)
			}
			f.verifier.unavailable = false
			recovered, err := f.update(t)
			if err != nil || recovered.State != deployment.OperationCompleted || recovered.RuntimeRevision != pending.RuntimeRevision || recovered.Generation != 2 {
				t.Fatalf("target retry did not converge: %+v %v", recovered, err)
			}
			if f.platform.containers["agent-1"] != physical || f.platform.created != 2 || f.platform.removed != 1 || f.platform.deleteStorageCalls != 0 || f.platform.ensureStorageCalls != 1 {
				t.Fatalf("recovery repeated compute/workspace effects: %+v", f.platform)
			}
			if len(f.repository.observations) != 2 || f.repository.observations[1].Kind != deployment.ObservationUpdated {
				t.Fatalf("completion event missing/duplicated: %+v", f.repository.observations)
			}
			mutations := f.platform.mutationCalls()
			if _, err := f.update(t); err != nil || f.platform.mutationCalls() != mutations || len(f.repository.observations) != 2 {
				t.Fatalf("terminal retry repeated work: %v", err)
			}
		})
	}
}

func TestUpdateKeepsUnknownWhenDestroyedSourceCannotBeRestored(t *testing.T) {
	t.Parallel()
	for _, drift := range []string{"generation", "digest", "scope", "inspection"} {
		t.Run(drift, func(t *testing.T) {
			f := newUpdateRecoveryFixture(t)
			f.platform.lostCreate = true
			if _, err := f.update(t); err != nil {
				t.Fatal(err)
			}
			physical := f.platform.containers["agent-1"]
			switch drift {
			case "generation":
				physical.Generation++
			case "digest":
				physical.SpecDigest = lifecycleDigest
			case "scope":
				f.platform.foreignScope = true
			case "inspection":
				f.platform.inspectErr = errors.New("platform unavailable")
			}
			f.platform.containers["agent-1"] = physical
			retried, err := f.update(t)
			if err != nil || retried.State != deployment.OperationUnknown {
				t.Fatalf("unproven target classified as unstarted: %+v %v", retried, err)
			}
			f.requireUnresolved(t)
			if f.platform.containers["agent-1"] != physical || f.platform.removed != 1 || f.platform.created != 2 || len(f.repository.observations) != 1 {
				t.Fatalf("foreign/unknown target was mutated or published: %+v", f.platform)
			}
		})
	}
}

func TestUpdateRecoversAfterSourceDeletionWithoutLosingWorkspace(t *testing.T) {
	t.Parallel()
	f := newUpdateRecoveryFixture(t)
	f.platform.lostDelete = true
	first, err := f.update(t)
	if err != nil || first.State != deployment.OperationUnknown || len(f.platform.containers) != 0 {
		t.Fatalf("source deletion failure not injected: %+v %v", first, err)
	}
	f.platform.createOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "platform_unavailable"}
	if _, err := f.update(t); err != nil {
		t.Fatal(err)
	}
	f.requireUnresolved(t)
	f.platform.createOutcome = deployment.EffectOutcome{State: deployment.EffectCompleted}
	result, err := f.update(t)
	if err != nil || result.State != deployment.OperationCompleted || result.RuntimeRevision != first.RuntimeRevision || f.platform.removed != 1 || f.platform.created != 2 || f.platform.ensureStorageCalls != 1 || f.platform.deleteStorageCalls != 0 {
		t.Fatalf("source absence recovery changed resource identity: %+v %v", result, err)
	}
}

func TestUpdateDefiniteSourceDeletionRejectionRetainsSource(t *testing.T) {
	t.Parallel()
	f := newUpdateRecoveryFixture(t)
	physical := f.platform.containers["agent-1"]
	f.platform.deleteOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "platform_unavailable"}
	result, err := f.update(t)
	if err != nil || result.State != deployment.OperationFailed || result.Effect != deployment.EffectNotStarted {
		t.Fatalf("definite pre-effect failure became ambiguous: %+v %v", result, err)
	}
	head := requireLifecycleEnvironment(t, f.repository.lifecycleRepository, "agent-1", deployment.LifecycleReady)
	if head.RuntimeRevision != f.source.RuntimeRevision || head.OperationID != "" || f.platform.containers["agent-1"] != physical || f.platform.removed != 0 || f.platform.created != 1 {
		t.Fatalf("source not retained after definite rejection: %+v", head)
	}
}

func TestUpdateCannotRestoreStoppedOrRacedSourceAfterRejectedDeletion(t *testing.T) {
	t.Parallel()
	for _, scenario := range []string{"stopped-on-earlier-attempt", "replaced-between-inspect-and-delete", "post-delete-inspect-fails", "status-unverified"} {
		t.Run(scenario, func(t *testing.T) {
			f := newUpdateRecoveryFixture(t)
			f.platform.onDelete = func() {
				value := f.platform.containers["agent-1"]
				switch scenario {
				case "stopped-on-earlier-attempt":
					value.PlatformPhase = deployment.PhaseExited
					value.Health = deployment.HealthUnhealthy
				case "replaced-between-inspect-and-delete":
					value.Generation++
				case "post-delete-inspect-fails":
					f.platform.inspectErr = errors.New("inspect failed")
				case "status-unverified":
					f.verifier.unavailable = true
				}
				f.platform.containers["agent-1"] = value
			}
			if scenario == "stopped-on-earlier-attempt" {
				f.platform.deleteOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
				if _, err := f.update(t); err != nil {
					t.Fatal(err)
				}
				f.requireUnresolved(t)
				f.platform.onDelete = nil
			}
			f.platform.deleteOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "platform_unavailable"}
			result, err := f.update(t)
			if err != nil || result.State != deployment.OperationUnknown {
				t.Fatalf("source restored without fresh proof: %+v %v", result, err)
			}
			f.requireUnresolved(t)
			if f.platform.removed != 0 || f.platform.created != 1 {
				t.Fatal("unproven source caused additional mutation")
			}
		})
	}
}

func TestUpdateRejectsMalformedSourceObservations(t *testing.T) {
	t.Parallel()
	for _, malformed := range []deployment.Inspection{
		{},
		{AgentID: "other", Generation: 1, PlatformPhase: deployment.PhaseAbsent, Health: deployment.HealthAbsent},
		{AgentID: "agent-1", Generation: 1, PlatformPhase: deployment.PhaseAbsent, Health: deployment.HealthHealthy},
		{AgentID: "agent-1", Generation: 1, PlatformPhase: deployment.PhaseAbsent, Health: deployment.HealthAbsent, SpecDigest: lifecycleDigest},
		{AgentID: "agent-1", Generation: 1, PlatformPhase: deployment.PhaseUnknown, Health: deployment.HealthUnknown, SpecDigest: lifecycleDigest},
	} {
		f := newUpdateRecoveryFixture(t)
		f.platform.inspection = &malformed
		result, err := f.update(t)
		if err != nil || result.State != deployment.OperationUnknown {
			t.Fatalf("malformed observation treated as presence/absence: %+v %v", result, err)
		}
		f.requireUnresolved(t)
		if f.platform.removed != 0 || f.platform.created != 1 {
			t.Fatal("malformed observation permitted mutation")
		}
	}
}

func TestUpdateCommittedResponseLossReplaysWithoutPlatformWork(t *testing.T) {
	t.Parallel()
	f := newUpdateRecoveryFixture(t)
	f.repository.loseResponse = true
	if _, err := f.update(t); !errors.Is(err, errCompletionLost) {
		t.Fatalf("response loss not injected: %v", err)
	}
	stored, err := f.repository.GetOperation(context.Background(), "update-recovery")
	if err != nil || stored.State != deployment.OperationCompleted {
		t.Fatalf("commit was not durable: %+v %v", stored, err)
	}
	mutations := f.platform.mutationCalls()
	replayed, err := f.update(t)
	if err != nil || replayed.RuntimeRevision != stored.RuntimeRevision || replayed.Attempt != stored.Attempt || f.platform.mutationCalls() != mutations || len(f.repository.observations) != 2 {
		t.Fatalf("committed reply loss repeated work: %+v %v", replayed, err)
	}
}

func TestUpdateRetainedSourceClearsEarlierUnknownTargetInspection(t *testing.T) {
	t.Parallel()
	f := newUpdateRecoveryFixture(t)
	f.platform.inspectErr = errors.New("temporary inspection failure")
	first, err := f.update(t)
	if err != nil || first.State != deployment.OperationUnknown || first.Inspection == nil {
		t.Fatalf("unknown inspection was not recorded: %+v %v", first, err)
	}
	f.platform.inspectErr = nil
	f.platform.deleteOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "platform_unavailable"}
	retained, err := f.update(t)
	if err != nil || retained.State != deployment.OperationFailed || retained.Inspection != nil {
		t.Fatalf("retained source still reports an unknown target: %+v %v", retained, err)
	}
	head := requireLifecycleEnvironment(t, f.repository.lifecycleRepository, "agent-1", deployment.LifecycleReady)
	if head.RuntimeRevision != f.source.RuntimeRevision || head.OperationID != "" {
		t.Fatalf("source not restored: %+v", head)
	}
	stored, err := f.repository.GetOperation(context.Background(), retained.RequestID)
	if err != nil || stored.Inspection != nil {
		t.Fatalf("stale target inspection persisted: %+v %v", stored, err)
	}
	mutations := f.platform.mutationCalls()
	replayed, err := f.update(t)
	if err != nil || replayed.State != deployment.OperationFailed || replayed.Inspection != nil || f.platform.mutationCalls() != mutations {
		t.Fatalf("terminal replay exposes stale target or repeats work: %+v %v", replayed, err)
	}
}

func TestUpdateExistingTargetDoesNotBypassWorkspaceOwnership(t *testing.T) {
	t.Parallel()
	for _, code := range []string{"storage_not_found", "storage_ownership_conflict"} {
		t.Run(code, func(t *testing.T) {
			f := newUpdateRecoveryFixture(t)
			f.platform.lostCreate = true
			if _, err := f.update(t); err != nil {
				t.Fatal(err)
			}
			physical := f.platform.containers["agent-1"]
			f.platform.verifyStorageOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: code}
			failed, err := f.update(t)
			if err != nil || failed.State != deployment.OperationUnknown || failed.ErrorCode != code {
				t.Fatalf("workspace validation was bypassed: %+v %v", failed, err)
			}
			f.requireUnresolved(t)
			if f.platform.containers["agent-1"] != physical || f.platform.created != 2 || f.platform.removed != 1 || f.platform.ensureStorageCalls != 1 || f.platform.deleteStorageCalls != 0 {
				t.Fatal("missing/foreign workspace replaced or target recreated")
			}
		})
	}
}
