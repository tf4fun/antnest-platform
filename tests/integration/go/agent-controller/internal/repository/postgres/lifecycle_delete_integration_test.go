package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRepositoryPersistsDeleteBarrierAndRetainsAuditFacts(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Now().Add(-15 * time.Second).UTC().Truncate(time.Microsecond)
	requestID := "request-delete-integration"
	fingerprint := strings.Repeat("d", 64)
	begin := deleteBegin(base.Agent, requestID, fingerprint, now)
	started, replayed, err := repository.BeginAgentDelete(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin Agent delete: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	if started.Agent.DesiredState != domain.DesiredDeleted ||
		started.Agent.LifecycleState != domain.AgentCreated ||
		started.Agent.ActiveOperationRequestID != requestID {
		t.Fatalf("started delete = %+v", started)
	}

	operation, err := repository.ConfirmLifecycleDrain(
		ctx, ports.ConfirmLifecycleDrain{RequestID: requestID, Fingerprint: fingerprint, Kind: domain.OperationDelete, Outcome: ports.ExecutionSettled, Now: now.Add(time.Second)})

	if err != nil || operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle delete drain: operation=%+v err=%v", operation, err)
	}
	state, err := repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDelete,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDelete),
		Now:                now.Add(2 * time.Second),
	})
	if err != nil || state.Operation.Phase != domain.PhaseRuntimeDelete {
		t.Fatalf("record delete fence: state=%+v err=%v", state, err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_99999999999999999999999999999999",
		LifecycleState:  "deleted", Health: "absent",
	}
	runtimeAdvance := ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeDelete, NextPhase: domain.PhaseNetworkRelease,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRelease),
		RuntimeResult:      &runtime,
		Now:                now.Add(4 * time.Second),
	}
	invalidRuntime := runtime
	invalidRuntime.LifecycleState = "provisioned"
	invalid := runtimeAdvance
	invalid.RuntimeResult = &invalidRuntime
	if _, err := repository.AdvanceAgentDelete(ctx, invalid); err == nil {
		t.Fatal("delete accepted an existing Runtime")
	}
	state, err = repository.AdvanceAgentDelete(ctx, runtimeAdvance)
	if err != nil || state.Operation.Phase != domain.PhaseNetworkRelease {
		t.Fatalf("record Runtime deletion: state=%+v err=%v", state, err)
	}
	attachment := ports.NetworkAttachment{
		AgentID: base.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 2, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: ports.NetworkStateQuarantined, NetworkResourceVersion: 2,
		AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2,
	}
	state, err = repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkRelease, NextPhase: domain.PhasePublish,
		NextChildRequestID:    domain.ChildRequestID(requestID, domain.PhasePublish),
		NetworkAttachment:     &attachment,
		NetworkReleaseOutcome: ports.NetworkReleaseQuarantined,
		Now:                   now.Add(5 * time.Second),
	})
	if err != nil || state.Operation.Phase != domain.PhasePublish ||
		state.Operation.NetworkReleaseOutcome != ports.NetworkReleaseQuarantined {
		t.Fatalf("record network release: state=%+v err=%v", state, err)
	}
	published, err := repository.PublishAgentDelete(ctx, ports.PublishAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		DeletedEvent: ports.AgentEventRecord{
			EventID: "event-deleted-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDeleted,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(6 * time.Second),
		},
		Now: now.Add(6 * time.Second),
	})
	if err != nil {
		t.Fatalf("publish Agent delete: %v", err)
	}
	if published.Agent.DesiredState != domain.DesiredDeleted ||
		published.Agent.LifecycleState != domain.AgentDeleted ||
		published.Agent.AgentSpecRevisionID != "" || published.Agent.ExecutionRevisionID != "" ||
		published.Agent.RuntimeRevision != "" || published.Operation.State != domain.OperationCompleted {
		t.Fatalf("published delete = %+v", published)
	}
	assertDeletedAgentRetention(
		t, ctx, repository, base.Agent.AgentID, base.Agent.LastSuccessfulExecutionRevisionID,
	)
	replayedState, found, err := repository.ReplayAgentDelete(ctx, requestID, fingerprint)
	if err != nil || !found || replayedState.Operation.State != domain.OperationCompleted {
		t.Fatalf("replay Agent delete: state=%+v found=%t err=%v", replayedState, found, err)
	}
}

func TestLifecycleRepositoryAuthoritativeAbsenceAdvancesWithoutRuntimeMutation(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	now := time.Now().Add(-15 * time.Second).UTC().Truncate(time.Microsecond)

	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.agents
SET runtime_state = 'unknown', runtime_revision = '',
    runtime_execution_id = '', runtime_mcp_endpoint = '', updated_at = $2
WHERE id = $1`, base.Agent.AgentID, now); err != nil {
		t.Fatalf("project authoritatively absent Runtime: %v", err)
	}
	base.Agent.LifecycleState, base.Agent.ActivationState, base.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	base.Agent.RuntimeRevision = ""
	base.Agent.RuntimeExecutionID = ""
	base.Agent.RuntimeMCPEndpoint = ""

	requestID := "request-delete-absent-runtime-integration"
	fingerprint := strings.Repeat("f", 64)
	begin := deleteBegin(base.Agent, requestID, fingerprint, now)
	begin.Operation.SourceRuntimeAbsent = true
	begin.Operation.SourceRuntimeAbsenceProof = &ports.RuntimeAbsenceProof{
		Reason: "runtime_not_found", ObservedAt: now,
	}
	started, replayed, err := repository.BeginAgentDelete(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin absent Runtime delete: state=%+v replayed=%t err=%v", started, replayed, err)
	}

	operation, err := repository.ConfirmLifecycleDrain(
		ctx, ports.ConfirmLifecycleDrain{RequestID: requestID, Fingerprint: fingerprint, Kind: domain.OperationDelete, Outcome: ports.ExecutionSettled, Now: now.Add(time.Second)})

	if err != nil || operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle absent Runtime delete drain: operation=%+v err=%v", operation, err)
	}
	state, err := repository.AdvanceAgentDelete(ctx, ports.AdvanceAgentDelete{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseNetworkRelease,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRelease),
		Now:                now.Add(2 * time.Second),
	})
	if err != nil || state.Operation.Phase != domain.PhaseNetworkRelease {
		t.Fatalf("cross absent Runtime barrier: state=%+v err=%v", state, err)
	}
	if state.Operation.SourceRuntimeAbsenceProof == nil || state.Operation.SourceRuntimeAbsenceProof.Reason != "runtime_not_found" {
		t.Fatal("Runtime absence evidence was not retained")
	}
}

func assertDeletedAgentRetention(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	agentID string,
	wantLastSuccessfulExecution string,
) {
	t.Helper()
	var accessActive bool
	if err := repository.pool.QueryRow(ctx, `
SELECT active FROM agent_controller.agent_access_bindings WHERE agent_id = $1`,
		agentID,
	).Scan(&accessActive); err != nil {
		t.Fatalf("load deleted Agent access: %v", err)
	}
	if accessActive {
		t.Fatal("deleted Agent owner access remains active")
	}
	var lastSuccessfulExecution string
	if err := repository.pool.QueryRow(ctx, `
SELECT last_successful_execution_revision_id
FROM agent_controller.agents WHERE id = $1`, agentID).Scan(&lastSuccessfulExecution); err != nil {
		t.Fatalf("load deleted Agent audit pointer: %v", err)
	}
	if lastSuccessfulExecution != wantLastSuccessfulExecution {
		t.Fatalf("deleted Agent last successful execution = %q", lastSuccessfulExecution)
	}
	var specs, executions, events int
	if err := repository.pool.QueryRow(ctx, `
SELECT
  (SELECT COUNT(*) FROM agent_controller.agent_spec_revisions WHERE agent_id = $1),
  (SELECT COUNT(*) FROM agent_controller.execution_revisions WHERE agent_id = $1),
  (SELECT COUNT(*) FROM agent_controller.agent_events WHERE agent_id = $1)`,
		agentID,
	).Scan(&specs, &executions, &events); err != nil {
		t.Fatalf("load retained audit facts: %v", err)
	}
	if specs != 1 || executions != 1 || events != 5 {
		t.Fatalf("retained facts specs=%d executions=%d events=%d", specs, executions, events)
	}
}
