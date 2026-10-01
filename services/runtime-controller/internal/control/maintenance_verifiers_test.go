package control

import (
	"context"
	"encoding/base64"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestAcceptedMaintenanceKeysRemainFrozenAcrossRecovery(t *testing.T) {
	ctx := context.Background()
	repo := newLifecycleRepository()
	driver := newLifecyclePlatform()
	service := newLifecycleService(t, repo, driver)
	configuration := lifecycleConfiguration()
	key := func(kid string, firstByte byte) deployment.MaintenanceVerifiers {
		bytes := make([]byte, 32)
		bytes[0] = firstByte
		return deployment.MaintenanceVerifiers{Keys: []deployment.MaintenanceVerifierKey{{
			KID: kid, Algorithm: "Ed25519",
			PublicKeyBase64URL: base64.RawURLEncoding.EncodeToString(bytes),
		}}}
	}
	oldKeys := key("old", 1)
	newKeys := key("new", 2)
	if err := service.SetMaintenanceVerifiers(oldKeys); err != nil {
		t.Fatal(err)
	}
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectUnknown, Code: "platform_unavailable"}
	first, err := service.InitializeRuntime(ctx, "key-build-1", "agent-1", configuration)
	if err != nil || first.State != deployment.OperationUnknown {
		t.Fatalf("first build: %+v %v", first, err)
	}
	if first.MaintenanceVerifiers == nil || first.MaintenanceVerifiers.Keys[0].KID != "old" {
		t.Fatalf("accepted key snapshot missing: %+v", first.MaintenanceVerifiers)
	}
	if err := service.SetMaintenanceVerifiers(newKeys); err != nil {
		t.Fatal(err)
	}
	driver.createOutcome = deployment.EffectOutcome{State: deployment.EffectCompleted}
	recovered, err := service.InitializeRuntime(ctx, "key-build-1", "agent-1", configuration)
	if err != nil || recovered.State != deployment.OperationCompleted {
		t.Fatalf("recovery after rotation: %+v %v", recovered, err)
	}
	if len(driver.deployments) != 2 ||
		driver.deployments[0].RuntimeSpec.SkillMaintenanceVerifiers.Keys[0].KID != "old" ||
		driver.deployments[1].RuntimeSpec.SkillMaintenanceVerifiers.Keys[0].KID != "old" {
		t.Fatalf("accepted deployment used mutable verifier config: %+v", driver.deployments)
	}
	persisted, err := repo.GetOperation(ctx, "key-build-1")
	if err != nil || persisted.MaintenanceVerifiers == nil || persisted.MaintenanceVerifiers.Keys[0].KID != "old" {
		t.Fatalf("key snapshot not persisted: %+v %v", persisted, err)
	}
	updated, err := service.UpdateRuntime(ctx, "key-build-2", "agent-1", recovered.RuntimeRevision, configuration)
	if err != nil || updated.State != deployment.OperationCompleted ||
		driver.deployments[2].RuntimeSpec.SkillMaintenanceVerifiers.Keys[0].KID != "new" {
		t.Fatalf("new operation did not use new keys: %+v %v", updated, err)
	}
}
