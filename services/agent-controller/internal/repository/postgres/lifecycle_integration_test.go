package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLifecycleRepositoryPersistsCreateSagaAndPublishesAtomically(t *testing.T) {
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
	loadedTemplate, err := repository.GetTemplateRevision(ctx, template.TemplateID, 1)
	if err != nil {
		t.Fatalf("get explicit Template revision: %v", err)
	}
	spec, err := domain.MaterializeAgentSpec(loadedTemplate, model.Revision)
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
			AgentID: "agent-integration", OrganizationID: "org-integration",
			OwnerUserID: "user-integration", Name: "Integration Agent",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentProvisioning,
			AccessRevision:           "access-revision-integration",
			ActiveOperationRequestID: "request-agent-integration", AggregateSequence: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{
			AccessSubject: "access-integration", AgentID: "agent-integration",
			PrincipalID: "user-integration", AccessRevision: "access-revision-integration",
			Active: true, CreatedAt: now, UpdatedAt: now,
		},
		Spec: ports.AgentSpecRecord{
			ID: "agentspec-integration", AgentID: "agent-integration", Revision: 1,
			Snapshot: spec.Snapshot(), CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-agent-integration", RequestFingerprint: fingerprint,
			AgentID: "agent-integration", Kind: domain.OperationCreate,
			Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			TargetSpecRevisionID: "agentspec-integration",
			ChildRequestID:       domain.ChildRequestID("request-agent-integration", domain.PhaseNetworkEnsure),
			Attempt:              1, CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-create-integration", AgentID: "agent-integration",
			AggregateSequence: 1, SchemaVersion: 1, EventType: ports.EventAgentCreateRequested,
			OperationRequestID: "request-agent-integration",
			Data:               map[string]any{"template_id": template.TemplateID}, OccurredAt: now,
		},
	}

	started, replayed, err := repository.BeginAgentCreate(ctx, begin)
	if err != nil || replayed {
		t.Fatalf("begin Agent create: state=%+v replayed=%t err=%v", started, replayed, err)
	}
	replayedState, replayed, err := repository.BeginAgentCreate(ctx, begin)
	if err != nil || !replayed || replayedState.Agent.AgentID != begin.Agent.AgentID {
		t.Fatalf("replay Agent create: state=%+v replayed=%t err=%v", replayedState, replayed, err)
	}
	if _, found, err := repository.ReplayAgentCreate(ctx, begin.Operation.RequestID, strings.Repeat("f", 64)); !errors.Is(err, ports.ErrRequestConflict) || found {
		t.Fatalf("conflicting Agent request error=%v found=%t", err, found)
	}
	operation, err := repository.GetLifecycleOperation(ctx, begin.Operation.RequestID)
	if err != nil {
		t.Fatalf("get lifecycle operation: %v", err)
	}
	if operation.RequestID != begin.Operation.RequestID || operation.Phase != domain.PhaseNetworkEnsure {
		t.Fatalf("lifecycle operation = %+v", operation)
	}

	attachment := ports.NetworkAttachment{
		AgentID: "agent-integration", TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092, State: "active",
	}
	withNetwork, err := repository.RecordCreateNetwork(
		ctx, begin.Operation.RequestID, fingerprint, attachment,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhaseRuntimeInitialize), now.Add(time.Second),
	)
	if err != nil || withNetwork.Operation.Phase != domain.PhaseRuntimeInitialize {
		t.Fatalf("record network: state=%+v err=%v", withNetwork, err)
	}
	runtime := ports.RuntimeOperation{
		State: "completed", Effect: "completed", RuntimeRevision: "runtime-revision-1",
		RuntimeExecutionID: "runtime-execution-1", MCPEndpoint: "http://runtime:8091/mcp",
		LifecycleState: "ready", Health: "healthy",
	}
	withRuntime, err := repository.RecordCreateRuntime(
		ctx, begin.Operation.RequestID, fingerprint, runtime,
		domain.ChildRequestID(begin.Operation.RequestID, domain.PhasePublish), now.Add(2*time.Second),
	)
	if err != nil || withRuntime.Operation.Phase != domain.PhasePublish {
		t.Fatalf("record Runtime: state=%+v err=%v", withRuntime, err)
	}

	published, err := repository.PublishAgentCreate(ctx, ports.PublishAgentCreate{
		RequestID: begin.Operation.RequestID, Fingerprint: fingerprint,
		Execution: ports.ExecutionRecord{
			ID: "execution-integration", AgentID: begin.Agent.AgentID, Revision: 1,
			AgentSpecRevisionID: begin.Spec.ID, RuntimeRevision: runtime.RuntimeRevision,
			RuntimeExecutionID: runtime.RuntimeExecutionID, RuntimeMCPEndpoint: runtime.MCPEndpoint,
			RuntimeMCPSourceDigest: strings.Repeat("b", 64),
			ChangeSummary:          map[string]any{"kind": "create"}, PublishedAt: now.Add(3 * time.Second),
		},
		ReadyEvent: ports.AgentEventRecord{
			EventID: "event-ready-integration", AgentID: begin.Agent.AgentID,
			AggregateSequence: 2, SchemaVersion: 1, EventType: ports.EventAgentReady,
			OperationRequestID: begin.Operation.RequestID,
			Data:               map[string]any{"execution_revision_id": "execution-integration"},
			OccurredAt:         now.Add(3 * time.Second),
		},
		Now: now.Add(3 * time.Second),
	})
	if err != nil {
		t.Fatalf("publish Agent create: %v", err)
	}
	if published.Agent.LifecycleState != domain.AgentAvailable ||
		published.Agent.ExecutionRevisionID != "execution-integration" ||
		published.Operation.State != domain.OperationCompleted || published.Operation.Phase != domain.PhaseCompleted {
		t.Fatalf("published state = %+v", published)
	}
	var eventCount int
	if err := repository.pool.QueryRow(ctx, `
SELECT COUNT(*) FROM agent_controller.agent_events WHERE agent_id = $1`, begin.Agent.AgentID).Scan(&eventCount); err != nil {
		t.Fatalf("count Agent events: %v", err)
	}
	if eventCount != 2 {
		t.Fatalf("event count = %d", eventCount)
	}
}
