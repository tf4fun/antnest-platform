package application

import (
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func recoverableRebuildBase(t *testing.T) ports.AgentLifecycleBase {
	t.Helper()
	base := rebuildLifecycleBase(t, mustLifecycleTemplate(t), mustLifecycleModel(t))
	base.Agent.LifecycleState, base.Agent.ActivationState, base.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	base.Agent.ExecutionRevisionID = ""
	base.Agent.RuntimeExecutionID = ""
	base.Agent.RuntimeMCPEndpoint = ""
	base.Agent.FailureCode = "runtime_missing"
	return base
}

func TestRecoverySourceRequiresExactRetainedLineage(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name   string
		change func(*ports.AgentLifecycleBase)
	}{
		{"no_spec", func(b *ports.AgentLifecycleBase) { b.ConfiguredSpec = ports.AgentSpecRecord{} }},
		{"wrong_execution_pointer", func(b *ports.AgentLifecycleBase) { b.Agent.LastSuccessfulExecutionRevisionID = "another" }},
		{"foreign_execution", func(b *ports.AgentLifecycleBase) { b.SourceExecution.AgentID = "foreign" }},
		{"foreign_spec", func(b *ports.AgentLifecycleBase) { b.ConfiguredSpec.AgentID = "foreign" }},
		{"wrong_spec_pointer", func(b *ports.AgentLifecycleBase) { b.Agent.AgentSpecRevisionID = "another" }},
		{"wrong_spec_lineage", func(b *ports.AgentLifecycleBase) { b.SourceExecution.AgentSpecRevisionID = "another" }},
		{"wrong_runtime", func(b *ports.AgentLifecycleBase) { b.Agent.RuntimeRevision = "another" }},
		{"quarantined", func(b *ports.AgentLifecycleBase) { b.Agent.FailureCode = "lifecycle_invariant_failed" }},
		{"disabled", func(b *ports.AgentLifecycleBase) { b.Agent.DesiredState = domain.DesiredDisabled }},
		{"deleted", func(b *ports.AgentLifecycleBase) { b.Agent.DesiredState = domain.DesiredDeleted }},
		{"revoked", func(b *ports.AgentLifecycleBase) {
			b.Agent.IdentityRevocationSequence = b.Agent.OwnerAuthorizationSequence + 1
		}},
		{"stale_endpoint", func(b *ports.AgentLifecycleBase) { b.Agent.RuntimeMCPEndpoint = "http://old/mcp" }},
		{"stale_process", func(b *ports.AgentLifecycleBase) { b.Agent.RuntimeExecutionID = "old-process" }},
		{"nonincreasing_revision", func(b *ports.AgentLifecycleBase) { b.NextSpecRevision = b.ConfiguredSpec.Revision }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			base := recoverableRebuildBase(t)
			test.change(&base)
			if _, err := resolveRebuildSource(base); !errors.Is(err, ErrAgentNotReady) {
				t.Fatalf("invalid recovery source accepted: %v", err)
			}
		})
	}
}

func TestRecoverySourcePreservesUnavailableStateAndRejectsConcurrentLifecycle(t *testing.T) {
	t.Parallel()
	base := recoverableRebuildBase(t)
	source, err := resolveRebuildSource(base)
	if err != nil || source.Execution.ID != base.Agent.LastSuccessfulExecutionRevisionID ||
		base.Agent.ExecutionRevisionID != "" || base.SourceExecution.ID == "" {
		t.Fatalf("source=%+v error=%v", source, err)
	}
	base.Agent.ActiveOperationRequestID = "other-operation"
	if _, err := resolveRebuildSource(base); !errors.Is(err, ErrLifecycleConflict) {
		t.Fatalf("active lifecycle was not fenced: %v", err)
	}
}
