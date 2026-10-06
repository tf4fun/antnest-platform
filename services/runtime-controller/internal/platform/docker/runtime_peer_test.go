package docker

import "testing"

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

func TestRuntimePeerRejectsMissingOrNoncanonicalManagementIPv4(t *testing.T) {
	driver := newTestDriver(t, newFakeEngine())
	for _, value := range []string{"", "0.0.0.0", "127.0.0.1", "255.255.255.255", "224.0.0.1", "::1", "010.243.1.20", " 10.243.1.20 "} {
		t.Run(value, func(t *testing.T) {
			container := exactContainer()
			container.NetworkIPv4 = map[string]string{
				"antnest-runtime-management": value, "another-network": "10.242.1.40",
			}
			if _, err := driver.inspectContainer(*container); err == nil {
				t.Fatal("invalid management address accepted")
			}
		})
	}
}
