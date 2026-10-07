package docker

import (
	"context"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"testing"
)

func TestRuntimePeerUsesOnlyTheConfiguredManagementNetwork(t *testing.T) {
	driver := newTestDriver(t, newFakeEngine())
	container := exactContainer()
	container.NetworkIPv4["another-network"] = "10.242.1.40"
	first, err := driver.inspectContainer(*container)
	if err != nil || first.RuntimeEndpoint != "10.243.1.20" {
		t.Fatal("wrong Runtime management address", first.RuntimeEndpoint, err)
	}
	container.NetworkIPv4["antnest-runtime-management"] = "10.243.1.21"
	current, err := driver.inspectContainer(*container)
	if err != nil || current.RuntimeEndpoint != "10.243.1.21" {
		t.Fatal("Runtime address remained stale after restart", current.RuntimeEndpoint, err)
	}
	container.Running = false
	container.Status = "exited"
	stopped, err := driver.inspectContainer(*container)
	if err != nil || stopped.RuntimeEndpoint != "" {
		t.Fatal("stopped compute advertised a peer", stopped.RuntimeEndpoint, err)
	}
}

func TestRuntimePeerMarksOnlyTheUnbindableContainerUnknown(t *testing.T) {
	driver := newTestDriver(t, newFakeEngine())
	for _, value := range []string{"", "0.0.0.0", "127.0.0.1", "255.255.255.255", "224.0.0.1", "::1", "010.243.1.20", " 10.243.1.20 "} {
		t.Run(value, func(t *testing.T) {
			container := exactContainer()
			container.NetworkIPv4 = map[string]string{
				"antnest-runtime-management": value, "another-network": "10.242.1.40",
			}
			inspection, err := driver.inspectContainer(*container)
			if err != nil || inspection.RuntimeEndpoint != "" || inspection.Health != deployment.HealthUnknown || inspection.Reason != "runtime_peer_unavailable" || inspection.PlatformPhase != deployment.PhaseRunning {
				t.Fatal("unbindable container failed or advertised a peer", inspection, err)
			}
		})
	}
}

func TestRestartingRuntimeKeepsItsConditionWithoutAPeer(t *testing.T) {
	driver := newTestDriver(t, newFakeEngine())
	container := exactContainer()
	// Docker reports Running=true for a restarting container that has already
	// left its networks.
	container.Status, container.Running, container.Health = "restarting", true, "unhealthy"
	delete(container.NetworkIPv4, "antnest-runtime-management")
	inspection, err := driver.inspectContainer(*container)
	if err != nil || inspection.RuntimeEndpoint != "" || inspection.PlatformPhase != deployment.PhaseCreated ||
		inspection.Health != deployment.HealthStarting || inspection.Reason != "runtime_restarting" {
		t.Fatal("restart loop was hidden behind a missing peer", inspection, err)
	}
	container.NetworkIPv4["antnest-runtime-management"] = "10.243.1.20"
	if inspection, err := driver.inspectContainer(*container); err != nil || inspection.RuntimeEndpoint != "" {
		t.Fatal("restarting compute advertised a peer", inspection, err)
	}
}

type peerInventoryEngine struct {
	*fakeEngine
	containers []Container
}

func (engine *peerInventoryEngine) ListManagedContainers(context.Context) ([]Container, error) {
	return engine.containers, nil
}

func TestListPreservesHealthyRuntimeWhenAnotherContainerHasNoManagementPeer(t *testing.T) {
	invalid := exactContainer()
	delete(invalid.NetworkIPv4, "antnest-runtime-management")
	healthy := exactContainer()
	healthy.ID, healthy.Name = "container-2", containerName("agent-2")
	healthy.Labels[labelAgentID] = "agent-2"
	engine := &peerInventoryEngine{fakeEngine: newFakeEngine(), containers: []Container{*invalid, *healthy}}
	driver, err := NewDriver(engine, testDriverConfig())
	if err != nil {
		t.Fatal(err)
	}
	inspections, err := driver.List(t.Context())
	if err != nil || len(inspections) != 2 {
		t.Fatal("one disconnected Runtime hid the inventory", inspections, err)
	}
	if inspections[0].RuntimeEndpoint != "" || inspections[0].Reason != "runtime_peer_unavailable" || inspections[1].RuntimeEndpoint != "10.243.1.20" || inspections[1].Health != deployment.HealthHealthy {
		t.Fatal(inspections)
	}
}
