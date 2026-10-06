package deployment

import "testing"

func TestLifecycleCommandsHaveExplicitTransitions(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		kind       OperationKind
		from       LifecycleState
		transition LifecycleState
		to         LifecycleState
		allowed    bool
	}{
		{"initialize new Environment", OperationInitializeRuntime, LifecycleUninitialized, LifecycleInitializing, LifecycleProvisioned, true},
		{"initialize existing Environment", OperationInitializeRuntime, LifecycleProvisioned, "", "", false},
		{"update ready Environment", OperationUpdateRuntime, LifecycleProvisioned, LifecycleUpdating, LifecycleProvisioned, true},
		{"update disabled Environment", OperationUpdateRuntime, LifecycleDisabled, "", "", false},
		{"disable ready Environment", OperationDisableRuntime, LifecycleProvisioned, LifecycleDisabling, LifecycleDisabled, true},
		{"disable disabled Environment", OperationDisableRuntime, LifecycleDisabled, "", "", false},
		{"enable disabled Environment", OperationEnableRuntime, LifecycleDisabled, LifecycleEnabling, LifecycleProvisioned, true},
		{"enable ready Environment", OperationEnableRuntime, LifecycleProvisioned, "", "", false},
		{"delete ready Environment", OperationDeleteRuntime, LifecycleProvisioned, LifecycleDeleting, LifecycleDeleted, true},
		{"delete disabled Environment", OperationDeleteRuntime, LifecycleDisabled, LifecycleDeleting, LifecycleDeleted, true},
		{"delete deleted Environment", OperationDeleteRuntime, LifecycleDeleted, "", "", false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			transition, success, err := LifecycleTransition(test.kind, test.from)
			if test.allowed {
				if err != nil || transition != test.transition || success != test.to {
					t.Fatalf("transition=(%q,%q) err=%v", transition, success, err)
				}
				return
			}
			if err == nil {
				t.Fatalf("invalid transition was accepted: (%q,%q)", transition, success)
			}
		})
	}
}

func TestRuntimeConfigurationResolvesPrivateRuntimeSpec(t *testing.T) {
	t.Parallel()
	configuration := testConfiguration()
	resolved, err := configuration.Resolve("agent-1", 9)
	if err != nil {
		t.Fatalf("resolve configuration: %v", err)
	}
	if resolved.RuntimeSpec.AgentID != "agent-1" || resolved.RuntimeSpec.Generation != 9 {
		t.Fatalf("private identity was not injected: %+v", resolved.RuntimeSpec)
	}
	if resolved.RuntimeSpec.Listen != (SocketAddress{Host: "0.0.0.0", Port: 8093}) {
		t.Fatalf("listener was not injected: %+v", resolved.RuntimeSpec.Listen)
	}
	if resolved.RuntimeSpec.Filesystem != (FilesystemSpec{Workspace: "/workspace", SystemSkills: "/skills"}) {
		t.Fatalf("filesystem was not injected: %+v", resolved.RuntimeSpec.Filesystem)
	}
}

func TestRuntimeRevisionIsOpaqueAndStableForExactRetry(t *testing.T) {
	t.Parallel()
	first := RevisionFor("request-1", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	second := RevisionFor("request-1", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	changed := RevisionFor("request-2", "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if first != second || first == changed || ValidateRevision(first) != nil {
		t.Fatalf("revision generation is not stable and opaque: first=%q second=%q changed=%q", first, second, changed)
	}
}

func testConfiguration() Configuration {
	return Configuration{
		ImageRef: "antnest/runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		Network: NetworkSpec{
			PacketContractRevision: 2,
			EgressEndpoint:         IPv4Endpoint{IPv4: "10.20.0.8", Port: 8092},
			TunnelIPv4:             "100.64.0.2",
			ResolverIPv4:           "100.64.0.1",
		},
		Resources: ResourceLimits{MemoryBytes: 2 << 30, PidsLimit: 512, TmpfsBytes: 512 << 20},
	}
}
