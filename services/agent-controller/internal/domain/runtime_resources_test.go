package domain

import (
	"encoding/json"
	"testing"
)

func resourceInt64(value int64) *int64 { return &value }

func TestRuntimeResourcesApplyContractBounds(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name      string
		cpu       *int64
		workspace *int64
		valid     bool
	}{
		{"omitted", nil, nil, true},
		{"cpu_min", resourceInt64(100), nil, true},
		{"cpu_max", resourceInt64(16000), nil, true},
		{"cpu_zero", resourceInt64(0), nil, false},
		{"cpu_negative", resourceInt64(-1), nil, false},
		{"cpu_below", resourceInt64(99), nil, false},
		{"cpu_above", resourceInt64(16001), nil, false},
		{"workspace_min", nil, resourceInt64(67108864), true},
		{"workspace_max", nil, resourceInt64(1099511627776), true},
		{"workspace_zero", nil, resourceInt64(0), false},
		{"workspace_negative", nil, resourceInt64(-1), false},
		{"workspace_below", nil, resourceInt64(67108863), false},
		{"workspace_above", nil, resourceInt64(1099511627777), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			value := validRuntime()
			value.Resources.CPUMillis = test.cpu
			value.Resources.WorkspaceBytes = test.workspace
			err := validateRuntime(value)
			if test.valid && err != nil {
				t.Fatalf("valid runtime resources rejected: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("invalid runtime resources accepted")
			}
		})
	}
}

func TestRuntimeResourcesDefaultWhenOmitted(t *testing.T) {
	t.Parallel()
	resources := RuntimeResources{}
	if resources.EffectiveCPUMillis() != 1000 || resources.EffectiveWorkspaceBytes() != 10737418240 {
		t.Fatalf("contract defaults not applied: %+v", resources)
	}
}

func TestRuntimeResourcesStrictJSON(t *testing.T) {
	t.Parallel()
	base := `{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864`
	for _, test := range []struct {
		name string
		body string
	}{
		{"cpu_null", base + `,"cpu_millis":null}`},
		{"workspace_null", base + `,"workspace_bytes":null}`},
		{"unknown_field", base + `,"unknown_limit":1}`},
		{"cpu_fraction", base + `,"cpu_millis":1.5}`},
		{"workspace_fraction", base + `,"workspace_bytes":67108864.25}`},
		{"cpu_string", base + `,"cpu_millis":"100"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			var value RuntimeResources
			if err := json.Unmarshal([]byte(test.body), &value); err == nil {
				t.Fatalf("%s must be rejected at the JSON boundary", test.name)
			}
		})
	}
	var negative RuntimeResources
	if err := json.Unmarshal([]byte(base+`,"cpu_millis":-1}`), &negative); err != nil {
		t.Fatalf("decodable integer rejected: %v", err)
	}
	runtime := validRuntime()
	runtime.Resources = negative
	if validateRuntime(runtime) == nil {
		t.Fatal("negative cpu_millis must fail validation")
	}
}

func TestRuntimeResourcesOmissionKeepsLegacyJSON(t *testing.T) {
	t.Parallel()
	encoded, err := json.Marshal(validRuntime().Resources)
	if err != nil {
		t.Fatal(err)
	}
	const legacy = `{"memory_bytes":536870912,"pids_limit":256,"tmpfs_bytes":67108864}`
	if string(encoded) != legacy {
		t.Fatalf("omitted optional limits changed the legacy encoding: %s", encoded)
	}
	var roundtrip RuntimeResources
	if err := json.Unmarshal(encoded, &roundtrip); err != nil {
		t.Fatal(err)
	}
	if roundtrip.CPUMillis != nil || roundtrip.WorkspaceBytes != nil {
		t.Fatal("omission must roundtrip as nil, not a zero value")
	}
}

func TestRuntimeResourcesCloneIsolatesPointers(t *testing.T) {
	t.Parallel()
	original := validRuntime().Resources
	original.CPUMillis = resourceInt64(2500)
	original.WorkspaceBytes = resourceInt64(67108864)
	clone := original.Clone()
	if clone.CPUMillis == original.CPUMillis || clone.WorkspaceBytes == original.WorkspaceBytes {
		t.Fatal("Clone must copy pointer targets")
	}
	*original.CPUMillis = 16000
	if *clone.CPUMillis != 2500 {
		t.Fatal("mutating the source leaked into the clone")
	}
}

func TestTemplateAndAgentSpecDeepCopyResourcePointers(t *testing.T) {
	t.Parallel()
	cpu, workspace := resourceInt64(2500), resourceInt64(67108864)
	runtime := validRuntime()
	runtime.Resources.CPUMillis = cpu
	runtime.Resources.WorkspaceBytes = workspace
	template, err := NewTemplateRevision(TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileID: "model-1", SystemPrompt: "You are helpful.",
		MaxModelRequests: 32, Runtime: runtime, ContextPolicyVersion: "context-v1",
	})
	if err != nil {
		t.Fatalf("create template revision: %v", err)
	}
	*cpu = 100
	*workspace = 134217728
	if got := template.Snapshot().Runtime.Resources; *got.CPUMillis != 2500 || *got.WorkspaceBytes != 67108864 {
		t.Fatalf("template aliases caller-owned resource pointers: %+v", got)
	}
	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
		Revision: 1, Model: validModel(),
	})
	if err != nil {
		t.Fatalf("create model revision: %v", err)
	}
	spec, err := MaterializeAgentSpec(template, model)
	if err != nil {
		t.Fatalf("materialize spec: %v", err)
	}
	first := spec.Snapshot()
	*first.Runtime.Resources.CPUMillis = 16000
	second := spec.Snapshot()
	if *second.Runtime.Resources.CPUMillis != 2500 {
		t.Fatal("mutating a returned snapshot corrupted the stored AgentSpec")
	}
	templateRuntime := template.Snapshot().Runtime.Resources
	*templateRuntime.CPUMillis = 16000
	if got := template.Snapshot().Runtime.Resources; *got.CPUMillis != 2500 {
		t.Fatal("mutating a returned snapshot corrupted the stored TemplateRevision")
	}
}

func TestAgentSpecDigestBindsExplicitResourceLimits(t *testing.T) {
	t.Parallel()
	model, err := NewModelProfileRevision(ModelProfileRevisionInput{
		ID: "model-revision-1", ModelProfileID: "model-1", OrganizationID: "org-1",
		Revision: 1, Model: validModel(),
	})
	if err != nil {
		t.Fatal(err)
	}
	revision := func(runtime RuntimeSpecInput) AgentSpec {
		t.Helper()
		template, err := NewTemplateRevision(TemplateRevisionInput{
			TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
			ModelProfileID: "model-1", SystemPrompt: "You are helpful.",
			MaxModelRequests: 32, Runtime: runtime, ContextPolicyVersion: "context-v1",
		})
		if err != nil {
			t.Fatal(err)
		}
		spec, err := MaterializeAgentSpec(template, model)
		if err != nil {
			t.Fatal(err)
		}
		return spec
	}
	legacy := revision(validRuntime())
	explicit := validRuntime()
	explicit.Resources.CPUMillis = resourceInt64(2500)
	legacyDigest, err := legacy.Digest()
	if err != nil {
		t.Fatal(err)
	}
	explicitDigest, err := revision(explicit).Digest()
	if err != nil {
		t.Fatal(err)
	}
	if legacyDigest == explicitDigest {
		t.Fatal("spec digest ignores explicit cpu_millis")
	}
	repeat, err := revision(validRuntime()).Digest()
	if err != nil {
		t.Fatal(err)
	}
	if repeat != legacyDigest {
		t.Fatal("legacy spec digest changed across replay")
	}
}
