package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"go.opentelemetry.io/otel"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRepositoryPersistsAndPublishesRebuildSaga(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
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
	base, template := seedAvailableAgentForRebuild(t, ctx, repository)

	now := time.Now().Add(-15 * time.Second).UTC().Truncate(time.Microsecond)
	deadline := now.Add(time.Minute)
	targetSpec, err := domain.MaterializeAgentSpec(template.Revision, template.Model.Revision)
	if err != nil {
		t.Fatalf("materialize target Agent spec: %v", err)
	}
	digest, err := targetSpec.Digest()
	if err != nil {
		t.Fatalf("digest target Agent spec: %v", err)
	}
	fingerprint := strings.Repeat("c", 64)
	begin := ports.BeginAgentRebuild{
		AgentID:                     base.Agent.AgentID,
		ExpectedAggregateSequence:   base.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      base.ConfiguredSpec.ID,
		ExpectedExecutionRevisionID: base.SourceExecution.ID,
		ExpectedRuntimeRevision:     base.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{
			ID: "agentspec-rebuild-integration", AgentID: base.Agent.AgentID,
			Revision: base.NextSpecRevision, Snapshot: targetSpec.Snapshot(),
			CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-rebuild-integration", RequestFingerprint: fingerprint,
			AgentID: base.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:      base.ConfiguredSpec.ID,
			SourceExecutionRevisionID: base.SourceExecution.ID,
			SourceRuntimeRevision:     base.Agent.RuntimeRevision,
			TargetSpecRevisionID:      "agentspec-rebuild-integration",
			DrainDeadlineAt:           &deadline,
			ChildRequestID:            domain.ChildRequestID("request-rebuild-integration", domain.PhaseDrain),
			CreatedAt:                 now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-rebuild-requested-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: base.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: "request-rebuild-integration",
			Data:               map[string]any{"target_agent_spec_revision_id": "agentspec-rebuild-integration"},
			OccurredAt:         now,
		},
		Now: now,
	}

	started, replayed, err := repository.BeginAgentRebuild(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin Agent rebuild: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	if (started.Agent.LifecycleState != domain.AgentCreated || started.Agent.ActivationState != domain.ActivationEnabled || started.Agent.RuntimeState != domain.RuntimeAvailable) ||
		started.Agent.ActiveOperationRequestID != begin.Operation.RequestID ||
		started.Operation.SourceRuntimeRevision != base.Agent.RuntimeRevision {
		t.Fatalf("started rebuild = %+v", started)
	}
	drained, err := repository.ConfirmLifecycleDrain(ctx, ports.ConfirmLifecycleDrain{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint, Kind: domain.OperationRebuild,
		Outcome: ports.ExecutionRuntimeBarrierRequired, Now: now.Add(time.Second),
	})
	if err != nil || drained.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle rebuild drain: state=%+v err=%v", drained, err)
	}
	attachment := ports.NetworkAttachment{
		AgentID: base.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 2, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: ports.NetworkStateActive, NetworkResourceVersion: 1,
		AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 2,
	}
	phaseContext, phaseSpan := otel.Tracer("phase-write-test").Start(ctx, "advance")
	defer phaseSpan.End()
	spanOffset := len(recorder.Ended())
	withFence, err := repository.AdvanceAgentRebuild(phaseContext, ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseRuntimeUpdate,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseRuntimeUpdate),
		NetworkAttachment:  &attachment, Now: now.Add(3 * time.Second),
	})
	if err != nil || withFence.Operation.Phase != domain.PhaseRuntimeUpdate {
		t.Fatalf("record network fence: state=%+v err=%v", withFence, err)
	}
	queries := 0
	for _, span := range recorder.Ended()[spanOffset:] {
		query := databaseSpanAttribute(span, "db.query.text")
		if query != "" {
			queries++
		}
		if strings.Contains(query, "agent_spec_revisions") || strings.Contains(query, "execution_revisions") {
			t.Fatalf("phase write reloaded immutable execution input: %s", query)
		}
	}
	if queries == 0 {
		t.Fatal("phase SQL observation missing")
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_22222222222222222222222222222222",
		RuntimeExecutionID: "",
		MCPEndpoint:        "",
		LifecycleState:     "provisioned", Health: "unknown",
	}
	runtimeAdvance := ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeUpdate, NextPhase: domain.PhaseNetworkEnsure,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseNetworkEnsure),
		RuntimeResult:      &runtime,
		Now:                now.Add(5 * time.Second),
	}
	unchangedRuntime := runtime
	unchangedRuntime.RuntimeRevision = base.Agent.RuntimeRevision
	invalid := runtimeAdvance
	invalid.RuntimeResult = &unchangedRuntime
	if _, err := repository.AdvanceAgentRebuild(ctx, invalid); err == nil {
		t.Fatal("rebuild accepted the old Runtime as a replacement")
	}
	withRuntime, err := repository.AdvanceAgentRebuild(ctx, runtimeAdvance)
	if err != nil || withRuntime.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("record Runtime update: state=%+v err=%v", withRuntime, err)
	}
	reopenedAttachment := attachment
	reopenedAttachment.AttachmentState = ports.NetworkAttachmentOpen
	reopenedAttachment.AttachmentResourceVersion++
	withNetwork, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhasePublish),
		NetworkAttachment:  &reopenedAttachment, Now: now.Add(6 * time.Second),
	})
	if err != nil || withNetwork.Operation.Phase != domain.PhasePublish {
		t.Fatalf("record network reopen: state=%+v err=%v", withNetwork, err)
	}

	publishInput := ports.PublishAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		AccessRevision: "access-rebuild-integration",
		RebuiltEvent: ports.AgentEventRecord{
			EventID: "event-rebuilt-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: withNetwork.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuilt,
			OperationRequestID: begin.Operation.RequestID,
			Data:               map[string]any{"execution_revision_id": "execution-rebuild-integration"},
			OccurredAt:         now.Add(7 * time.Second),
		},
		Now: now.Add(7 * time.Second),
	}
	invalidPublication := publishInput
	invalidPublication.RebuiltEvent.AggregateSequence++
	if _, err := repository.PublishAgentRebuild(ctx, invalidPublication); err == nil {
		t.Fatal("publication accepted a stale Agent sequence")
	}
	published, err := repository.PublishAgentRebuild(ctx, publishInput)
	if err != nil {
		t.Fatalf("publish Agent rebuild: %v", err)
	}
	if published.Agent.AgentSpecRevisionID != begin.TargetSpec.ID ||
		published.Agent.ExecutionRevisionID != "" || (published.Agent.LifecycleState != domain.AgentCreated || published.Agent.ActivationState != domain.ActivationEnabled || published.Agent.RuntimeState != domain.RuntimeUnknown) ||
		published.Agent.RuntimeRevision != runtime.RuntimeRevision ||
		published.Operation.State != domain.OperationCompleted {
		t.Fatalf("published rebuild = %+v", published)
	}

	observeRuntimeForTest(t, ctx, repository, published.Agent, published.Operation, "execution-rebuild-integration", "runtime-execution-rebuilt", "http://runtime-rebuilt:8091/mcp")
	retryBase, err := repository.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
	if err != nil {
		t.Fatalf("load Agent for pre-barrier failure: %v", err)
	}
	failureRequestID := "request-rebuild-pre-barrier-failure"
	failureFingerprint := strings.Repeat("9", 64)
	failureBegin := ports.BeginAgentRebuild{
		AgentID:                     retryBase.Agent.AgentID,
		ExpectedAggregateSequence:   retryBase.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      retryBase.ConfiguredSpec.ID,
		ExpectedExecutionRevisionID: retryBase.SourceExecution.ID,
		ExpectedRuntimeRevision:     retryBase.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{
			ID: "agentspec-pre-barrier-failure", AgentID: retryBase.Agent.AgentID,
			Revision: retryBase.NextSpecRevision, Snapshot: retryBase.ConfiguredSpec.Snapshot,
			CanonicalDigest: retryBase.ConfiguredSpec.CanonicalDigest, CreatedAt: now.Add(8 * time.Second),
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: failureRequestID, RequestFingerprint: failureFingerprint,
			AgentID: retryBase.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:      retryBase.ConfiguredSpec.ID,
			SourceExecutionRevisionID: retryBase.SourceExecution.ID,
			SourceRuntimeRevision:     retryBase.Agent.RuntimeRevision,
			TargetSpecRevisionID:      "agentspec-pre-barrier-failure",
			ChildRequestID:            domain.ChildRequestID(failureRequestID, domain.PhaseDrain),
			CreatedAt:                 now.Add(8 * time.Second), UpdatedAt: now.Add(8 * time.Second),
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-pre-barrier-failure-requested", AgentID: retryBase.Agent.AgentID,
			AggregateSequence: retryBase.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuildRequested,
			OperationRequestID: failureRequestID, Data: map[string]any{}, OccurredAt: now.Add(8 * time.Second),
		},
		Now: now.Add(8 * time.Second),
	}
	startedFailure, _, err := repository.BeginAgentRebuild(ctx, failureBegin)
	if err != nil {
		t.Fatalf("begin pre-barrier failure rebuild: %v", err)
	}
	failed, err := repository.FailAgentRebuild(ctx, ports.FailAgentRebuild{
		RequestID: failureRequestID, Fingerprint: failureFingerprint,
		ExpectedAggregateSequence: startedFailure.Agent.AggregateSequence,
		Stage:                     domain.PhaseDrain, Code: "run_drain_timeout",
		Detail: "Run did not settle", PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-pre-barrier-failed", AgentID: retryBase.Agent.AgentID,
			SchemaVersion: 1, EventType: ports.EventAgentBuildFailed,
			OperationRequestID: failureRequestID, Data: map[string]any{}, OccurredAt: now.Add(9 * time.Second),
		},
		Now: now.Add(9 * time.Second),
	})
	if err != nil {
		t.Fatalf("fail pre-barrier rebuild: %v", err)
	}
	if (failed.Agent.LifecycleState != domain.AgentCreated || failed.Agent.ActivationState != domain.ActivationEnabled || failed.Agent.RuntimeState != domain.RuntimeUnknown) ||
		failed.Agent.ExecutionRevisionID != retryBase.Agent.ExecutionRevisionID ||
		failed.Agent.RuntimeRevision != retryBase.Agent.RuntimeRevision ||
		failed.Operation.State != domain.OperationFailed {
		t.Fatalf("pre-barrier failure did not preserve executable source: %+v", failed)
	}
	assertPreservedSourceRequiresFreshObservation(t, ctx, repository, failed.Agent)
}

type rebuildSeed struct {
	Model    ports.ModelProfileRecord
	Revision domain.TemplateRevision
}

func seedAvailableAgentForRebuild(
	t *testing.T, ctx context.Context, repository *Repository,
) (ports.AgentLifecycleBase, rebuildSeed) {
	return seedConfiguredAgentForTest(t, ctx, repository, true)
}

func seedConfiguredAgentForTest(t *testing.T, ctx context.Context, repository *Repository, observe bool) (ports.AgentLifecycleBase, rebuildSeed) {
	t.Helper()
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	if _, err := repository.PutModelProfile(ctx, model); err != nil {
		t.Fatalf("put ModelProfile: %v", err)
	}
	template := integrationTemplateRecord(t, model.Revision)
	if _, err := repository.PutTemplate(ctx, template); err != nil {
		t.Fatalf("put Template: %v", err)
	}
	spec, err := domain.MaterializeAgentSpec(template.Revision, model.Revision)
	if err != nil {
		t.Fatalf("materialize Agent spec: %v", err)
	}
	digest, err := spec.Digest()
	if err != nil {
		t.Fatalf("digest Agent spec: %v", err)
	}
	now := time.Unix(10, 0).UTC()
	fingerprint := strings.Repeat("a", 64)
	begin := ports.BeginAgentCreate{
		Agent: ports.AgentRecord{
			AgentID: "agent-rebuild-integration", OrganizationID: "org-integration",
			OwnerUserID: "user-integration", Name: "Rebuild Agent",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown,
			AccessRevision:           "access-rebuild-integration",
			ActiveOperationRequestID: "request-create-for-rebuild", AggregateSequence: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{
			AgentID:     "agent-rebuild-integration",
			PrincipalID: "user-integration", AccessRevision: "access-rebuild-integration",
			Active: true, CreatedAt: now, UpdatedAt: now,
		},
		Spec: ports.AgentSpecRecord{
			ID: "agentspec-create-for-rebuild", AgentID: "agent-rebuild-integration",
			Revision: 1, Snapshot: spec.Snapshot(), CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-create-for-rebuild", RequestFingerprint: fingerprint,
			AgentID: "agent-rebuild-integration", Kind: domain.OperationCreate,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			TargetSpecRevisionID: "agentspec-create-for-rebuild",
			ChildRequestID:       domain.ChildRequestID("request-create-for-rebuild", domain.PhaseNetworkEnsure),
			CreatedAt:            now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-create-for-rebuild", AgentID: "agent-rebuild-integration",
			AggregateSequence: 1, SchemaVersion: 1, EventType: ports.EventAgentCreateRequested,
			OperationRequestID: "request-create-for-rebuild", Data: map[string]any{}, OccurredAt: now,
		},
	}
	if _, _, err := repository.BeginAgentCreate(ctx, begin); err != nil {
		t.Fatalf("begin seed Agent create: %v", err)
	}
	mutationCtx := ctx
	attachment := *closedNetworkAttachment(begin.Agent.AgentID)
	if _, err := repository.RecordCreateNetwork(
		mutationCtx, begin.Operation.RequestID, fingerprint, attachment,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseRuntimeInitialize), now.Add(time.Second),
	); err != nil {
		t.Fatalf("record seed Agent network: %v", err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_11111111111111111111111111111111",
		RuntimeExecutionID: "", MCPEndpoint: "",
		LifecycleState: "provisioned", Health: "unknown",
	}
	if _, err := repository.RecordCreateRuntime(
		mutationCtx, begin.Operation.RequestID, fingerprint, runtime,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhasePublish), now.Add(2*time.Second),
	); err != nil {
		t.Fatalf("record seed Runtime: %v", err)
	}
	openedAttachment := attachment
	openedAttachment.AttachmentState = ports.NetworkAttachmentOpen
	openedAttachment.AttachmentResourceVersion++
	if _, err := repository.PublishAgentCreate(mutationCtx, ports.PublishAgentCreate{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		NetworkAttachment: openedAttachment,
		CreatedEvent: ports.AgentEventRecord{
			EventID: "event-ready-for-rebuild", AgentID: begin.Agent.AgentID,
			AggregateSequence: 2, SchemaVersion: 1, EventType: ports.EventAgentCreated,
			OperationRequestID: begin.Operation.RequestID, Data: map[string]any{},
			OccurredAt: now.Add(3 * time.Second),
		},
		Now: now.Add(3 * time.Second),
	}); err != nil {
		t.Fatalf("publish seed Agent: %v", err)
	}
	if observe {
		agent, err := loadAgentRecord(ctx, repository.pool, begin.Agent.AgentID)
		if err != nil {
			t.Fatal(err)
		}
		op, err := repository.GetLifecycleOperation(ctx, begin.Operation.RequestID)
		if err != nil {
			t.Fatal(err)
		}
		observeRuntimeForTest(t, ctx, repository, agent, op, "execution-create-for-rebuild", "runtime-execution-seed", "http://runtime-seed:8091/mcp")
	}
	base, err := repository.GetAgentLifecycleBase(ctx, begin.Agent.AgentID)
	if err != nil {
		t.Fatalf("load rebuild base: %v", err)
	}
	return base, rebuildSeed{Model: model, Revision: template.Revision}
}
