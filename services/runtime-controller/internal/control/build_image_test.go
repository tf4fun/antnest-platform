package control

import (
	"context"
	"errors"
	"strings"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/platform"
)

func TestBuildPinsImageAcrossRecoveryAndResolvesNextBuild(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := newLifecycleRepository()
	driver := newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	configuration := lifecycleConfiguration()
	configuration.ImageRef = "antnest/runtime:latest"
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
	first, err := service.InitializeRuntime(ctx, "build-1", "agent-1", configuration)
	if err != nil || first.State != deployment.OperationUnknown {
		t.Fatalf("interrupted build: %+v %v", first, err)
	}
	driver.imageID = "sha256:" + strings.Repeat("b", 64)
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectCompleted}
	recovered, err := service.InitializeRuntime(ctx, "build-1", "agent-1", configuration)
	if err != nil || recovered.State != deployment.OperationCompleted {
		t.Fatalf("recovered build: %+v %v", recovered, err)
	}
	if driver.resolveCalls != 1 || len(driver.deployments) != 2 {
		t.Fatalf("recovery resolved again: calls=%d deployments=%d", driver.resolveCalls, len(driver.deployments))
	}
	for _, physical := range driver.deployments {
		if physical.ImageRef != lifecycleDigest || physical.ImageReference != configuration.ImageRef {
			t.Fatalf("build used mutable reference or changed image: %s", physical.ImageRef)
		}
	}
	persisted, err := repo.GetOperation(ctx, "build-1")
	if err != nil || persisted.ImageID != lifecycleDigest || persisted.ImageReference != configuration.ImageRef {
		t.Fatalf("build metadata not retained: %+v %v", persisted, err)
	}
	updated, err := service.UpdateRuntime(ctx, "build-2", "agent-1", recovered.RuntimeRevision, configuration)
	if err != nil || updated.State != deployment.OperationCompleted {
		t.Fatalf("new build: %+v %v", updated, err)
	}
	if driver.resolveCalls != 2 || driver.deployments[2].ImageRef != driver.imageID {
		t.Fatalf("new build did not resolve moved tag: %+v", driver.deployments)
	}
	if configuration.ImageRef != "antnest/runtime:latest" {
		t.Fatal("build overwrote caller configuration")
	}
}

func TestMissingBuildImageHasNoPlatformSideEffects(t *testing.T) {
	t.Parallel()
	repo := newLifecycleRepository()
	driver := newLifecyclePlatform()
	driver.resolveError = platform.ErrImageNotFound
	service := newLifecycleService(t, repo, driver)
	_, err := service.InitializeRuntime(context.Background(), "build-1", "agent-1", lifecycleConfiguration())
	if !errors.Is(err, platform.ErrImageNotFound) || driver.mutationCalls() != 0 || len(repo.operations) != 0 {
		t.Fatalf("failed resolution changed state: error=%v mutations=%d operations=%d", err, driver.mutationCalls(), len(repo.operations))
	}
}

func TestRecoveryNeverInventsMissingBuildImageIdentity(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	repo := newLifecycleRepository()
	driver := newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
	first, err := service.InitializeRuntime(ctx, "build-1", "agent-1", lifecycleConfiguration())
	if err != nil {
		t.Fatal(err)
	}
	first.ImageID = ""
	repo.operations[first.RequestID] = first
	_, err = service.InitializeRuntime(ctx, "build-1", "agent-1", lifecycleConfiguration())
	if err == nil || driver.resolveCalls != 1 || driver.createCalls != 1 {
		t.Fatalf("recovery invented image metadata: err=%v resolves=%d creates=%d", err, driver.resolveCalls, driver.createCalls)
	}
}
