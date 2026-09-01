package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRepositoryPersistsAndPublishesEnableSaga(t *testing.T) {
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
	available, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	disabled := seedDisabledAgentForEnable(t, ctx, repository, available)

	base, err := repository.GetAgentEnableBase(ctx, disabled.AgentID)
	if err != nil {
		t.Fatalf("load Agent enable base: %v", err)
	}
	if base.Agent.LifecycleState != domain.AgentDisabled ||
		base.Spec.ID != available.ExecutableSpec.ID ||
		base.LastSuccessfulExecution.ID != available.ExecutableExecution.ID ||
		base.NetworkPolicyAssignment.PolicyID != "internet-enabled" ||
		base.NextExecutionRevision != available.ExecutableExecution.Revision+1 {
		t.Fatalf("enable base = %+v", base)
	}

	now := time.Unix(700, 0).UTC()
	requestID := "request-enable-integration"
	fingerprint := strings.Repeat("8", 64)
	policy := base.NetworkPolicyAssignment
	begin := ports.BeginAgentEnable{
		AgentID:                     base.Agent.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.Spec.ID,
		ExpectedExecutionRevisionID: base.LastSuccessfulExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: fingerprint,
			AgentID: base.Agent.AgentID, Kind: domain.OperationEnable,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			SourceSpecRevisionID:      base.Spec.ID,
			SourceExecutionRevisionID: base.LastSuccessfulExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      base.Spec.ID,
			ChildRequestID:            domain.ChildRequestID(requestID, domain.PhaseNetworkEnsure),
			NetworkPolicyAssignment:   &policy,
			Attempt:                   1, CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-enable-requested-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentEnableRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now,
		},
		Now: now,
	}
	started, replayed, err := repository.BeginAgentEnable(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin Agent enable: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	if started.Agent.DesiredState != domain.DesiredEnabled ||
		started.Agent.LifecycleState != domain.AgentDisabled ||
		started.Operation.NetworkPolicyAssignment == nil {
		t.Fatalf("started enable = %+v", started)
	}

	attachment := ports.NetworkAttachment{
		AgentID: base.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "127.0.0.1", EgressPort: 19091, State: "active",
	}
	withNetwork, err := repository.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhaseRuntimeEnable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeEnable),
		NetworkAttachment:  &attachment, Now: now.Add(time.Second),
	})
	if err != nil || withNetwork.Operation.Phase != domain.PhaseRuntimeEnable {
		t.Fatalf("record enable network: state=%+v err=%v", withNetwork, err)
	}

	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_55555555555555555555555555555555",
		RuntimeExecutionID: "runtime-execution-enabled",
		MCPEndpoint:        "http://runtime-enabled:8091/mcp",
		LifecycleState:     "ready", Health: "healthy",
	}
	withRuntime, err := repository.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeEnable, NextPhase: domain.PhaseNetworkRestore,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkRestore),
		RuntimeResult:      &runtime, Now: now.Add(2 * time.Second),
	})
	if err != nil || withRuntime.Operation.Phase != domain.PhaseNetworkRestore {
		t.Fatalf("record Runtime enable: state=%+v err=%v", withRuntime, err)
	}
	withPolicy, err := repository.AdvanceAgentEnable(ctx, ports.AdvanceAgentEnable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkRestore, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhasePublish),
		NetworkAttachment:  &attachment, Now: now.Add(3 * time.Second),
	})
	if err != nil || withPolicy.Operation.Phase != domain.PhasePublish {
		t.Fatalf("record policy restoration: state=%+v err=%v", withPolicy, err)
	}

	execution := ports.ExecutionRecord{
		ID: "execution-enable-integration", AgentID: base.Agent.AgentID,
		Revision: base.NextExecutionRevision, AgentSpecRevisionID: base.Spec.ID,
		RuntimeRevision:        runtime.RuntimeRevision,
		RuntimeExecutionID:     runtime.RuntimeExecutionID,
		RuntimeMCPEndpoint:     runtime.MCPEndpoint,
		RuntimeMCPSourceDigest: strings.Repeat("9", 64),
		ChangeSummary:          map[string]any{"kind": "enable"},
		PublishedAt:            now.Add(4 * time.Second),
	}
	published, err := repository.PublishAgentEnable(ctx, ports.PublishAgentEnable{
		RequestID: requestID, Fingerprint: fingerprint, Execution: execution,
		EnabledEvent: ports.AgentEventRecord{
			EventID: "event-enabled-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: begin.RequestedEvent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentEnabled,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(4 * time.Second),
		},
		Now: now.Add(4 * time.Second),
	})
	if err != nil {
		t.Fatalf("publish Agent enable: %v", err)
	}
	if published.Agent.DesiredState != domain.DesiredEnabled ||
		published.Agent.LifecycleState != domain.AgentAvailable ||
		published.Agent.ExecutionRevisionID != execution.ID ||
		published.Agent.LastSuccessfulExecutionRevisionID != execution.ID ||
		published.Agent.RuntimeRevision != runtime.RuntimeRevision ||
		published.Operation.State != domain.OperationCompleted {
		t.Fatalf("published enable = %+v", published)
	}
	replayedState, found, err := repository.ReplayAgentEnable(ctx, requestID, fingerprint)
	if err != nil || !found || replayedState.Operation.State != domain.OperationCompleted {
		t.Fatalf("replay Agent enable: state=%+v found=%t err=%v", replayedState, found, err)
	}
}

func seedDisabledAgentForEnable(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	base ports.AgentLifecycleBase,
) ports.AgentRecord {
	t.Helper()
	now := time.Unix(600, 0).UTC()
	requestID := "request-disable-before-enable"
	fingerprint := strings.Repeat("7", 64)
	begin := disableBegin(base, requestID, fingerprint, now)
	if _, _, err := repository.BeginAgentDisable(ctx, begin); err != nil {
		t.Fatalf("begin prerequisite Agent disable: %v", err)
	}
	if _, err := repository.SettleAgentDisableDrain(
		ctx, requestID, fingerprint,
		domain.ChildRequestID(requestID, domain.PhaseNetworkFence), now.Add(time.Second),
	); err != nil {
		t.Fatalf("settle prerequisite Agent disable: %v", err)
	}
	policy := ports.NetworkPolicyAssignment{
		AgentID: base.Agent.AgentID, PolicyID: "internet-enabled", Revision: 1, ResourceVersion: 7,
	}
	if _, err := repository.RecordAgentDisablePolicy(
		ctx, requestID, fingerprint, policy, now.Add(2*time.Second),
	); err != nil {
		t.Fatalf("record prerequisite Agent policy: %v", err)
	}
	if _, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeDisable,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeDisable),
		Now:                now.Add(3 * time.Second),
	}); err != nil {
		t.Fatalf("advance prerequisite Agent disable: %v", err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision: "rtv_44444444444444444444444444444444",
		LifecycleState:  "disabled", Health: "absent",
	}
	if _, err := repository.AdvanceAgentDisable(ctx, ports.AdvanceAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeDisable, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhasePublish),
		RuntimeResult:      &runtime, Now: now.Add(4 * time.Second),
	}); err != nil {
		t.Fatalf("record prerequisite Runtime disable: %v", err)
	}
	published, err := repository.PublishAgentDisable(ctx, ports.PublishAgentDisable{
		RequestID: requestID, Fingerprint: fingerprint,
		DisabledEvent: ports.AgentEventRecord{
			EventID: "event-disabled-before-enable", AgentID: base.Agent.AgentID,
			AggregateSequence: begin.RequestedEvent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentDisabled,
			OperationRequestID: requestID, Data: map[string]any{},
			OccurredAt: now.Add(5 * time.Second),
		},
		Now: now.Add(5 * time.Second),
	})
	if err != nil {
		t.Fatalf("publish prerequisite Agent disable: %v", err)
	}
	return published.Agent
}
