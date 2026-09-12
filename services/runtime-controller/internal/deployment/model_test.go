package deployment

import (
	"math"
	"strings"
	"testing"
	"time"
)

func TestDigestValueIsStableAndCoversExecutionInput(t *testing.T) {
	value := testDeployment()
	key := Key{AgentID: "agent-1", Generation: 7}
	if err := value.ValidateFor(key); err != nil {
		t.Fatalf("validate deployment: %v", err)
	}

	first, err := DigestValue(value)
	if err != nil {
		t.Fatalf("digest deployment: %v", err)
	}
	second, err := DigestValue(value)
	if err != nil {
		t.Fatalf("digest deployment again: %v", err)
	}
	if first != second || !strings.HasPrefix(first, "sha256:") {
		t.Fatalf("unstable digest: first=%q second=%q", first, second)
	}

	changed := value
	changed.Resources.MemoryBytes++
	changedDigest, err := DigestValue(changed)
	if err != nil {
		t.Fatalf("digest changed deployment: %v", err)
	}
	if changedDigest == first {
		t.Fatal("resource change did not change deployment digest")
	}
}

func TestObservationIdentityMatchesItsScope(t *testing.T) {
	now := time.Date(2026, 8, 31, 0, 0, 0, 0, time.UTC)
	revision := RevisionFor("request-1", "sha256:"+strings.Repeat("a", 64))
	digest := "sha256:" + strings.Repeat("b", 64)

	tests := []struct {
		name    string
		value   Observation
		wantErr bool
	}{
		{
			name:  "service fact",
			value: Observation{Kind: ObservationReconciled, Source: "test", ObservedAt: now},
		},
		{
			name: "service fact with Agent identity",
			value: Observation{
				AgentID: "agent-1", Kind: ObservationReconciled, Source: "test", ObservedAt: now,
			},
			wantErr: true,
		},
		{
			name: "Environment fact",
			value: Observation{
				AgentID: "agent-1", RuntimeRevision: revision,
				Kind: ObservationStorageMissing, Source: "test", ObservedAt: now,
			},
		},
		{
			name: "Environment fact with generation identity",
			value: Observation{
				AgentID: "agent-1", RuntimeRevision: revision, Generation: 7, SpecDigest: digest,
				Kind: ObservationStorageMissing, Source: "test", ObservedAt: now,
			},
			wantErr: true,
		},
		{
			name: "Runtime generation fact",
			value: Observation{
				AgentID: "agent-1", RuntimeRevision: revision, Generation: 7, SpecDigest: digest,
				Kind: ObservationHealthy, Source: "test", ObservedAt: now,
			},
		},
		{
			name: "Runtime generation fact without generation",
			value: Observation{
				AgentID: "agent-1", RuntimeRevision: revision,
				Kind: ObservationRuntimeMissing, Source: "test", ObservedAt: now,
			},
			wantErr: true,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := test.value.Validate()
			if (err != nil) != test.wantErr {
				t.Fatalf("Validate() error = %v, wantErr %t", err, test.wantErr)
			}
		})
	}
}

func TestDeploymentRejectsCrossAgentIdentityAndInvalidRuntimeBoundary(t *testing.T) {
	tests := []struct {
		name  string
		key   Key
		value Deployment
	}{
		{name: "agent mismatch", key: Key{AgentID: "agent-2", Generation: 7}, value: testDeployment()},
		{name: "generation mismatch", key: Key{AgentID: "agent-1", Generation: 8}, value: testDeployment()},
		{name: "unsafe agent identifier", key: Key{AgentID: "agent/1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.AgentID = "agent/1"
			return value
		}()},
		{name: "generation exceeds persistence range", key: Key{AgentID: "agent-1", Generation: math.MaxUint64}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Generation = math.MaxUint64
			return value
		}()},
		{name: "relative workspace", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Filesystem.Workspace = "workspace"
			return value
		}()},
		{name: "root workspace overlaps every other root", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Filesystem.Workspace = "/"
			return value
		}()},
		{name: "loopback listener is unreachable from controller", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Listen.Host = "127.0.0.1"
			return value
		}()},
		{name: "image URL is not a reference", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.ImageRef = "https://registry.example/antnest-runtime:latest"
			return value
		}()},
		{name: "ambiguous digest-pinned image", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.ImageRef = "registry@example/antnest@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
			return value
		}()},
		{name: "memory exceeds Docker signed range", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.Resources.MemoryBytes = math.MaxUint64
			return value
		}()},
		{name: "tmpfs exceeds Docker signed range", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.Resources.TmpfsBytes = math.MaxUint64
			return value
		}()},
		{name: "same tunnel and resolver", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Network.ResolverIPv4 = value.RuntimeSpec.Network.TunnelIPv4
			return value
		}()},
		{name: "loopback tunnel address", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Network.TunnelIPv4 = "127.0.0.1"
			return value
		}()},
		{name: "link-local egress address", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.RuntimeSpec.Network.EgressEndpoint.IPv4 = "169.254.1.1"
			return value
		}()},
		{name: "zero resources", key: Key{AgentID: "agent-1", Generation: 7}, value: func() Deployment {
			value := testDeployment()
			value.Resources = ResourceLimits{}
			return value
		}()},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.value.ValidateFor(test.key); err == nil {
				t.Fatal("invalid deployment accepted")
			}
		})
	}
}

func TestValidateDigestAcceptsOnlyCanonicalSHA256(t *testing.T) {
	if err := ValidateDigest("sha256:" + strings.Repeat("a", 64)); err != nil {
		t.Fatalf("canonical digest rejected: %v", err)
	}
	for _, value := range []string{"", "sha256:short", "sha256:" + strings.Repeat("z", 64)} {
		if err := ValidateDigest(value); err == nil {
			t.Fatalf("invalid digest accepted: %q", value)
		}
	}
}

func TestEffectOutcomeHasClosedValidStates(t *testing.T) {
	valid := []EffectOutcome{
		{State: EffectCompleted},
		{State: EffectNotStarted, Code: "runtime_drift", Detail: "different resource"},
		{State: EffectUnknown, Code: "platform_unavailable", Detail: "connection lost"},
	}
	for _, outcome := range valid {
		if err := outcome.Validate(); err != nil {
			t.Fatalf("valid outcome rejected: %+v: %v", outcome, err)
		}
	}
	invalid := []EffectOutcome{
		{},
		{State: EffectCompleted, Code: "unexpected"},
		{State: EffectUnknown},
		{State: "retrying", Code: "unexpected"},
	}
	for _, outcome := range invalid {
		if err := outcome.Validate(); err == nil {
			t.Fatalf("invalid outcome accepted: %+v", outcome)
		}
	}
}

func testDeployment() Deployment {
	return Deployment{
		ImageRef: "antnest/antnest-runtime@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		RuntimeSpec: RuntimeSpec{
			AgentID: "agent-1", Generation: 7,
			Listen: SocketAddress{Host: "0.0.0.0", Port: 8093},
			Network: NetworkSpec{
				PacketContractRevision: 1,
				EgressEndpoint:         IPv4Endpoint{IPv4: "10.20.0.8", Port: 8092},
				TunnelIPv4:             "100.64.0.2",
				ResolverIPv4:           "100.64.0.1",
			},
			Filesystem: FilesystemSpec{Workspace: "/workspace", SystemSkills: "/skills"},
		},
		Resources: ResourceLimits{
			MemoryBytes: 2 << 30,
			PidsLimit:   512,
			TmpfsBytes:  512 << 20,
		},
	}
}
