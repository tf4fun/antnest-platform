package docker

import (
	"fmt"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

type runtimeCondition struct {
	phase  deployment.PlatformPhase
	health deployment.HealthState
	reason string
	detail string
}

func containerCondition(container Container) runtimeCondition {
	switch container.Status {
	case "created", "restarting":
		reason := "runtime_starting"
		if container.Status == "restarting" {
			reason = "runtime_restarting"
		}
		return runtimeCondition{deployment.PhaseCreated, deployment.HealthStarting, reason, container.Error}
	case "exited", "dead":
		reason := "runtime_exited"
		if container.OOMKilled {
			reason = "runtime_oom_killed"
		}
		return runtimeCondition{deployment.PhaseExited, deployment.HealthUnknown, reason,
			fmt.Sprintf("Process exited with code %d. %s", container.ExitCode, container.Error)}
	case "paused":
		return runtimeCondition{deployment.PhaseRunning, deployment.HealthUnhealthy, "runtime_paused", container.Error}
	case "running":
		return runningCondition(container)
	default:
		return runtimeCondition{deployment.PhaseUnknown, deployment.HealthUnknown, "runtime_status_unknown", container.Error}
	}
}

func runningCondition(container Container) runtimeCondition {
	condition := runtimeCondition{deployment.PhaseRunning, deployment.HealthUnknown, "runtime_status_unknown", container.Error}
	switch container.Health {
	case "healthy":
		condition.health, condition.reason = deployment.HealthHealthy, ""
	case "starting":
		condition.health, condition.reason = deployment.HealthStarting, "runtime_starting"
	case "unhealthy":
		condition.health, condition.reason = deployment.HealthUnhealthy, "runtime_unhealthy"
	}
	return condition
}
