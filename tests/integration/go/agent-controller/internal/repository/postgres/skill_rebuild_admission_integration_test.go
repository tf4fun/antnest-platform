package postgres

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type skillAdmissionACPStub struct{ published chan ports.ExecutionSnapshot }

func (stub skillAdmissionACPStub) ApplyExecutionSnapshot(ctx context.Context, snapshot ports.ExecutionSnapshot) (ports.ExecutionAcknowledgement, error) {
	select {
	case stub.published <- snapshot:
		return ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}, nil
	case <-ctx.Done():
		return ports.ExecutionAcknowledgement{}, ctx.Err()
	}
}

func (skillAdmissionACPStub) SettleAgent(_ context.Context, request ports.AgentSettlementRequest) (ports.AgentSettlementResult, error) {
	return ports.AgentSettlementResult{}, fmt.Errorf("unexpected ACP settlement for Agent %s", request.AgentID)
}

func awaitSkillAdmissionPublication(t *testing.T, published <-chan ports.ExecutionSnapshot, agentID string, accepting bool) ports.ExecutionSnapshot {
	t.Helper()
	select {
	case snapshot := <-published:
		for _, agent := range snapshot.Agents {
			if agent.AgentID == agentID {
				if agent.AcceptingRuns != accepting {
					t.Fatalf("ACP admission=%t, want %t at revision %d", agent.AcceptingRuns, accepting, snapshot.Revision)
				}
				return snapshot
			}
		}
		t.Fatalf("Agent %s absent from ACP publication at revision %d", agentID, snapshot.Revision)
	case <-time.After(10 * time.Second):
		t.Fatal("ACP admission publication did not arrive")
	}
	return ports.ExecutionSnapshot{}
}

func TestInvalidatedSkillRebuildClosesThenRestoresACPSnapshotAdmission(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)
	if !publishedAgent(t, repository, base.Agent).AcceptingRuns {
		t.Fatal("source Agent was not initially admitted")
	}
	publications := make(chan ports.ExecutionSnapshot, 8)
	publisher := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, skillAdmissionACPStub{published: publications},
		application.WithRuntimeConnectionResolver(fixtureRuntimeConnectionResolver{repository: repository}))
	worker, err := application.NewExecutionPublicationWorker(repository, publisher, application.ExecutionPublicationSchedule{
		ResyncInterval: time.Hour, RetryInterval: 10 * time.Millisecond,
		MaxRetryInterval: time.Second, RequestTimeout: 5 * time.Second,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	WithExecutionChangeObserver(worker.Notify)(repository)
	workerCtx, cancelWorker := context.WithCancel(ctx)
	workerDone := make(chan struct{})
	go func() { defer close(workerDone); worker.Run(workerCtx) }()
	t.Cleanup(func() {
		cancelWorker()
		select {
		case <-workerDone:
		case <-time.After(10 * time.Second):
			t.Error("ACP publication worker did not stop")
		}
	})
	initialPublication := awaitSkillAdmissionPublication(t, publications, base.Agent.AgentID, true)
	beforeSync, err := repository.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC().Truncate(time.Microsecond)
	requestID, fingerprint := "request-invalidated-skill-rebuild", strings.Repeat("a", 64)
	targetID := "agentspec-invalidated-skill-rebuild"
	deadline := now.Add(5 * time.Minute)
	begin := ports.BeginAgentRebuild{
		AgentID: base.Agent.AgentID, ExpectedAggregateSequence: base.Agent.AggregateSequence,
		ExpectedSpecRevisionID: base.ConfiguredSpec.ID, ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision: base.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{ID: targetID, AgentID: base.Agent.AgentID, Revision: base.NextSpecRevision,
			Snapshot: base.ConfiguredSpec.Snapshot, CanonicalDigest: base.ConfiguredSpec.CanonicalDigest, CreatedAt: now},
		Operation: ports.LifecycleOperationRecord{RequestID: requestID, RequestFingerprint: fingerprint, AgentID: base.Agent.AgentID,
			Kind: domain.OperationRebuild, Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID: base.ConfiguredSpec.ID, SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision: base.Agent.RuntimeRevision, TargetSpecRevisionID: targetID,
			DrainDeadlineAt: &deadline, ChildRequestID: domain.ChildRequestID(requestID, domain.PhaseDrain), CreatedAt: now, UpdatedAt: now},
		RequestedEvent: ports.AgentEventRecord{EventID: "event-invalidated-skill-rebuild-requested", AgentID: base.Agent.AgentID,
			AggregateSequence: base.Agent.AggregateSequence + 1, SchemaVersion: 1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: requestID, Data: map[string]any{}, OccurredAt: now}, Now: now,
	}
	started, _, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil {
		t.Fatal(err)
	}
	if publishedAgent(t, repository, started.Agent).AcceptingRuns {
		t.Fatal("rebuild Drain did not close ACP admission")
	}
	drainedPublication := awaitSkillAdmissionPublication(t, publications, base.Agent.AgentID, false)
	if drainedPublication.Revision <= initialPublication.Revision {
		t.Fatalf("Drain publication did not advance: initial=%d drained=%d", initialPublication.Revision, drainedPublication.Revision)
	}
	if _, err := repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{RequestID: requestID, Fingerprint: fingerprint,
		Kind: domain.OperationRebuild, Outcome: ports.ExecutionSettled, Now: now.Add(time.Second)}); err != nil {
		t.Fatal(err)
	}
	attachment := ports.NetworkAttachment{AgentID: base.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 2, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: ports.NetworkStateActive, NetworkResourceVersion: 1, AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2}
	fenced, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{RequestID: requestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeUpdate,
		NextChildRequestID: domain.ChildRequestID(requestID, domain.PhaseRuntimeUpdate), NetworkAttachment: &attachment, Now: now.Add(2 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	failed, err := repository.FailAgentRebuild(ctx, ports.FailAgentRebuild{RequestID: requestID, Fingerprint: fingerprint,
		ExpectedAggregateSequence: fenced.Agent.AggregateSequence, Stage: domain.PhaseRuntimeUpdate,
		Code: "prepared_skill_set_invalidated", Detail: "prepared collection disappeared", PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{EventID: "event-invalidated-skill-rebuild-failed", AgentID: base.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentBuildFailed, OperationRequestID: requestID,
			Data: map[string]any{}, OccurredAt: now.Add(3 * time.Second)}, Now: now.Add(3 * time.Second)})
	if err != nil {
		t.Fatal(err)
	}
	if failed.Operation.State != domain.OperationFailed || failed.Agent.ActiveOperationRequestID != "" || failed.Agent.ExecutionRevisionID != base.Agent.ExecutionRevisionID ||
		publishedAgent(t, repository, failed.Agent).AcceptingRuns {
		t.Fatalf("failed rebuild admitted before fresh health: %+v", failed.Agent)
	}
	uncertainPublication := awaitSkillAdmissionPublication(t, publications, base.Agent.AgentID, false)
	if uncertainPublication.Revision <= drainedPublication.Revision {
		t.Fatalf("failure publication did not advance: drained=%d failed=%d", drainedPublication.Revision, uncertainPublication.Revision)
	}
	_, err = repository.RecordRuntimeCondition(ctx, ports.RecordRuntimeCondition{ExpectedAggregateSequence: failed.Agent.AggregateSequence,
		Inspection: ports.RuntimeInspection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
			RuntimeExecutionID: base.Agent.RuntimeExecutionID, MCPEndpoint: base.Agent.RuntimeMCPEndpoint,
			LifecycleState: "provisioned", Phase: "running", Health: "healthy", ObservedAt: now.Add(4 * time.Second)}})
	if err != nil {
		t.Fatal(err)
	}
	after, err := repository.GetAgent(ctx, base.Agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	projection := publishedAgent(t, repository, after)
	if !projection.AcceptingRuns || projection.ExecutionRevision == nil || *projection.ExecutionRevision != base.Agent.ExecutionRevisionID || len(projection.SkillInstructions) != 0 {
		t.Fatalf("healthy source not restored in ACP snapshot: %+v", projection)
	}
	restoredPublication := awaitSkillAdmissionPublication(t, publications, base.Agent.AgentID, true)
	if restoredPublication.Revision <= uncertainPublication.Revision {
		t.Fatalf("restored publication did not advance: failed=%d restored=%d", uncertainPublication.Revision, restoredPublication.Revision)
	}
	afterSync, err := repository.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	if err != nil || afterSync.Revision <= beforeSync.Revision {
		t.Fatalf("ACP publication revision did not advance: before=%+v after=%+v err=%v", beforeSync, afterSync, err)
	}
}
