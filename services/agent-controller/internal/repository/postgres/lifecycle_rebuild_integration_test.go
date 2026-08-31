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

func TestLifecycleRepositoryPersistsAndPublishesRebuildSaga(t *testing.T) {
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

	now := time.Unix(100, 0).UTC()
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
		ExpectedSpecRevisionID:      base.ExecutableSpec.ID,
		ExpectedExecutionRevisionID: base.ExecutableExecution.ID,
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
			SourceSpecRevisionID:  base.ExecutableSpec.ID,
			SourceRuntimeRevision: base.Agent.RuntimeRevision,
			TargetSpecRevisionID:  "agentspec-rebuild-integration",
			ChildRequestID:        domain.ChildRequestID("request-rebuild-integration", domain.PhaseDrain),
			Attempt:               1, CreatedAt: now, UpdatedAt: now,
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
	if started.Agent.LifecycleState != domain.AgentAvailable ||
		started.Agent.ActiveOperationRequestID != begin.Operation.RequestID ||
		started.Operation.SourceRuntimeRevision != base.Agent.RuntimeRevision {
		t.Fatalf("started rebuild = %+v", started)
	}
	if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.run_admissions (
    admission_id, request_id, request_fingerprint, agent_id, session_id,
    principal_id, access_revision, state, deadline, runtime_revision,
    snapshot, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, '{}'::jsonb, $10, $10)`,
		"admission-rebuild-integration", "request-run-rebuild-integration",
		strings.Repeat("e", 64), base.Agent.AgentID, "session-rebuild-integration",
		base.Agent.OwnerUserID, base.Agent.AccessRevision, now.Add(time.Hour),
		base.Agent.RuntimeRevision, now,
	); err != nil {
		t.Fatalf("insert active Run admission: %v", err)
	}
	blocked, err := repository.SettleAgentRebuildDrain(
		ctx, begin.Operation.RequestID, fingerprint,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseNetworkFence), now.Add(time.Second),
	)
	if err != nil || blocked.Operation.Phase != domain.PhaseDrain {
		t.Fatalf("active Run did not block rebuild: state=%+v err=%v", blocked, err)
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions
SET state = 'blocked_unknown_effect', updated_at = $2
WHERE admission_id = $1`, "admission-rebuild-integration", now.Add(time.Second)); err != nil {
		t.Fatalf("mark Run effect unresolved: %v", err)
	}

	drained, err := repository.SettleAgentRebuildDrain(
		ctx, begin.Operation.RequestID, fingerprint,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseNetworkFence), now.Add(time.Second),
	)
	if err != nil || drained.Operation.Phase != domain.PhaseNetworkFence {
		t.Fatalf("settle rebuild drain: state=%+v err=%v", drained, err)
	}
	policy := ports.NetworkPolicyAssignment{
		AgentID: base.Agent.AgentID, PolicyID: "internet-enabled",
		Revision: 3, ResourceVersion: 7,
	}
	withPolicy, err := repository.RecordAgentRebuildPolicy(
		ctx, begin.Operation.RequestID, fingerprint, policy, now.Add(2*time.Second),
	)
	if err != nil || withPolicy.Operation.NetworkPolicyAssignment == nil ||
		*withPolicy.Operation.NetworkPolicyAssignment != policy {
		t.Fatalf("record rebuild policy: state=%+v err=%v", withPolicy, err)
	}
	attachment := ports.NetworkAttachment{
		AgentID: base.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092, State: "active",
	}
	withFence, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkFence, NextPhase: domain.PhaseFlowReset,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseFlowReset),
		NetworkAttachment:  &attachment, Now: now.Add(3 * time.Second),
	})
	if err != nil || withFence.Operation.Phase != domain.PhaseFlowReset {
		t.Fatalf("record network fence: state=%+v err=%v", withFence, err)
	}
	withReset, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseFlowReset, NextPhase: domain.PhaseRuntimeUpdate,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseRuntimeUpdate),
		Now:                now.Add(4 * time.Second),
	})
	if err != nil || withReset.Operation.Phase != domain.PhaseRuntimeUpdate {
		t.Fatalf("record flow reset: state=%+v err=%v", withReset, err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_22222222222222222222222222222222",
		RuntimeExecutionID: "runtime-execution-rebuilt",
		MCPEndpoint:        "http://runtime-rebuilt:8091/mcp",
		LifecycleState:     "ready", Health: "healthy",
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions SET runtime_revision = $2 WHERE admission_id = $1`,
		"admission-rebuild-integration", "rtv_wrong_runtime",
	); err != nil {
		t.Fatalf("set mismatched unresolved Run revision: %v", err)
	}
	runtimeAdvance := ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseRuntimeUpdate, NextPhase: domain.PhaseNetworkEnsure,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseNetworkEnsure),
		RuntimeResult:      &runtime, Now: now.Add(5 * time.Second),
	}
	if _, err := repository.AdvanceAgentRebuild(ctx, runtimeAdvance); err == nil {
		t.Fatal("Runtime replacement released an unresolved Run from another Runtime revision")
	}
	if _, err := repository.pool.Exec(ctx, `
UPDATE agent_controller.run_admissions SET runtime_revision = $2 WHERE admission_id = $1`,
		"admission-rebuild-integration", base.Agent.RuntimeRevision,
	); err != nil {
		t.Fatalf("restore unresolved Run revision: %v", err)
	}
	withRuntime, err := repository.AdvanceAgentRebuild(ctx, runtimeAdvance)
	if err != nil || withRuntime.Operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("record Runtime update: state=%+v err=%v", withRuntime, err)
	}
	var admissionState, releasedBy string
	if err := repository.pool.QueryRow(ctx, `
SELECT state, released_by_operation_request_id
FROM agent_controller.run_admissions WHERE admission_id = $1`,
		"admission-rebuild-integration",
	).Scan(&admissionState, &releasedBy); err != nil {
		t.Fatalf("load released Run admission: %v", err)
	}
	if admissionState != "released" || releasedBy != begin.Operation.RequestID {
		t.Fatalf("released Run admission state=%q operation=%q", admissionState, releasedBy)
	}
	withNetwork, err := repository.AdvanceAgentRebuild(ctx, ports.AdvanceAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		ExpectedPhase: domain.PhaseNetworkEnsure, NextPhase: domain.PhasePublish,
		NextChildRequestID: domain.ChildRequestID(begin.Operation.RequestID, domain.PhasePublish),
		NetworkAttachment:  &attachment, Now: now.Add(6 * time.Second),
	})
	if err != nil || withNetwork.Operation.Phase != domain.PhasePublish {
		t.Fatalf("record network reopen: state=%+v err=%v", withNetwork, err)
	}

	publishInput := ports.PublishAgentRebuild{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		Execution: ports.ExecutionRecord{
			ID: "execution-rebuild-integration", AgentID: base.Agent.AgentID,
			Revision:               base.NextExecutionRevision,
			AgentSpecRevisionID:    begin.TargetSpec.ID,
			RuntimeRevision:        runtime.RuntimeRevision,
			RuntimeExecutionID:     runtime.RuntimeExecutionID,
			RuntimeMCPEndpoint:     runtime.MCPEndpoint,
			RuntimeMCPSourceDigest: strings.Repeat("d", 64),
			ChangeSummary:          map[string]any{"kind": "rebuild"},
			PublishedAt:            now.Add(7 * time.Second),
		},
		RebuiltEvent: ports.AgentEventRecord{
			EventID: "event-rebuilt-integration", AgentID: base.Agent.AgentID,
			AggregateSequence: begin.RequestedEvent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentRebuilt,
			OperationRequestID: begin.Operation.RequestID,
			Data:               map[string]any{"execution_revision_id": "execution-rebuild-integration"},
			OccurredAt:         now.Add(7 * time.Second),
		},
		Now: now.Add(7 * time.Second),
	}
	invalidPublication := publishInput
	invalidPublication.Execution.RuntimeExecutionID = "unverified-runtime-execution"
	if _, err := repository.PublishAgentRebuild(ctx, invalidPublication); err == nil {
		t.Fatal("publication accepted a Runtime binding different from the verified result")
	}
	published, err := repository.PublishAgentRebuild(ctx, publishInput)
	if err != nil {
		t.Fatalf("publish Agent rebuild: %v", err)
	}
	if published.Agent.AgentSpecRevisionID != begin.TargetSpec.ID ||
		published.Agent.ExecutionRevisionID != "execution-rebuild-integration" ||
		published.Agent.RuntimeRevision != runtime.RuntimeRevision ||
		published.Operation.State != domain.OperationCompleted {
		t.Fatalf("published rebuild = %+v", published)
	}

	retryBase, err := repository.GetAgentLifecycleBase(ctx, base.Agent.AgentID)
	if err != nil {
		t.Fatalf("load Agent for pre-barrier failure: %v", err)
	}
	failureRequestID := "request-rebuild-pre-barrier-failure"
	failureFingerprint := strings.Repeat("9", 64)
	failureBegin := ports.BeginAgentRebuild{
		AgentID:                     retryBase.Agent.AgentID,
		ExpectedAggregateSequence:   retryBase.Agent.AggregateSequence,
		ExpectedSpecRevisionID:      retryBase.ExecutableSpec.ID,
		ExpectedExecutionRevisionID: retryBase.ExecutableExecution.ID,
		ExpectedRuntimeRevision:     retryBase.Agent.RuntimeRevision,
		TargetSpec: ports.AgentSpecRecord{
			ID: "agentspec-pre-barrier-failure", AgentID: retryBase.Agent.AgentID,
			Revision: retryBase.NextSpecRevision, Snapshot: retryBase.ExecutableSpec.Snapshot,
			CanonicalDigest: retryBase.ExecutableSpec.CanonicalDigest, CreatedAt: now.Add(8 * time.Second),
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: failureRequestID, RequestFingerprint: failureFingerprint,
			AgentID: retryBase.Agent.AgentID, Kind: domain.OperationRebuild,
			Phase: domain.PhaseDrain, State: domain.OperationRunning,
			SourceSpecRevisionID:  retryBase.ExecutableSpec.ID,
			SourceRuntimeRevision: retryBase.Agent.RuntimeRevision,
			TargetSpecRevisionID:  "agentspec-pre-barrier-failure",
			ChildRequestID:        domain.ChildRequestID(failureRequestID, domain.PhaseDrain),
			Attempt:               1, CreatedAt: now.Add(8 * time.Second), UpdatedAt: now.Add(8 * time.Second),
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
		Stage: domain.PhaseDrain, Code: "run_drain_timeout",
		Detail: "Run did not settle", PreserveExecutable: true,
		FailedEvent: ports.AgentEventRecord{
			EventID: "event-pre-barrier-failed", AgentID: retryBase.Agent.AgentID,
			AggregateSequence: startedFailure.Agent.AggregateSequence + 1,
			SchemaVersion:     1, EventType: ports.EventAgentBuildFailed,
			OperationRequestID: failureRequestID, Data: map[string]any{}, OccurredAt: now.Add(9 * time.Second),
		},
		Now: now.Add(9 * time.Second),
	})
	if err != nil {
		t.Fatalf("fail pre-barrier rebuild: %v", err)
	}
	if failed.Agent.LifecycleState != domain.AgentAvailable ||
		failed.Agent.ExecutionRevisionID != retryBase.Agent.ExecutionRevisionID ||
		failed.Agent.RuntimeRevision != retryBase.Agent.RuntimeRevision ||
		failed.Operation.State != domain.OperationFailed {
		t.Fatalf("pre-barrier failure did not preserve executable source: %+v", failed)
	}
}

type rebuildSeed struct {
	Model    ports.ModelProfileRecord
	Revision domain.TemplateRevision
}

func seedAvailableAgentForRebuild(
	t *testing.T, ctx context.Context, repository *Repository,
) (ports.AgentLifecycleBase, rebuildSeed) {
	t.Helper()
	resetCatalogSchema(t, ctx, repository)
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("migrate repository: %v", err)
	}
	model := integrationModelRecord(t)
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
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentProvisioning,
			AccessRevision:           "access-rebuild-integration",
			ActiveOperationRequestID: "request-create-for-rebuild", AggregateSequence: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{
			AccessSubject: "access-rebuild-integration", AgentID: "agent-rebuild-integration",
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
			Attempt:              1, CreatedAt: now, UpdatedAt: now,
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
	attachment := ports.NetworkAttachment{
		AgentID: begin.Agent.AgentID, TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092, State: "active",
	}
	if _, err := repository.RecordCreateNetwork(
		ctx, begin.Operation.RequestID, fingerprint, attachment,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseRuntimeInitialize), now.Add(time.Second),
	); err != nil {
		t.Fatalf("record seed Agent network: %v", err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed",
		RuntimeRevision:    "rtv_11111111111111111111111111111111",
		RuntimeExecutionID: "runtime-execution-seed", MCPEndpoint: "http://runtime-seed:8091/mcp",
		LifecycleState: "ready", Health: "healthy",
	}
	if _, err := repository.RecordCreateRuntime(
		ctx, begin.Operation.RequestID, fingerprint, runtime,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhasePublish), now.Add(2*time.Second),
	); err != nil {
		t.Fatalf("record seed Runtime: %v", err)
	}
	if _, err := repository.PublishAgentCreate(ctx, ports.PublishAgentCreate{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		Execution: ports.ExecutionRecord{
			ID: "execution-create-for-rebuild", AgentID: begin.Agent.AgentID, Revision: 1,
			AgentSpecRevisionID: begin.Spec.ID, RuntimeRevision: runtime.RuntimeRevision,
			RuntimeExecutionID: runtime.RuntimeExecutionID, RuntimeMCPEndpoint: runtime.MCPEndpoint,
			RuntimeMCPSourceDigest: strings.Repeat("b", 64),
			ChangeSummary:          map[string]any{"kind": "create"}, PublishedAt: now.Add(3 * time.Second),
		},
		ReadyEvent: ports.AgentEventRecord{
			EventID: "event-ready-for-rebuild", AgentID: begin.Agent.AgentID,
			AggregateSequence: 2, SchemaVersion: 1, EventType: ports.EventAgentReady,
			OperationRequestID: begin.Operation.RequestID, Data: map[string]any{},
			OccurredAt: now.Add(3 * time.Second),
		},
		Now: now.Add(3 * time.Second),
	}); err != nil {
		t.Fatalf("publish seed Agent: %v", err)
	}
	base, err := repository.GetAgentLifecycleBase(ctx, begin.Agent.AgentID)
	if err != nil {
		t.Fatalf("load rebuild base: %v", err)
	}
	return base, rebuildSeed{Model: model, Revision: template.Revision}
}
