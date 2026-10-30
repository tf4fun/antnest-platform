package ports

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestLifecycleTerminatedCoversTerminalReliabilityCodes(t *testing.T) {
	for _, code := range []string{
		"lifecycle_cancelled", "phase_deadline_exceeded", "lifecycle_invariant_failed",
	} {
		require.True(t, (AgentRecord{FailureCode: code}).LifecycleTerminated(), code)
	}
	for _, code := range []string{"", "build_failed", "image_missing", "effect_rejected"} {
		require.False(t, (AgentRecord{FailureCode: code}).LifecycleTerminated(), code)
	}
}

func reliabilityClearableBase() AgentLifecycleBase {
	return AgentLifecycleBase{
		Agent: AgentRecord{
			AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
			ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown,
			AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-rev-1",
			AggregateSequence: 7, FailureCode: "lifecycle_invariant_failed",
		},
		ConfiguredSpec: AgentSpecRecord{ID: "spec-1", AgentID: "agent-1", Revision: 1},
	}
}

func TestCanClearLifecycleQuarantine(t *testing.T) {
	require.True(t, CanClearLifecycleQuarantine(reliabilityClearableBase()))
	base := reliabilityClearableBase()
	base.Agent.DesiredState = domain.DesiredDisabled
	base.Agent.ActivationState = domain.ActivationDisabled
	require.True(t, CanClearLifecycleQuarantine(base))
	for _, scenario := range []struct {
		name   string
		mutate func(*AgentLifecycleBase)
	}{
		{"no invariant failure", func(base *AgentLifecycleBase) { base.Agent.FailureCode = "build_failed" }},
		{"empty failure code", func(base *AgentLifecycleBase) { base.Agent.FailureCode = "" }},
		{"active operation", func(base *AgentLifecycleBase) { base.Agent.ActiveOperationRequestID = "request-1" }},
		{"not created lifecycle", func(base *AgentLifecycleBase) { base.Agent.LifecycleState = domain.AgentDeleted }},
		{"identity revoked", func(base *AgentLifecycleBase) {
			base.Agent.OwnerAuthorizationSequence = 1
			base.Agent.IdentityRevocationSequence = 2
		}},
		{"executable revision remains", func(base *AgentLifecycleBase) { base.Agent.ExecutionRevisionID = "exec-1" }},
		{"runtime execution remains", func(base *AgentLifecycleBase) { base.Agent.RuntimeExecutionID = "rt-1" }},
		{"mcp endpoint remains", func(base *AgentLifecycleBase) { base.Agent.RuntimeMCPEndpoint = "mcp" }},
		{"activation disabled while desired enabled", func(base *AgentLifecycleBase) {
			base.Agent.ActivationState = domain.ActivationDisabled
		}},
		{"activation enabled while desired disabled", func(base *AgentLifecycleBase) {
			base.Agent.DesiredState = domain.DesiredDisabled
			base.Agent.ActivationState = domain.ActivationEnabled
		}},
		{"desired deleted", func(base *AgentLifecycleBase) {
			base.Agent.DesiredState = domain.DesiredDeleted
			base.Agent.ActivationState = domain.ActivationDisabled
		}},
		{"spec missing", func(base *AgentLifecycleBase) { base.ConfiguredSpec.ID = "" }},
		{"spec id mismatch", func(base *AgentLifecycleBase) { base.ConfiguredSpec.ID = "spec-other" }},
		{"spec belongs to other agent", func(base *AgentLifecycleBase) {
			base.ConfiguredSpec.AgentID = "agent-other"
		}},
		{"runtime revision empty", func(base *AgentLifecycleBase) { base.Agent.RuntimeRevision = "" }},
		{"source lineage mismatch", func(base *AgentLifecycleBase) {
			base.Agent.LastSuccessfulExecutionRevisionID = "exec-last"
			base.SourceExecution = ExecutionRecord{ID: "exec-last", AgentID: "agent-1",
				AgentSpecRevisionID: "spec-other", RuntimeRevision: "runtime-rev-1"}
		}},
		{"source other agent", func(base *AgentLifecycleBase) {
			base.Agent.LastSuccessfulExecutionRevisionID = "exec-last"
			base.SourceExecution = ExecutionRecord{ID: "exec-last", AgentID: "agent-other",
				AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-rev-1"}
		}},
		{"missing source with prior success", func(base *AgentLifecycleBase) {
			base.Agent.LastSuccessfulExecutionRevisionID = "exec-last"
		}},
		{"source without prior success", func(base *AgentLifecycleBase) {
			base.SourceExecution = ExecutionRecord{ID: "exec-ghost", AgentID: "agent-1",
				AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-rev-1"}
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			base := reliabilityClearableBase()
			scenario.mutate(&base)
			require.False(t, CanClearLifecycleQuarantine(base))
		})
	}
	source := reliabilityClearableBase()
	source.Agent.LastSuccessfulExecutionRevisionID = "exec-last"
	source.SourceExecution = ExecutionRecord{ID: "exec-last", AgentID: "agent-1",
		AgentSpecRevisionID: "spec-1", RuntimeRevision: "runtime-rev-1"}
	require.True(t, CanClearLifecycleQuarantine(source))
}

func TestValidQuarantineRuntimeInspection(t *testing.T) {
	agent := reliabilityClearableBase().Agent
	valid := RuntimeInspection{
		AgentID: "agent-1", RuntimeRevision: "runtime-rev-1", Phase: "absent",
		LifecycleState: "disabled", Health: "absent", ObservedAt: time.Unix(50, 0).UTC(),
	}
	require.True(t, ValidQuarantineRuntimeInspection(agent, valid))
	for _, scenario := range []struct {
		lifecycle string
		phase     string
		health    string
	}{
		{"disabled", "absent", "absent"}, {"disabled", "absent", "unhealthy"},
		{"failed", "exited", "unhealthy"}, {"deleted", "absent", "absent"},
	} {
		inspection := valid
		inspection.LifecycleState = scenario.lifecycle
		inspection.Phase = scenario.phase
		inspection.Health = scenario.health
		require.True(t, ValidQuarantineRuntimeInspection(agent, inspection),
			"lifecycle=%s phase=%s health=%s", scenario.lifecycle, scenario.phase, scenario.health)
	}
	for _, scenario := range []struct {
		name   string
		mutate func(*RuntimeInspection)
	}{
		{"another agent", func(i *RuntimeInspection) { i.AgentID = "agent-other" }},
		{"runtime revision drift", func(i *RuntimeInspection) { i.RuntimeRevision = "other" }},
		{"missing observation time", func(i *RuntimeInspection) { i.ObservedAt = time.Time{} }},
		{"execution identity", func(i *RuntimeInspection) { i.RuntimeExecutionID = "exec" }},
		{"runtime endpoint", func(i *RuntimeInspection) { i.RuntimeEndpoint = "endpoint" }},
		{"mcp endpoint", func(i *RuntimeInspection) { i.MCPEndpoint = "mcp" }},
		{"disabled healthy", func(i *RuntimeInspection) { i.Health = "healthy" }},
		{"disabled empty health", func(i *RuntimeInspection) { i.Health = "" }},
		{"disabled starting", func(i *RuntimeInspection) { i.Health = "starting" }},
		{"disabled unknown health", func(i *RuntimeInspection) { i.Health = "unknown" }},
		{"failed absent health", func(i *RuntimeInspection) {
			i.LifecycleState = "failed"
			i.Health = "absent"
		}},
		{"failed healthy", func(i *RuntimeInspection) {
			i.LifecycleState = "failed"
			i.Health = "healthy"
		}},
		{"failed empty health", func(i *RuntimeInspection) {
			i.LifecycleState = "failed"
			i.Health = ""
		}},
		{"deleted unhealthy", func(i *RuntimeInspection) {
			i.LifecycleState = "deleted"
			i.Health = "unhealthy"
		}},
		{"deleted empty health", func(i *RuntimeInspection) {
			i.LifecycleState = "deleted"
			i.Health = ""
		}},
		{"unknown lifecycle", func(i *RuntimeInspection) { i.LifecycleState = "created" }},
		{"provisioned lifecycle", func(i *RuntimeInspection) { i.LifecycleState = "provisioned" }},
		{"empty lifecycle", func(i *RuntimeInspection) { i.LifecycleState = "" }},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			inspection := valid
			scenario.mutate(&inspection)
			require.False(t, ValidQuarantineRuntimeInspection(agent, inspection))
		})
	}
	for _, phase := range []string{
		"starting", "running", "initializing", "updating", "enabling", "disabling", "deleting",
	} {
		t.Run("phase "+phase, func(t *testing.T) {
			inspection := valid
			inspection.Phase = phase
			require.False(t, ValidQuarantineRuntimeInspection(agent, inspection))
		})
	}
	for _, phase := range []string{"stopped", "created", "unknown", ""} {
		inspection := valid
		inspection.Phase = phase
		require.False(t, ValidQuarantineRuntimeInspection(agent, inspection), phase)
	}
	for _, scenario := range []struct {
		name string
		mut  func(*RuntimeInspection)
	}{
		{"disabled exited", func(i *RuntimeInspection) { i.Phase = "exited" }},
		{"failed absent phase", func(i *RuntimeInspection) {
			i.LifecycleState, i.Phase, i.Health = "failed", "absent", "unhealthy"
		}},
		{"failed unknown phase", func(i *RuntimeInspection) {
			i.LifecycleState, i.Phase, i.Health = "failed", "unknown", "unhealthy"
		}},
		{"failed stopped", func(i *RuntimeInspection) {
			i.LifecycleState, i.Phase, i.Health = "failed", "stopped", "unhealthy"
		}},
		{"failed created phase", func(i *RuntimeInspection) {
			i.LifecycleState, i.Phase, i.Health = "failed", "created", "unhealthy"
		}},
		{"deleted exited", func(i *RuntimeInspection) {
			i.LifecycleState, i.Phase, i.Health = "deleted", "exited", "absent"
		}},
		{"deleted unknown", func(i *RuntimeInspection) {
			i.LifecycleState, i.Phase, i.Health = "deleted", "unknown", "absent"
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			inspection := valid
			scenario.mut(&inspection)
			require.False(t, ValidQuarantineRuntimeInspection(agent, inspection))
		})
	}
}

func TestLifecycleTerminatedAgentsDoNotAwaitOrObserveRuntime(t *testing.T) {
	agent := AgentRecord{
		AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
		ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown,
		AgentSpecRevisionID: "spec-1",
		RuntimeRevision:     "runtime-rev-1",
	}
	require.True(t, agent.AwaitingRuntimeBinding())
	require.True(t, agent.CanObserveRuntime())
	for _, code := range []string{"lifecycle_cancelled", "phase_deadline_exceeded", "lifecycle_invariant_failed"} {
		terminated := agent
		terminated.FailureCode = code
		require.False(t, terminated.AwaitingRuntimeBinding(), code)
		require.False(t, terminated.CanObserveRuntime(), code)
	}
}
