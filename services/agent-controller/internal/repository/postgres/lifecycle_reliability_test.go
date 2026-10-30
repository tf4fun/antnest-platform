package postgres

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestAcceptsRuntimeConditionRejectsTerminatedLifecycles(t *testing.T) {
	agent := ports.AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1",
		LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled,
		RuntimeRevision: "runtime-rev-1",
	}
	inspection := ports.RuntimeInspection{
		AgentID: "agent-1", RuntimeRevision: "runtime-rev-1",
		Phase: "running", LifecycleState: "provisioned", Health: "healthy",
		ObservedAt: time.Now().UTC(),
	}
	require.True(t, acceptsRuntimeCondition(agent, inspection))
	for _, code := range []string{
		"lifecycle_cancelled", "phase_deadline_exceeded", "lifecycle_invariant_failed",
	} {
		t.Run(code, func(t *testing.T) {
			terminated := agent
			terminated.FailureCode = code
			require.False(t, acceptsRuntimeCondition(terminated, inspection))
		})
	}
}
