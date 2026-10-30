package deployment

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestOptionalResourceLimitsApplyContractBounds(t *testing.T) {
	key := Key{AgentID: "agent-1", Generation: 7}
	for _, test := range []struct {
		name      string
		cpu       *uint64
		workspace *uint64
		valid     bool
	}{
		{"omitted", nil, nil, true},
		{"cpu_min", uint64Ptr(100), nil, true},
		{"cpu_max", uint64Ptr(16000), nil, true},
		{"cpu_zero", uint64Ptr(0), nil, false},
		{"cpu_below", uint64Ptr(99), nil, false},
		{"cpu_above", uint64Ptr(16001), nil, false},
		{"workspace_min", nil, uint64Ptr(67108864), true},
		{"workspace_max", nil, uint64Ptr(1099511627776), true},
		{"workspace_zero", nil, uint64Ptr(0), false},
		{"workspace_below", nil, uint64Ptr(67108863), false},
		{"workspace_above", nil, uint64Ptr(1099511627777), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := testDeployment()
			value.Resources.CPUMillis = test.cpu
			value.Resources.WorkspaceBytes = test.workspace
			err := value.ValidateFor(key)
			if test.valid && err != nil {
				t.Fatalf("valid resources rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid resources accepted")
			}
		})
	}
}

func TestOptionalResourceLimitsDefaultWhenOmitted(t *testing.T) {
	limits := ResourceLimits{}
	if limits.EffectiveCPUMillis() != 1000 || limits.EffectiveWorkspaceBytes() != 10737418240 {
		t.Fatalf("contract defaults not applied: %+v", limits)
	}
}

func TestOptionalResourceLimitsOmissionStaysAbsentInPersistedJSON(t *testing.T) {
	encoded, err := json.Marshal(ResourceLimits{MemoryBytes: 1, PidsLimit: 16, TmpfsBytes: 2})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "cpu_millis") || strings.Contains(string(encoded), "workspace_bytes") {
		t.Fatalf("omitted optional limits leaked into persisted identity: %s", encoded)
	}
	var roundtrip ResourceLimits
	if err := json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if roundtrip.CPUMillis != nil || roundtrip.WorkspaceBytes != nil {
		t.Fatal("omission must roundtrip as nil, not zero")
	}
}

func TestResolveClonesResourceLimitPointers(t *testing.T) {
	cpu := uint64(4000)
	workspace := uint64(67108864)
	configuration := Configuration{
		ImageRef: testDeployment().ImageRef,
		Network:  testDeployment().RuntimeSpec.Network,
		Resources: ResourceLimits{
			MemoryBytes: 1 << 30, PidsLimit: 64, TmpfsBytes: 16 << 20,
			CPUMillis: &cpu, WorkspaceBytes: &workspace,
		},
	}
	value, err := configuration.Resolve("agent-1", 7)
	if err != nil {
		t.Fatal(err)
	}
	cpu = 100
	workspace = 67108864 * 2
	if *value.Resources.CPUMillis != 4000 || *value.Resources.WorkspaceBytes != 67108864 {
		t.Fatalf("resolved deployment aliases caller-owned pointers: %+v", value.Resources)
	}
}

func uint64Ptr(value uint64) *uint64 { return &value }
