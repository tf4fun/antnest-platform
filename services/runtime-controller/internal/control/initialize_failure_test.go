package control

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestFailedInitializeRetainsDeletableOwnedEnvironment(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	platform.createOutcome = deployment.EffectOutcome{State: deployment.EffectNotStarted, Code: "platform_unavailable"}
	service := newLifecycleService(t, repository, platform)
	operation, err := service.InitializeRuntime(context.Background(), "init-failed", "agent-1", lifecycleConfiguration())
	if err != nil || operation.State != deployment.OperationFailed {
		t.Fatalf("initialize: %+v %v", operation, err)
	}
	environment, err := service.InspectRuntime(context.Background(), "agent-1")
	if err != nil || environment.LifecycleState != "failed" || environment.RuntimeRevision != operation.RuntimeRevision || environment.OperationID != "" {
		t.Fatalf("lost failed resource ownership: %+v %v", environment, err)
	}
	before := platform.mutationCalls()
	if _, err := service.InitializeRuntime(context.Background(), "init-failed", "agent-1", lifecycleConfiguration()); err != nil || platform.mutationCalls() != before {
		t.Fatalf("terminal retry repeated work: %v", err)
	}
	if _, err := service.InitializeRuntime(context.Background(), "init-new", "agent-1", lifecycleConfiguration()); !errors.Is(err, ErrLifecycleConflict) {
		t.Fatalf("fresh Initialize overwrote failed ownership: %v", err)
	}
	if _, err := service.DeleteRuntime(context.Background(), "delete-stale", "agent-1", lifecycleRevision); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale delete revision accepted: %v", err)
	}
	deleted, err := service.DeleteRuntime(context.Background(), "delete-failed", "agent-1", environment.RuntimeRevision)
	if err != nil || deleted.State != deployment.OperationCompleted || platform.deleteCalls != 1 || platform.deleteStorageCalls != 1 {
		t.Fatalf("failed Runtime cleanup: %+v %v compute=%d storage=%d", deleted, err, platform.deleteCalls, platform.deleteStorageCalls)
	}
}

type identityConflictPlatform struct {
	*lifecyclePlatform
	inspectionErr error
}

func (p identityConflictPlatform) Inspect(context.Context, deployment.Key) (deployment.Inspection, error) {
	return deployment.Inspection{}, p.inspectionErr
}

func TestInitializeCompletionDoesNotDependOnLaterIdentityInspection(t *testing.T) {
	t.Parallel()
	for _, wrapped := range []bool{false, true} {
		t.Run(fmt.Sprintf("wrapped=%t", wrapped), func(t *testing.T) {
			repository := newLifecycleRepository()
			conflict := deployment.ErrIdentityConflict
			if wrapped {
				conflict = fmt.Errorf("inspect: %w", conflict)
			}
			platform := identityConflictPlatform{lifecyclePlatform: newLifecyclePlatform(), inspectionErr: conflict}
			service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{}, time.Now, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			operation, err := service.InitializeRuntime(context.Background(), "init-conflict", "agent-1", lifecycleConfiguration())
			if err != nil || operation.State != deployment.OperationCompleted {
				t.Fatalf("post-create inspection changed completion: %+v %v", operation, err)
			}
			environment := requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleProvisioned)
			if environment.OperationID != "" {
				t.Fatalf("creation retained mutation owner: %+v", environment)
			}
			if _, err := service.InspectRuntime(context.Background(), "agent-1"); !errors.Is(err, deployment.ErrIdentityConflict) {
				t.Fatalf("independent inspection lost identity conflict: %v", err)
			}
		})
	}
}

type unavailableVerifier struct{}

func (unavailableVerifier) Verify(context.Context, deployment.Inspection) (deployment.Inspection, error) {
	return deployment.Inspection{}, errors.New("runtime not serving MCP yet")
}

type cancelAfterCreatePlatform struct {
	*lifecyclePlatform
	cancel context.CancelFunc
}

func (p cancelAfterCreatePlatform) Create(ctx context.Context, value deployment.Deployment, digest string) deployment.EffectOutcome {
	outcome := p.lifecyclePlatform.Create(ctx, value, digest)
	p.cancel()
	return outcome
}

func (p cancelAfterCreatePlatform) Inspect(ctx context.Context, key deployment.Key) (deployment.Inspection, error) {
	if err := ctx.Err(); err != nil {
		return deployment.Inspection{}, err
	}
	return p.lifecyclePlatform.Inspect(ctx, key)
}

func TestInitializeCancellationAfterConfirmedCreateCommitsCompletion(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	repository := newLifecycleRepository()
	platform := cancelAfterCreatePlatform{lifecyclePlatform: newLifecyclePlatform(), cancel: cancel}
	service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{}, time.Now, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	operation, err := service.InitializeRuntime(ctx, "init-cancel", "agent-1", lifecycleConfiguration())
	if err != nil || operation.State != deployment.OperationCompleted || operation.Effect != deployment.EffectCompleted {
		t.Fatalf("confirmed creation did not finalize after caller cancellation: %+v %v", operation, err)
	}
	environment := requireLifecycleEnvironment(t, repository, "agent-1", deployment.LifecycleProvisioned)
	if environment.OperationID != "" || platform.createCalls != 1 || platform.deleteCalls != 0 || platform.deleteStorageCalls != 0 {
		t.Fatalf("cancelled creation lost ownership or rolled back resources: %+v %+v", environment, platform)
	}
	if _, err := service.DeleteRuntime(context.Background(), "delete-cancel", "agent-1", environment.RuntimeRevision); err != nil {
		t.Fatalf("confirmed creation blocked deletion: %v", err)
	}
}

func TestConfirmedCreateDoesNotConsultReadinessEvenWhenCallerCancelled(t *testing.T) {
	t.Parallel()
	for _, cancelled := range []bool{false, true} {
		t.Run(map[bool]string{false: "deadline", true: "cancelled"}[cancelled], func(t *testing.T) {
			repository := newLifecycleRepository()
			platform := newLifecyclePlatform()
			service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, unavailableVerifier{}, time.Now, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			ctx := context.Background()
			if cancelled {
				cancelledCtx, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelledCtx
			}
			operation := deployment.Operation{Kind: deployment.OperationInitializeRuntime, AgentID: "agent-1", RequestID: "init-readiness", RequestDigest: lifecycleDigest,
				RuntimeRevision: lifecycleRevision, Generation: 1, SpecDigest: lifecycleDigest, SourceState: deployment.LifecycleUninitialized, Transition: deployment.LifecycleInitializing, Attempt: 1}
			operation, _, err = repository.BeginTransition(context.Background(), operation)
			if err != nil {
				t.Fatal(err)
			}
			physical, err := lifecycleConfiguration().Resolve("agent-1", 1)
			if err != nil {
				t.Fatal(err)
			}
			result, err := service.createRuntime(ctx, operation, physical, false)
			if err != nil {
				t.Fatal(err)
			}
			if result.State != deployment.OperationCompleted || result.ErrorCode != "" || platform.deleteCalls != 0 || platform.deleteStorageCalls != 0 {
				t.Fatalf("readiness failure classification: %+v", result)
			}
		})
	}
}
