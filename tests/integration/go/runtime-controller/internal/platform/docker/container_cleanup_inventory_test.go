package docker

import (
	"maps"
	"reflect"
	"slices"
	"testing"
)

func TestSameContainerCleanupRetainedContainer(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		change func(*Container)
		want   bool
	}{
		{"identical", func(*Container) {}, true},
		{"mount order only", func(container *Container) {
			container.Mounts[0], container.Mounts[1] = container.Mounts[1], container.Mounts[0]
		}, true},
		{"mount Type", func(container *Container) { container.Mounts[0].Type = "bind" }, false},
		{"mount Name", func(container *Container) { container.Mounts[0].Name = "other-volume" }, false},
		{"mount Destination", func(container *Container) { container.Mounts[0].Destination = "/other-destination" }, false},
		{"mount ReadWrite", func(container *Container) { container.Mounts[0].ReadWrite = !container.Mounts[0].ReadWrite }, false},
		{"mount NoCopy", func(container *Container) { container.Mounts[0].NoCopy = !container.Mounts[0].NoCopy }, false},
		{"added mount", func(container *Container) {
			container.Mounts = append(container.Mounts, ObservedMount{Type: "volume", Name: "added-volume", Destination: "/added", ReadWrite: true})
		}, false},
		{"removed mount", func(container *Container) { container.Mounts = container.Mounts[:1] }, false},
		{"appended duplicate mount", func(container *Container) { container.Mounts = append(container.Mounts, container.Mounts[0]) }, false},
		{"duplicate replaces distinct mount", func(container *Container) { container.Mounts[1] = container.Mounts[0] }, false},
		{"container ID", func(container *Container) { container.ID = "other-container-ID" }, false},
		{"container name", func(container *Container) { container.Name = "other-container-name" }, false},
		{"container running", func(container *Container) { container.Running = !container.Running }, false},
		{"container status", func(container *Container) { container.Status = "exited" }, false},
		{"container exit code", func(container *Container) { container.ExitCode = 137 }, false},
		{"container OOM", func(container *Container) { container.OOMKilled = !container.OOMKilled }, false},
		{"container error", func(container *Container) { container.Error = "different container error" }, false},
		{"container health", func(container *Container) { container.Health = "unhealthy" }, false},
		{"container restart count", func(container *Container) { container.RestartCount++ }, false},
		{"changed label", func(container *Container) { container.Labels["io.antnest.test"] = "different-owner" }, false},
		{"added label", func(container *Container) { container.Labels["additional-label"] = "additional-value" }, false},
		{"removed label", func(container *Container) { delete(container.Labels, "io.antnest.test") }, false},
		{"changed network address", func(container *Container) { container.NetworkIPv4["fixture-network"] = "192.0.2.11" }, false},
		{"added network", func(container *Container) { container.NetworkIPv4["other-network"] = "198.51.100.10" }, false},
		{"removed network", func(container *Container) { delete(container.NetworkIPv4, "fixture-network") }, false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			base := Container{
				ID: "retained-container-ID", Name: "retained-container-name", Status: "created",
				Running: false, ExitCode: 0, OOMKilled: false, Error: "", Health: "healthy", RestartCount: 2,
				Labels:      map[string]string{"io.antnest.test": "fixture-owner", "fixture-label": "retained"},
				NetworkIPv4: map[string]string{"fixture-network": "192.0.2.10"},
				Mounts: []ObservedMount{
					{Type: "volume", Name: "retained-named-volume", Destination: "/fixture", ReadWrite: true, NoCopy: true},
					{Type: "volume", Name: "retained-anonymous-volume", Destination: "/var/lib/postgresql/data", ReadWrite: true, NoCopy: false},
				},
			}
			left, right := cloneContainerCleanupRetainedFixture(base), cloneContainerCleanupRetainedFixture(base)
			scenario.change(&right)
			beforeLeft, beforeRight := cloneContainerCleanupRetainedFixture(left), cloneContainerCleanupRetainedFixture(right)

			if got := sameContainerCleanupRetainedContainer(left, right); got != scenario.want {
				t.Errorf("retained comparison = %t, want %t", got, scenario.want)
			}
			if !reflect.DeepEqual(left, beforeLeft) || !reflect.DeepEqual(right, beforeRight) {
				t.Error("retained comparison mutated an input container, map or mount slice")
			}
			if got := sameContainerCleanupRetainedContainer(right, left); got != scenario.want {
				t.Errorf("reversed retained comparison = %t, want %t", got, scenario.want)
			}
			if !reflect.DeepEqual(left, beforeLeft) || !reflect.DeepEqual(right, beforeRight) {
				t.Error("reversed retained comparison mutated an input container, map or mount slice")
			}
			if !reflect.DeepEqual(base, cloneContainerCleanupRetainedFixture(beforeLeft)) {
				t.Error("independent fixture copies changed their original baseline")
			}
		})
	}
}

func cloneContainerCleanupRetainedFixture(container Container) Container {
	container.Labels = maps.Clone(container.Labels)
	container.NetworkIPv4 = maps.Clone(container.NetworkIPv4)
	container.Mounts = slices.Clone(container.Mounts)
	return container
}
