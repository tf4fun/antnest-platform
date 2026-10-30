package docker

import (
	"context"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func quotaDriver(t *testing.T, engine *fakeEngine) *Driver {
	t.Helper()
	driver, err := NewDriver(engine, Config{
		ControllerScope: "test-controller", ManagementNetwork: "antnest-runtime-management",
		SystemSkillsVolume: "antnest-system-skills", ResolverMountGate: &fakeResolverGate{},
		WorkspaceVolumeDriver: "example-quota", WorkspaceQuotaOption: "size",
	})
	if err != nil {
		t.Fatal(err)
	}
	return driver
}

func quotaWorkspaceVolume(labels map[string]string) Volume {
	return Volume{
		Name: "antnest-workspace-agent-1", Driver: "example-quota",
		Options: map[string]string{"size": "10737418240"},
		Labels:  labels,
	}
}

func ownedQuotaLabels() map[string]string {
	return map[string]string{
		labelManaged: "workspace", labelScope: "test-controller", labelAgentID: "agent-1",
		"io.antnest.workspace-bytes": "10737418240",
	}
}

func TestQuotaEnsureStorageCreatesDriverOptionsAndByteLabel(t *testing.T) {
	engine := newFakeEngine()
	delete(engine.volumes, "antnest-workspace-agent-1")
	driver := quotaDriver(t, engine)

	outcome := driver.EnsureStorage(context.Background(), "agent-1", testDeployment().Resources)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("quota ensure storage: %+v", outcome)
	}
	if engine.createQuotaDriver != "example-quota" ||
		engine.createQuotaOptions["size"] != "10737418240" {
		t.Fatalf("quota volume was not created with the configured backend: %+v", engine)
	}
	volume := engine.volumes["antnest-workspace-agent-1"]
	if volume.Labels["io.antnest.workspace-bytes"] != "10737418240" {
		t.Fatalf("byte limit label missing: %+v", volume.Labels)
	}
}

func TestQuotaEnsureStorageRejectsReturnedBackendMismatch(t *testing.T) {
	for _, test := range []struct {
		name    string
		mutate  func(*Volume)
		wantErr string
	}{
		{"wrong_driver", func(v *Volume) { v.Driver = "other-driver" }, ""},
		{"local_driver", func(v *Volume) { v.Driver = "local" }, ""},
		{"wrong_option", func(v *Volume) { v.Options["size"] = "1" }, ""},
		{"missing_label", func(v *Volume) { delete(v.Labels, "io.antnest.workspace-bytes") }, ""},
		{"out_of_range_label", func(v *Volume) { v.Labels["io.antnest.workspace-bytes"] = "0" }, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := newFakeEngine()
			volume := quotaWorkspaceVolume(ownedQuotaLabels())
			test.mutate(&volume)
			engine.volumes["antnest-workspace-agent-1"] = volume
			driver := quotaDriver(t, engine)

			outcome := driver.EnsureStorage(context.Background(), "agent-1", testDeployment().Resources)
			if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_ownership_conflict" {
				t.Fatalf("%s must conflict instead of being adopted: %+v", test.name, outcome)
			}
		})
	}
}

func TestQuotaVerifyStorageChecksRequestedBytesWhenPresent(t *testing.T) {
	engine := newFakeEngine()
	engine.volumes["antnest-workspace-agent-1"] = quotaWorkspaceVolume(ownedQuotaLabels())
	driver := quotaDriver(t, engine)

	if outcome := driver.VerifyStorage(context.Background(), "agent-1"); outcome.State != deployment.EffectCompleted {
		t.Fatalf("verify without limits: %+v", outcome)
	}
	if outcome := driver.VerifyStorage(context.Background(), "agent-1", testDeployment().Resources); outcome.State != deployment.EffectCompleted {
		t.Fatalf("verify matching limits: %+v", outcome)
	}
	resources := testDeployment().Resources
	smaller := uint64(67108864)
	resources.WorkspaceBytes = &smaller
	outcome := driver.VerifyStorage(context.Background(), "agent-1", resources)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_ownership_conflict" {
		t.Fatalf("wrong-size existing volume must conflict, not resize: %+v", outcome)
	}
}

func TestDefaultLocalStorageAcceptsEmptyDriverAndRejectsForeignBackend(t *testing.T) {
	engine := newFakeEngine()
	workspace := engine.volumes["antnest-workspace-agent-1"]
	workspace.Options = nil
	engine.volumes["antnest-workspace-agent-1"] = workspace
	driver := newTestDriver(t, engine)

	if outcome := driver.VerifyStorage(context.Background(), "agent-1"); outcome.State != deployment.EffectCompleted {
		t.Fatalf("default local workspace must verify: %+v", outcome)
	}
	engine.volumes["antnest-workspace-agent-1"] = Volume{
		Name: "antnest-workspace-agent-1", Driver: "example-quota",
		Options: map[string]string{"size": "10737418240"},
		Labels:  map[string]string{labelManaged: "workspace", labelScope: "test-controller", labelAgentID: "agent-1"},
	}
	outcome := driver.VerifyStorage(context.Background(), "agent-1")
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "storage_ownership_conflict" {
		t.Fatalf("a quota backend volume must not be treated as default local: %+v", outcome)
	}
}

func TestQuotaDriverReportedForReadiness(t *testing.T) {
	engine := newFakeEngine()
	if newTestDriver(t, engine).DiskQuotaEnforced() {
		t.Fatal("default local backend must report unbounded storage")
	}
	if !quotaDriver(t, engine).DiskQuotaEnforced() {
		t.Fatal("configured quota backend must report enforced storage")
	}
}
