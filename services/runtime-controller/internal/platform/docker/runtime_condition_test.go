package docker

import (
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRuntimeConditionSeparatesContainerPhaseFromHealth(t *testing.T) {
	for _, test := range []struct {
		name, status, health string
		running              bool
		phase                deployment.PlatformPhase
		wantHealth           deployment.HealthState
		reason               string
	}{
		{"not started", "created", "", false, deployment.PhaseCreated, deployment.HealthStarting, "runtime_starting"},
		{"initializing", "running", "starting", true, deployment.PhaseRunning, deployment.HealthStarting, "runtime_starting"},
		{"healthy", "running", "healthy", true, deployment.PhaseRunning, deployment.HealthHealthy, ""},
		{"unhealthy", "running", "unhealthy", true, deployment.PhaseRunning, deployment.HealthUnhealthy, "runtime_unhealthy"},
		{"exited", "exited", "healthy", false, deployment.PhaseExited, deployment.HealthUnknown, "runtime_exited"},
		{"dead", "dead", "", false, deployment.PhaseExited, deployment.HealthUnknown, "runtime_exited"},
		{"restarting", "restarting", "healthy", true, deployment.PhaseCreated, deployment.HealthStarting, "runtime_restarting"},
		{"paused", "paused", "healthy", true, deployment.PhaseRunning, deployment.HealthUnhealthy, "runtime_paused"},
		{"unrecognized", "unexpected", "healthy", false, deployment.PhaseUnknown, deployment.HealthUnknown, "runtime_status_unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			container := exactContainer()
			container.Status, container.Running, container.Health = test.status, test.running, test.health
			driver := newTestDriver(t, newFakeEngine())
			got, err := driver.inspectContainer(*container)
			if err != nil {
				t.Fatal(err)
			}
			if got.PlatformPhase != test.phase || got.Health != test.wantHealth || got.Reason != test.reason {
				t.Fatalf("condition = %+v, want phase=%s health=%s reason=%s", got, test.phase, test.wantHealth, test.reason)
			}
		})
	}
}
