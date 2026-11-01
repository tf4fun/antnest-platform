package docker

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
)

func capacityNetwork(subnet, gateway string, aux map[string]string, endpoints map[string]string) Network {
	return Network{
		Name:       "antnest-runtime-management",
		IPAM:       []NetworkIPAM{{Subnet: subnet, Gateway: gateway, AuxiliaryAddresses: aux}},
		Containers: endpoints,
	}
}

func runtimeEndpoint(id, generation, agent string) Container {
	return Container{
		ID: id,
		Labels: map[string]string{
			labelManaged: "runtime", labelScope: "other-scope", labelAgentID: agent,
			labelGeneration: generation, labelSpecDigest: "sha256:" + digest64('e'),
		},
	}
}

func TestCapacityComputesSlash24Pool(t *testing.T) {
	network := capacityNetwork("172.30.255.0/24", "172.30.255.1",
		map[string]string{"egress": "172.30.255.3", "controller": "172.30.255.4"},
		map[string]string{
			"runtime-1": "172.30.255.10/24", "runtime-2": "172.30.255.11/24",
			"nonruntime-1": "172.30.255.3/24", "nonruntime-2": "172.30.255.4/24",
		})
	managed := []Container{
		runtimeEndpoint("runtime-1", "1", "agent-1"),
		runtimeEndpoint("runtime-2", "4", "agent-2"),
	}
	snapshot, err := managementCapacity(network, managed)
	if err != nil || !snapshot.Known || snapshot.RuntimeCapacity != 251 || snapshot.RuntimeCount != 2 {
		t.Fatalf("/24 capacity: %+v err=%v", snapshot, err)
	}
}

func TestCapacityComputesSlash20PoolWithForeignRuntimes(t *testing.T) {
	network := capacityNetwork("172.30.240.0/20", "172.30.240.1",
		map[string]string{"egress": "172.30.255.3", "controller": "172.30.255.4"},
		map[string]string{
			"runtime-a": "172.30.241.10/20", "runtime-b": "172.30.241.11/20",
			"endpoint": "172.30.250.9/20",
		})
	snapshot, err := managementCapacity(network, []Container{
		runtimeEndpoint("runtime-a", "1", "agent-1"),
		runtimeEndpoint("runtime-b", "1", "agent-2"),
	})
	if err != nil || snapshot.RuntimeCapacity != 4090 || snapshot.RuntimeCount != 2 {
		t.Fatalf("/20 capacity: %+v err=%v", snapshot, err)
	}
}

func TestCapacityPrefersIPRangeAndDeduplicatesExclusions(t *testing.T) {
	network := Network{
		Name: "net",
		IPAM: []NetworkIPAM{{
			Subnet:  "172.30.240.0/20",
			IPRange: "172.30.240.0/25",
			Gateway: "172.30.240.1",
			AuxiliaryAddresses: map[string]string{
				"one": "172.30.240.1", "two": "172.30.240.1", "three": "172.30.240.5",
			},
		}},
		Containers: map[string]string{
			"endpoint-1": "172.30.240.2/25",
			"endpoint-2": "172.30.240.2/25",
			"stopped":    "",
		},
	}
	snapshot, err := managementCapacity(network, nil)
	if err != nil || snapshot.RuntimeCapacity != 124 || snapshot.RuntimeCount != 0 {
		t.Fatalf("IPRange capacity: %+v err=%v", snapshot, err)
	}
}

func TestCapacityHandlesIPRangeBoundariesPrecisely(t *testing.T) {
	upper := Network{
		Name: "net",
		IPAM: []NetworkIPAM{{
			Subnet: "172.30.255.0/24", IPRange: "172.30.255.128/25",
			Gateway: "172.30.255.1",
		}},
		Containers: map[string]string{"static-3": "172.30.255.3/24"},
	}
	snapshot, err := managementCapacity(upper, nil)
	if err != nil || snapshot.RuntimeCapacity != 127 || snapshot.RuntimeCount != 0 {
		t.Fatalf("upper IPRange: %+v err=%v", snapshot, err)
	}
	lower := Network{
		Name: "net",
		IPAM: []NetworkIPAM{{
			Subnet: "172.30.255.0/24", IPRange: "172.30.255.0/25",
			Gateway: "172.30.255.200",
		}},
	}
	snapshot, err = managementCapacity(lower, nil)
	if err != nil || snapshot.RuntimeCapacity != 127 {
		t.Fatalf("lower IPRange with out-of-pool gateway: %+v err=%v", snapshot, err)
	}
	ranged := Network{
		Name: "net",
		IPAM: []NetworkIPAM{{
			Subnet: "172.30.255.0/24", IPRange: "172.30.255.128/25",
			AuxiliaryAddresses: map[string]string{"net": "172.30.255.0", "bcast": "172.30.255.255"},
		}},
		Containers: map[string]string{"rt-out": "172.30.255.7/24", "rt-in": "172.30.255.130/25"},
	}
	snapshot, err = managementCapacity(ranged, []Container{
		runtimeEndpoint("rt-out", "1", "agent-1"), runtimeEndpoint("rt-in", "1", "agent-2"),
	})
	if err != nil || snapshot.RuntimeCount != 2 || snapshot.RuntimeCapacity != 128 {
		t.Fatalf("runtime endpoints inside and outside the range: %+v err=%v", snapshot, err)
	}
	for _, test := range []struct {
		name    string
		network Network
	}{
		{"range broader than parent", Network{Name: "n", IPAM: []NetworkIPAM{{Subnet: "172.30.255.0/24", IPRange: "172.30.0.0/16"}}}},
		{"range start outside parent", Network{Name: "n", IPAM: []NetworkIPAM{{Subnet: "172.30.255.0/25", IPRange: "172.30.255.128/25"}}}},
		{"endpoint outside parent", capacityNetwork("172.30.255.0/24", "", nil, map[string]string{"c": "10.9.9.9/24"})},
		{"conflicting endpoint ownership", Network{
			Name: "n", IPAM: []NetworkIPAM{{Subnet: "172.30.255.0/24"}},
			Containers: map[string]string{"rt": "172.30.255.9/24", "plain": "172.30.255.9/24"},
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			managed := []Container{}
			if test.name == "conflicting endpoint ownership" {
				managed = []Container{runtimeEndpoint("rt", "1", "agent-1")}
			}
			if snapshot, err := managementCapacity(test.network, managed); err == nil || snapshot.Known {
				t.Fatalf("ambiguous IPAM produced capacity: %+v", snapshot)
			}
		})
	}
}

func TestCapacityCountsAuxiliaryRegisteredRuntimeOnce(t *testing.T) {
	network := capacityNetwork("172.30.255.0/24", "172.30.255.1",
		map[string]string{"static-runtime": "172.30.255.10", "egress": "172.30.255.3"},
		map[string]string{"rt": "172.30.255.10/24"})
	snapshot, err := managementCapacity(network, []Container{runtimeEndpoint("rt", "1", "agent-1")})
	if err != nil || snapshot.RuntimeCount != 1 || snapshot.RuntimeCapacity != 252 {
		t.Fatalf("auxiliary-registered runtime: %+v err=%v", snapshot, err)
	}
}

func TestCapacityRejectsMalformedIPAMRatherThanOverestimating(t *testing.T) {
	for _, test := range []struct {
		name    string
		network Network
	}{
		{"no pools", Network{Name: "n"}},
		{"bad subnet", capacityNetwork("172.30.255.0/33", "", nil, nil)},
		{"bad range", Network{Name: "n", IPAM: []NetworkIPAM{{Subnet: "172.30.255.0/24", IPRange: "bogus"}}}},
		{"range outside subnet", Network{Name: "n", IPAM: []NetworkIPAM{{Subnet: "172.30.255.0/24", IPRange: "10.0.0.0/24"}}}},
		{"bad gateway", capacityNetwork("172.30.255.0/24", "not-an-ip", nil, nil)},
		{"bad auxiliary", capacityNetwork("172.30.255.0/24", "", map[string]string{"x": "bogus"}, nil)},
		{"bad endpoint", capacityNetwork("172.30.255.0/24", "", nil, map[string]string{"c": "bogus"})},

		{"two IPv4 pools", Network{Name: "n", IPAM: []NetworkIPAM{{Subnet: "172.30.255.0/24"}, {Subnet: "10.20.0.0/24"}}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if snapshot, err := managementCapacity(test.network, nil); err == nil || snapshot.Known {
				t.Fatalf("malformed IPAM produced capacity: %+v", snapshot)
			}
		})
	}
	if snapshot, err := managementCapacity(Network{
		Name: "n", IPAM: []NetworkIPAM{{Subnet: "fd00::/64"}, {Subnet: "172.30.255.0/24"}},
	}, nil); err != nil || !snapshot.Known || snapshot.RuntimeCapacity != 254 {
		t.Fatalf("IPv6 config was not skipped: %+v err=%v", snapshot, err)
	}
}

func exhaustPool(engine *scopedEngine) {
	network := engine.networks["antnest-runtime-management"]
	network.IPAM = []NetworkIPAM{{Subnet: "172.30.255.0/30"}}
	network.Containers = map[string]string{"rt-1": "172.30.255.1/30", "rt-2": "172.30.255.2/30"}
	engine.networks["antnest-runtime-management"] = network
	for _, id := range []string{"rt-1", "rt-2"} {
		name := "other-scope-runtime-" + id
		engine.containers[name] = &Container{
			ID: id, Name: name, Labels: map[string]string{
				labelManaged: "runtime", labelScope: "other-scope", labelAgentID: "agent-" + id,
				labelGeneration: "1", labelSpecDigest: "sha256:" + digest64('f'),
			},
		}
		engine.byID[id] = name
	}
}

func TestCreateRejectsNewComputeWhenKnownCapacityIsExhausted(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	exhaustPool(engine)
	driver := scopedDriver(t, engine, "test-controller")
	digest, err := driver.DeploymentDigest(testDeployment())
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(context.Background(), testDeployment(), digest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_capacity_exhausted" {
		t.Fatalf("exhausted capacity admitted a create: %+v", outcome)
	}
	if len(engine.createdSpecs) != 0 {
		t.Fatal("create reached Docker despite exhaustion")
	}
}

func TestExactRunningComputeStaysIdempotentWhenCapacityIsExhausted(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	exhaustPool(engine)
	existing := scopedContainer("agent-1", 7, "test-controller", testDigest, true)
	engine.containers[existing.Name] = existing
	engine.byID[existing.ID] = existing.Name
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("exact running compute was rejected under exhaustion: %+v", outcome)
	}
	if len(engine.createdSpecs) != 0 {
		t.Fatal("idempotent path created a container")
	}
}

func TestStoppedComputeWithoutAddressUsesTheCapacityGate(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	exhaustPool(engine)
	existing := scopedContainer("agent-1", 7, "test-controller", testDigest, false)
	existing.NetworkIPv4 = map[string]string{}
	engine.containers[existing.Name] = existing
	engine.byID[existing.ID] = existing.Name
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_capacity_exhausted" {
		t.Fatalf("stopped no-address compute bypassed the gate: %+v", outcome)
	}
	if len(engine.started) != 0 {
		t.Fatal("container was started under exhaustion")
	}
}

func TestUnknownCapacityStillAdmitsCreate(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	engine.networkErr = errors.New("network inspect unavailable")
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectCompleted {
		t.Fatalf("unknown capacity blocked a create: %+v", outcome)
	}
	if snapshot := driver.Capacity(); snapshot.Known {
		t.Fatalf("refresh failure reported known capacity: %+v", snapshot)
	}
}

func TestLegacyEngineWithoutDetailsKeepsCapacityUnknown(t *testing.T) {
	engine := newFakeEngine()
	driver := newTestDriver(t, engine)
	if outcome := driver.Create(context.Background(), testDeployment(), testDigest); outcome.State != deployment.EffectCompleted {
		t.Fatalf("legacy engine create: %+v", outcome)
	}
	if snapshot := driver.Capacity(); snapshot != (platform.Capacity{}) {
		t.Fatalf("unsupported engine reported capacity: %+v", snapshot)
	}
}

func TestDockerIPAMExhaustionMapsToTypedNotStartedError(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	engine.createErr = ipamExhaustionError()
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_capacity_exhausted" {
		t.Fatalf("Docker exhaustion was not the typed error: %+v", outcome)
	}
	engine.createErr = errors.New("connection refused")
	outcome = driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.Code != "platform_unavailable" {
		t.Fatalf("arbitrary failure was misclassified: %+v", outcome)
	}
}

func TestCapacityGateSerializesConcurrentCreates(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	network := engine.networks["antnest-runtime-management"]
	network.IPAM = []NetworkIPAM{{Subnet: "172.30.255.0/30"}}
	network.Containers = map[string]string{"rt-1": "172.30.255.1/30"}
	engine.networks["antnest-runtime-management"] = network
	engine.containers["other-scope-runtime"] = &Container{
		ID: "rt-1", Name: "other-scope-runtime", Labels: map[string]string{
			labelManaged: "runtime", labelScope: "other-scope", labelAgentID: "agent-9",
			labelGeneration: "1", labelSpecDigest: "sha256:" + digest64('f'),
		},
	}
	engine.byID["rt-1"] = "other-scope-runtime"
	other := testDeployment()
	other.RuntimeSpec.AgentID = "agent-2"
	scopedWorkspace(engine, "test-controller", "agent-2")
	engine.pendingIPv4["antnest-test-controller-runtime-agent-1"] = "172.30.255.2"
	engine.pendingIPv4["antnest-test-controller-runtime-agent-2"] = "172.30.255.2"
	driver := scopedDriver(t, engine, "test-controller")
	otherDigest, err := driver.DeploymentDigest(other)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan deployment.EffectOutcome, 2)
	var once sync.WaitGroup
	once.Add(2)
	for i, item := range []struct {
		value  deployment.Deployment
		digest string
	}{{testDeployment(), testDigest}, {other, otherDigest}} {
		go func() {
			defer once.Done()
			results <- driver.Create(context.Background(), item.value, item.digest)
		}()
		_ = i
	}
	once.Wait()
	close(results)
	completed, exhausted := 0, 0
	for outcome := range results {
		switch outcome.Code {
		case "":
			completed++
		case "runtime_capacity_exhausted":
			exhausted++
		default:
			t.Fatalf("unexpected outcome: %+v", outcome)
		}
	}
	if completed != 1 || exhausted != 1 || len(engine.createdSpecs) != 1 {
		t.Fatalf("concurrent creates raced: completed=%d exhausted=%d specs=%d", completed, exhausted, len(engine.createdSpecs))
	}
}

func ipamExhaustionError() error {
	return Uncertain(&APIError{
		Status:  500,
		Message: `{"message":"no available IPv4 addresses on this network's address pools: antnest-runtime-management (abc123)"}`,
	})
}

func TestNewCandidateStartExhaustionRemovesExactCandidate(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	engine.startErr = ipamExhaustionError()
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_capacity_exhausted" {
		t.Fatalf("start exhaustion: %+v", outcome)
	}
	if len(engine.removed) != 1 || engine.containers["antnest-test-controller-runtime-agent-1"] != nil {
		t.Fatalf("the exact failed candidate was not removed: removed=%v", engine.removed)
	}
}

func TestNewCandidateStartExhaustionCleanupUncertaintyIsUnknown(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	engine.startErr = ipamExhaustionError()
	engine.removeErr = errors.New("daemon refused removal")
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectUnknown || outcome.Code != "runtime_capacity_exhausted" {
		t.Fatalf("uncertain cleanup must not claim not_started: %+v", outcome)
	}
}

func TestExistingStoppedStartExhaustionKeepsResource(t *testing.T) {
	engine := newScopedEngine("test-controller")
	scopedWorkspace(engine, "test-controller", "agent-1")
	existing := scopedContainer("agent-1", 7, "test-controller", testDigest, false)
	existing.NetworkIPv4 = map[string]string{}
	engine.containers[existing.Name] = existing
	engine.byID[existing.ID] = existing.Name
	engine.startErr = ipamExhaustionError()
	driver := scopedDriver(t, engine, "test-controller")
	outcome := driver.Create(context.Background(), testDeployment(), testDigest)
	if outcome.State != deployment.EffectNotStarted || outcome.Code != "runtime_capacity_exhausted" {
		t.Fatalf("preexisting start exhaustion: %+v", outcome)
	}
	if len(engine.removed) != 0 || engine.containers[existing.Name] == nil {
		t.Fatal("preexisting resource was deleted after a start failure")
	}
}
