package postgres

import (
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleSettlementBoundarySurvivesWorkerRestartAndPlatformRejection(t *testing.T) {
	for _, kind := range []domain.OperationKind{domain.OperationRebuild, domain.OperationDisable} {
		for _, outcome := range []string{ports.ExecutionSettled, ports.ExecutionRuntimeBarrierRequired} {
			t.Run(string(kind)+"/"+outcome, func(t *testing.T) {
				repository := providerTestRepository(t)
				base, seed := seedAvailableAgentForRebuild(t, t.Context(), repository)
				deps := newRuntimeRebuildDependencies(base.Agent)
				deps.network.AttachmentState = ports.NetworkAttachmentOpen
				deps.rejectDisable = true
				deps.runtime = ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "image_not_found"}
				deps.inspection = &ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision, RuntimeExecutionID: base.SourceExecution.RuntimeExecutionID, MCPEndpoint: base.SourceExecution.RuntimeMCPEndpoint, LifecycleState: "provisioned", Phase: "running", RuntimeEndpoint: "10.20.0.9", TunnelKeyID: "rtk_0123456789abcdef0123456789abcdef", Health: "healthy"}
				service := newIntegratedLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
				requestID := "settlement-restart"
				if kind == domain.OperationRebuild {
					_, err := service.RebuildAgent(t.Context(), application.RebuildAgentInput{RequestID: requestID, AgentID: base.Agent.AgentID, TemplateID: seed.Revision.Snapshot().TemplateID, TemplateRevision: seed.Revision.Revision()})
					require.NoError(t, err)
				} else {
					_, err := service.DisableAgent(t.Context(), application.DisableAgentInput{RequestID: requestID, AgentID: base.Agent.AgentID})
					require.NoError(t, err)
				}
				operation, err := repository.GetLifecycleOperation(t.Context(), requestID)
				require.NoError(t, err)
				_, err = repository.ConfirmLifecycleDrain(t.Context(), ports.ConfirmLifecycleDrain{RequestID: requestID, Fingerprint: operation.RequestFingerprint, Kind: kind, Outcome: outcome, Now: offboardingClock{}.Now()})
				require.NoError(t, err)
				restarted := newIntegratedLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
				finishOffboardingOperation(t, repository, restarted, requestID, domain.OperationFailed)
				stored, err := repository.GetLifecycleOperation(t.Context(), requestID)
				require.NoError(t, err)
				require.Equal(t, outcome, stored.SettlementOutcome)
				require.Equal(t, operation.DrainDeadlineAt, stored.DrainDeadlineAt)
				agent, err := repository.GetAgent(t.Context(), base.Agent.AgentID)
				require.NoError(t, err)
				require.Equal(t, base.Agent.RuntimeRevision, agent.RuntimeRevision)
				require.Equal(t, base.Agent.AgentSpecRevisionID, agent.AgentSpecRevisionID)
				want := ports.NetworkAttachmentOpen
				if outcome == ports.ExecutionRuntimeBarrierRequired {
					want = ports.NetworkAttachmentClosed
				}
				require.Equal(t, want, deps.network.AttachmentState)
			})
		}
	}
}
