package docker

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const containerSecurityContractPath = "../../../../../contracts/runtime/container-security.json"

func contractJSON(t *testing.T) map[string]any {
	t.Helper()
	data, err := os.ReadFile(containerSecurityContractPath)
	if err != nil {
		t.Fatalf("read container security contract: %v", err)
	}
	var contract map[string]any
	if err := json.Unmarshal(data, &contract); err != nil {
		t.Fatalf("decode container security contract: %v", err)
	}
	return contract
}

func contractNumber(t *testing.T, value any, path ...string) float64 {
	t.Helper()
	current := value
	for _, key := range path {
		object, ok := current.(map[string]any)
		if !ok {
			t.Fatalf("contract path %v is not an object", path)
		}
		current = object[key]
	}
	number, ok := current.(float64)
	if !ok {
		t.Fatalf("contract path %v is not a number", path)
	}
	return number
}

func TestStopGraceMatchesTheContainerSecurityContract(t *testing.T) {
	grace := contractNumber(t, contractJSON(t), "shutdown", "stop_grace_seconds")
	if grace != float64(RuntimeStopGraceSeconds) {
		t.Fatalf("engine stop grace %v does not cover the Runtime budget %d", grace, RuntimeStopGraceSeconds)
	}
	total := contractNumber(t, contractJSON(t), "shutdown", "total_seconds")
	if !(total < grace) {
		t.Fatalf("Runtime shutdown budget %v must stay below the engine grace %v", total, grace)
	}
	spec, err := newTestDriver(t, newFakeEngine()).containerSpec(testDeployment(), testDigest)
	if err != nil {
		t.Fatal(err)
	}
	if spec.StopTimeout != RuntimeStopGraceSeconds {
		t.Fatalf("container StopTimeout %d does not match the engine grace", spec.StopTimeout)
	}
}

func TestSeccompProfileDeniesByDefaultAndKeepsRequiredSyscalls(t *testing.T) {
	encoded := strings.TrimPrefix(runtimeSeccompOption(), "seccomp=")
	var profile struct {
		DefaultAction string `json:"defaultAction"`
		Syscalls      []struct {
			Names  []string `json:"names"`
			Action string   `json:"action"`
		} `json:"syscalls"`
	}
	if err := json.Unmarshal([]byte(encoded), &profile); err != nil {
		t.Fatalf("embedded seccomp profile is invalid: %v", err)
	}
	if profile.DefaultAction != "SCMP_ACT_ERRNO" {
		t.Fatalf("seccomp default action must be deny: %s", profile.DefaultAction)
	}
	forbidden := map[string]bool{
		"keyctl": true, "bpf": true, "perf_event_open": true, "userfaultfd": true, "mount": true,
	}
	allowed := map[string]bool{}
	for _, rule := range profile.Syscalls {
		if rule.Action != "SCMP_ACT_ALLOW" {
			continue
		}
		for _, name := range rule.Names {
			if forbidden[name] {
				t.Fatalf("forbidden syscall %s survives in an ALLOW rule", name)
			}
			allowed[name] = true
		}
	}
	for _, required := range []string{"openat2", "capset", "prctl", "ioctl", "socket"} {
		if !allowed[required] {
			t.Fatalf("required Runtime syscall %s is missing from the profile", required)
		}
	}
}

func TestDeploySeccompSymlinkResolvesToTheEmbeddedProfile(t *testing.T) {
	shipped, err := os.ReadFile("../../../../../deploy/seccomp/antnest-runtime.json")
	if err != nil {
		t.Fatalf("deploy seccomp symlink does not resolve: %v", err)
	}
	embedded, err := os.ReadFile("antnest-runtime-seccomp.json")
	if err != nil {
		t.Fatalf("embedded seccomp profile missing: %v", err)
	}
	if !strings.EqualFold(strings.TrimSpace(string(shipped)), strings.TrimSpace(string(embedded))) {
		t.Fatal("deployed seccomp profile differs from the embedded profile")
	}
}

func TestContainerSpecMapsCPUMillisToEngineLimits(t *testing.T) {
	for _, test := range []struct {
		cpuMillis  uint64
		wantNanos  int64
		wantShares int64
	}{
		{100, 100000000, 102},
		{1000, 1000000000, 1024},
		{16000, 16000000000, 16384},
	} {
		value := testDeployment()
		value.Resources.CPUMillis = &test.cpuMillis
		spec, err := newTestDriver(t, newFakeEngine()).containerSpec(value, testDigest)
		if err != nil {
			t.Fatal(err)
		}
		if spec.NanoCPUs != test.wantNanos || spec.CPUShares != test.wantShares {
			t.Fatalf("cpu_millis %d mapped to nanos=%d shares=%d, want %d/%d",
				test.cpuMillis, spec.NanoCPUs, spec.CPUShares, test.wantNanos, test.wantShares)
		}
	}
}

func TestNewDriverRejectsUnsafeStopGrace(t *testing.T) {
	for _, grace := range []int{-1, 1, 19, 121} {
		config := testDriverConfig()
		config.StopGraceSeconds = grace
		if _, err := NewDriver(newFakeEngine(), config); err == nil {
			t.Fatalf("stop grace %d must be rejected", grace)
		}
	}
	for _, test := range []struct {
		grace int
		want  int
	}{
		{0, 20},
		{20, 20},
		{120, 120},
	} {
		config := testDriverConfig()
		config.StopGraceSeconds = test.grace
		driver, err := NewDriver(newFakeEngine(), config)
		if err != nil {
			t.Fatalf("stop grace %d rejected: %v", test.grace, err)
		}
		if driver.config.StopGraceSeconds != test.want {
			t.Fatalf("stop grace %d resolved to %d, want %d", test.grace, driver.config.StopGraceSeconds, test.want)
		}
	}
}

func TestDeploymentDigestBindsResourceLimitsAndWorkspaceBackend(t *testing.T) {
	driver := newTestDriver(t, newFakeEngine())
	base := testDeployment()
	first, err := driver.DeploymentDigest(base)
	if err != nil {
		t.Fatal(err)
	}
	cpu := uint64(4000)
	base.Resources.CPUMillis = &cpu
	second, err := driver.DeploymentDigest(base)
	if err != nil {
		t.Fatal(err)
	}
	if first == second {
		t.Fatal("deployment digest ignores explicit cpu_millis")
	}
	quotaDriver, err := NewDriver(newFakeEngine(), Config{
		ControllerScope: "test-controller", ManagementNetwork: "antnest-runtime-management",
		SystemSkillsVolume: "antnest-system-skills", ResolverMountGate: &fakeResolverGate{},
		WorkspaceVolumeDriver: "example-quota", WorkspaceQuotaOption: "size",
	})
	if err != nil {
		t.Fatal(err)
	}
	third, err := quotaDriver.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	if first == third {
		t.Fatal("deployment digest ignores the workspace quota backend")
	}
}
