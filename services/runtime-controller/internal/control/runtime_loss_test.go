package control

import (
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRuntimeLossQueriesRepresentAbsenceWithoutLosingLogicalIdentity(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)
	_, err := service.InitializeRuntime(context.Background(), "init-loss", "agent-1", lifecycleConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	before := repository.environments["agent-1"]
	delete(platform.containers, "agent-1")
	mutations := platform.mutationCalls()
	events := len(repository.observations)
	absent, err := service.InspectRuntime(context.Background(), "agent-1")
	if err != nil || absent.AgentID != before.AgentID || absent.RuntimeRevision != before.RuntimeRevision ||
		absent.LifecycleState != deployment.LifecycleProvisioned || absent.Health != deployment.HealthAbsent ||
		absent.MCPEndpoint != "" || absent.RuntimeExecutionID != "" {
		t.Fatalf("absence mistaken for drift or stale endpoint retained: %+v error=%v", absent, err)
	}
	list, err := service.ListRuntimes(context.Background())
	if err != nil || len(list) != 1 || !reflect.DeepEqual(list[0], absent) {
		t.Fatalf("logical List cannot reconstruct missing Runtime: %+v error=%v", list, err)
	}
	if platform.mutationCalls() != mutations || len(repository.observations) != events ||
		!reflect.DeepEqual(repository.environments["agent-1"], before) {
		t.Fatal("inspection mutated resources, logical head or observation journal")
	}
}

func TestRuntimeLossReconciliationRechecksStaleInventory(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := newLifecyclePlatform()
	service := newLifecycleService(t, repository, platform)
	// Inventory was captured before this lifecycle command created its container.
	staleInventory := []deployment.Inspection{}
	if _, err := service.InitializeRuntime(context.Background(), "init-race", "agent-1", lifecycleConfiguration()); err != nil {
		t.Fatal(err)
	}
	before := len(repository.observations)
	if err := service.ReconcileExpectedRuntimes(context.Background(), staleInventory); err != nil {
		t.Fatal(err)
	}
	if len(repository.observations) != before {
		t.Fatalf("newly created Runtime falsely reported missing: %+v", repository.observations[before:])
	}
}

func TestRuntimeLossDoesNotTurnInspectionFailureIntoAbsence(t *testing.T) {
	t.Parallel()
	for _, failure := range []error{errors.New("platform unavailable"), deployment.ErrIdentityConflict} {
		t.Run(failure.Error(), func(t *testing.T) {
			repository := newLifecycleRepository()
			platform := &recoveryPlatform{lifecyclePlatform: newLifecyclePlatform()}
			service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{},
				func() time.Time { return lifecycleNow }, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.InitializeRuntime(context.Background(), "init-loss", "agent-1", lifecycleConfiguration()); err != nil {
				t.Fatal(err)
			}
			platform.inspectErr = failure
			before := len(repository.observations)
			if _, err := service.ListRuntimes(context.Background()); !errors.Is(err, failure) {
				t.Fatalf("List inspection error=%v", err)
			}
			if err := service.ReconcileExpectedRuntimes(context.Background(), nil); !errors.Is(err, failure) {
				t.Fatalf("reconciliation fabricated absence: %v", err)
			}
			if len(repository.observations) != before {
				t.Fatal("failed inspection emitted missing event")
			}
		})
	}
}

func TestRuntimeLossRejectsContradictoryAbsentInspection(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		change func(*deployment.Inspection)
	}{
		{"wrong_agent", func(i *deployment.Inspection) { i.AgentID = "foreign" }},
		{"wrong_generation", func(i *deployment.Inspection) { i.Generation++ }},
		{"wrong_phase", func(i *deployment.Inspection) { i.PlatformPhase = deployment.PhaseRunning }},
		{"wrong_health", func(i *deployment.Inspection) { i.Health = deployment.HealthUnknown }},
		{"digest_present", func(i *deployment.Inspection) { i.SpecDigest = lifecycleDigest }},
		{"endpoint_present", func(i *deployment.Inspection) { i.MCPEndpoint = "http://stale/mcp" }},
		{"status_endpoint_present", func(i *deployment.Inspection) { i.StatusEndpoint = "http://stale/status" }},
		{"execution_present", func(i *deployment.Inspection) { i.RuntimeExecutionID = "stale-process" }},
		{"platform_resource_id_present", func(i *deployment.Inspection) { i.PlatformResourceID = "still-present" }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			repository := newLifecycleRepository()
			platform := &recoveryPlatform{lifecyclePlatform: newLifecyclePlatform()}
			service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, lifecycleVerifier{},
				func() time.Time { return lifecycleNow }, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := service.InitializeRuntime(context.Background(), "init-loss", "agent-1", lifecycleConfiguration()); err != nil {
				t.Fatal(err)
			}
			inspection := deployment.Inspection{
				AgentID: "agent-1", Generation: repository.environments["agent-1"].Generation,
				PlatformPhase: deployment.PhaseAbsent, Health: deployment.HealthAbsent,
			}
			test.change(&inspection)
			platform.inspection = &inspection
			before := len(repository.observations)
			if _, err := service.ListRuntimes(context.Background()); err == nil {
				t.Fatal("List accepted contradictory absence")
			}
			if err := service.ReconcileExpectedRuntimes(context.Background(), nil); err == nil {
				t.Fatal("reconciliation accepted contradictory absence")
			}
			if len(repository.observations) != before {
				t.Fatal("contradictory absence emitted an event")
			}
		})
	}
}

func TestRuntimeLossPresentResourceStillRequiresDigestAndClaim(t *testing.T) {
	t.Parallel()
	for _, mismatch := range []string{"digest", "missing_claim", "claim_digest"} {
		t.Run(mismatch, func(t *testing.T) {
			repository := newLifecycleRepository()
			platform := newLifecyclePlatform()
			service := newLifecycleService(t, repository, platform)
			if _, err := service.InitializeRuntime(context.Background(), "init-loss", "agent-1", lifecycleConfiguration()); err != nil {
				t.Fatal(err)
			}
			inspection := platform.containers["agent-1"]
			key := inspection.RuntimeKey()
			switch mismatch {
			case "digest":
				inspection.SpecDigest = lifecycleDigest
				platform.containers["agent-1"] = inspection
			case "missing_claim":
				delete(repository.claims, key)
			case "claim_digest":
				claim := repository.claims[key]
				claim.SpecDigest = lifecycleDigest
				repository.claims[key] = claim
			}
			before := len(repository.observations)
			if _, err := service.ListRuntimes(context.Background()); !errors.Is(err, ErrDrift) {
				t.Fatalf("List bypassed identity validation: %v", err)
			}
			if err := service.ReconcileExpectedRuntimes(context.Background(), nil); !errors.Is(err, ErrDrift) {
				t.Fatalf("reinspection bypassed identity validation: %v", err)
			}
			if len(repository.observations) != before {
				t.Fatal("identity conflict emitted missing event")
			}
		})
	}
}

type runtimeLossProbe struct {
	*lifecyclePlatform
	keys          []deployment.Key
	verifications int
}

func (p *runtimeLossProbe) Inspect(ctx context.Context, key deployment.Key) (deployment.Inspection, error) {
	p.keys = append(p.keys, key)
	if err := ctx.Err(); err != nil {
		return deployment.Inspection{}, err
	}
	return p.lifecyclePlatform.Inspect(ctx, key)
}

func (p *runtimeLossProbe) Verify(ctx context.Context, value deployment.Inspection) (deployment.Inspection, error) {
	p.verifications++
	return (lifecycleVerifier{}).Verify(ctx, value)
}

func TestRuntimeLossReinspectionIsBoundedReadOnlyAndCancellable(t *testing.T) {
	t.Parallel()
	repository := newLifecycleRepository()
	platform := &runtimeLossProbe{lifecyclePlatform: newLifecyclePlatform()}
	service, err := NewService(repository, repository, lifecycleObservationReadiness{}, platform, platform,
		func() time.Time { return lifecycleNow }, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.InitializeRuntime(context.Background(), "init-loss", "agent-1", lifecycleConfiguration()); err != nil {
		t.Fatal(err)
	}
	expected := platform.containers["agent-1"].RuntimeKey()
	platform.keys = nil
	beforeMutations, beforeVerifications := platform.mutationCalls(), platform.verifications
	if err := service.ReconcileExpectedRuntimes(context.Background(), nil); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(platform.keys, []deployment.Key{expected}) || platform.mutationCalls() != beforeMutations ||
		platform.verifications != beforeVerifications {
		t.Fatal("missing candidate probe was not one read-only exact-key inspection")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := service.ReconcileExpectedRuntimes(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation not propagated to inspection: %v", err)
	}
	if len(repository.observations) != 1 {
		t.Fatal("cancelled reinspection emitted a false event")
	}
}
