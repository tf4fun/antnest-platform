package postgres

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleDoesNotReadOrWriteRunAdmissions(t *testing.T) {
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable, domain.OperationDelete} {
		for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired} {
			t.Run(string(kind)+"/"+outcome, func(t *testing.T) {
				repository := providerTestRepository(t)
				base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
				assertManagementOnlySchema(t, repository)
				var err error
				deps := &lifecycleBoundaryDependencies{runtimeRebuildDependencies: newRuntimeRebuildDependencies(base.Agent)}
				peer := &lifecycleACPStub{outcome: outcome}
				publisher := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, peer)
				service := newIntegratedLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(publisher))
				requestID := "no-run-table"
				switch kind {
				case domain.OperationRebuild:
					_, err = service.RebuildAgent(t.Context(), application.RebuildAgentInput{RequestID: requestID, AgentID: base.Agent.AgentID, TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()})
				case domain.OperationDisable:
					_, err = service.DisableAgent(t.Context(), application.DisableAgentInput{RequestID: requestID, AgentID: base.Agent.AgentID})
				case domain.OperationDelete:
					_, err = service.DeleteAgent(t.Context(), application.DeleteAgentInput{RequestID: requestID, AgentID: base.Agent.AgentID})
				}
				require.NoError(t, err)
				finishOffboardingOperation(t, repository, service, requestID, domain.OperationCompleted)
				operation, err := repository.GetLifecycleOperation(t.Context(), requestID)
				require.NoError(t, err)
				require.Equal(t, outcome, operation.SettlementOutcome)
				assertManagementOnlySchema(t, repository)
			})
		}
	}
}

type lifecycleBoundaryDependencies struct{ *runtimeRebuildDependencies }

func TestLifecycleRuntimeResultCannotAdvanceDetachedOperation(t *testing.T) {
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable, domain.OperationDelete} {
		t.Run(string(kind), func(t *testing.T) {
			repository := providerTestRepository(t)
			base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
			deps := &lifecycleBoundaryDependencies{runtimeRebuildDependencies: newRuntimeRebuildDependencies(base.Agent)}
			service := newIntegratedLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
			command := application.LifecycleCommand{Kind: kind, RequestID: "detached-runtime-result", AgentID: base.Agent.AgentID, TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()}
			_, err := service.AdmitLifecycle(t.Context(), command)
			require.NoError(t, err)
			for _, phase := range []domain.OperationPhase{domain.PhaseDrain, domain.PhaseNetworkFence} {
				_, err = service.AdvanceLifecycle(t.Context(), command, phase)
				require.NoError(t, err)
			}
			before, err := repository.GetLifecycleOperation(t.Context(), command.RequestID)
			require.NoError(t, err)
			_, err = repository.pool.Exec(t.Context(), `UPDATE agent_controller.agents SET active_operation_request_id='' WHERE id=$1`, base.Agent.AgentID)
			require.NoError(t, err)
			_, err = service.AdvanceLifecycle(t.Context(), command, before.Phase)
			require.ErrorIs(t, err, ports.ErrConcurrentChange)
			after, err := repository.GetLifecycleOperation(t.Context(), command.RequestID)
			require.NoError(t, err)
			require.Equal(t, before, after, "detached operation must not publish a Runtime result")
		})
	}
}

func (deps *lifecycleBoundaryDependencies) DeleteRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{State: "completed", Effect: "completed", LifecycleState: "deleted", Health: "absent", RuntimeRevision: deps.expectedRevision}, nil
}

func (deps *lifecycleBoundaryDependencies) ReleaseAgentNetwork(context.Context, string, uint64) (ports.NetworkAttachment, error) {
	deps.network.State = ports.NetworkStateQuarantined
	return deps.network, nil
}
