package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type recoveryCASStore struct {
	*Repository
	beforeBegin func()
}

func (store recoveryCASStore) BeginAgentRebuild(ctx context.Context, input ports.BeginAgentRebuild) (ports.AgentRebuildState, bool, error) {
	store.beforeBegin()
	return store.Repository.BeginAgentRebuild(ctx, input)
}

func TestRuntimeLossRebuildRechecksHistoricalSourceUnderRowLock(t *testing.T) {
	cases := []struct {
		name string
		set  string
	}{
		{"aggregate", "aggregate_sequence=aggregate_sequence+1"},
		{"last_successful", "last_successful_execution_revision_id='another-execution'"},
		{"runtime", "runtime_revision='rtv_33333333333333333333333333333333'"},
		{"spec", "executable_spec_revision_id='another-spec'"},
		{"revoked", "identity_revocation_sequence=owner_authorization_sequence+1"},
		{"concurrent_operation", "active_operation_request_id='another-operation'"},
		{"quarantined", "failure_code='lifecycle_invariant_failed'"},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			ctx, repository, _ := controllerTestConnection(t)
			base, seed := seedAvailableAgentForRebuild(t, ctx, repository)
			if err := repository.ApplyRuntimeObservation(ctx, ports.RuntimeObservation{
				Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
				Kind: "runtime_missing", ObservedAt: time.Now().UTC(),
			}); err != nil {
				t.Fatal(err)
			}
			store := recoveryCASStore{Repository: repository, beforeBegin: func() {
				if _, err := repository.pool.Exec(ctx, "UPDATE agent_controller.agents SET "+test.set+" WHERE id=$1", base.Agent.AgentID); err != nil {
					t.Fatal(err)
				}
			}}
			deps := newRuntimeRebuildDependencies(base.Agent)
			service := application.NewLifecycleService(repository, store, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
			_, err := service.RebuildAgent(ctx, application.RebuildAgentInput{
				RequestID: "stale-recovery", AgentID: base.Agent.AgentID,
				TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision(),
			})
			if !errors.Is(err, ports.ErrConcurrentChange) {
				t.Fatalf("stale recovery source accepted: %v", err)
			}
			if _, err := repository.GetLifecycleOperation(ctx, "stale-recovery"); !errors.Is(err, ports.ErrNotFound) {
				t.Fatalf("rejected admission persisted an operation: %v", err)
			}
			var specs int
			if err := repository.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.agent_spec_revisions WHERE agent_id=$1", base.Agent.AgentID).Scan(&specs); err != nil || specs != 1 {
				t.Fatalf("rejected admission appended a target spec: count=%d error=%v", specs, err)
			}
			if deps.updateCalls != 0 {
				t.Fatal("stale admission reached Runtime Controller")
			}
		})
	}
}
