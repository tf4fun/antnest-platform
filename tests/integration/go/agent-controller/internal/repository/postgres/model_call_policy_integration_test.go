package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestModelCallPolicyTemplateStorageRoundTripAndReplay(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	if _, err := repository.PutModelProfile(ctx, model); err != nil {
		t.Fatalf("put ModelProfile: %v", err)
	}
	template := modelPolicyTemplateRecord(t, integrationTemplateRecord(t, model.Revision),
		&domain.ModelRetryPolicy{Max: 0, BaseMS: 1, CapMS: 30000}, "never", &domain.RunBudget{
			MaxInputTokens: modelPolicyInt64(0), MaxOutputTokens: modelPolicyInt64(domain.MaximumModelBudget),
			MaxCostUSDMicros: modelPolicyInt64(0),
		})
	original := template.Revision.Snapshot()
	created, err := repository.PutTemplate(ctx, template)
	if err != nil {
		t.Fatalf("put Template: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, created.Revision.Snapshot(), original)
	loaded, err := repository.GetTemplate(ctx, template.TemplateID)
	if err != nil {
		t.Fatalf("get Template: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, loaded.Revision.Snapshot(), original)
	history, err := repository.GetTemplateRevision(ctx, template.TemplateID, 1)
	if err != nil {
		t.Fatalf("get Template revision 1: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, history.Snapshot(), original)
	listed, next, err := repository.ListTemplates(ctx, template.OrganizationID, "", 10)
	if err != nil || len(listed) != 1 || next != "" {
		t.Fatalf("list Templates: count=%d next=%q err=%v", len(listed), next, err)
	}
	assertModelPolicyTemplateSnapshot(t, listed[0].Revision.Snapshot(), original)

	revision := modelPolicyTemplateRecord(t, integrationRevisedTemplateRecord(t, template, model.Revision),
		&domain.ModelRetryPolicy{Max: 8, BaseMS: 200, CapMS: 30000}, "before_output", &domain.RunBudget{
			MaxInputTokens: modelPolicyInt64(domain.MaximumModelBudget), MaxOutputTokens: modelPolicyInt64(0),
			MaxCostUSDMicros: modelPolicyInt64(domain.MaximumModelBudget),
		})
	revisedSnapshot := revision.Revision.Snapshot()
	revised, err := repository.ReviseTemplate(ctx, 1, revision)
	if err != nil {
		t.Fatalf("revise Template: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, revised.Revision.Snapshot(), revisedSnapshot)
	current, err := repository.GetTemplate(ctx, template.TemplateID)
	if err != nil {
		t.Fatalf("get revised Template: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, current.Revision.Snapshot(), revisedSnapshot)
	listed, next, err = repository.ListTemplates(ctx, template.OrganizationID, "", 10)
	if err != nil || len(listed) != 1 || next != "" {
		t.Fatalf("list revised Templates: count=%d next=%q err=%v", len(listed), next, err)
	}
	assertModelPolicyTemplateSnapshot(t, listed[0].Revision.Snapshot(), revisedSnapshot)

	// Exact request retries must read their original immutable revision, even
	// after the current Template has moved to a different policy.
	replayedCreate, err := repository.PutTemplate(ctx, template)
	if err != nil {
		t.Fatalf("replay Template create: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, replayedCreate.Revision.Snapshot(), original)
	replayedRevision, err := repository.ReviseTemplate(ctx, 1, revision)
	if err != nil {
		t.Fatalf("replay Template revision: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, replayedRevision.Revision.Snapshot(), revisedSnapshot)
	conflict := revision
	conflict.RequestFingerprint = strings.Repeat("f", 64)
	if _, err := repository.ReviseTemplate(ctx, 1, conflict); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("conflicting Template revision error = %v", err)
	}
	history, err = repository.GetTemplateRevision(ctx, template.TemplateID, 1)
	if err != nil {
		t.Fatalf("get preserved Template revision 1: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, history.Snapshot(), original)
	history, err = repository.GetTemplateRevision(ctx, template.TemplateID, 2)
	if err != nil {
		t.Fatalf("get preserved Template revision 2: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, history.Snapshot(), revisedSnapshot)
	current, err = repository.GetTemplate(ctx, template.TemplateID)
	if err != nil {
		t.Fatalf("get current Template after retries: %v", err)
	}
	assertModelPolicyTemplateSnapshot(t, current.Revision.Snapshot(), revisedSnapshot)
	var count int
	if err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_template_revisions WHERE template_id=$1`, template.TemplateID).Scan(&count); err != nil || count != 2 {
		t.Fatalf("Template revision count after retries: count=%d err=%v", count, err)
	}
}

func TestModelCallPolicyMaterializedAgentSpecSurvivesExecutionSource(t *testing.T) {
	ctx := context.Background()
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	seedProviderForModel(t, repository, model)
	if _, err := repository.PutModelProfile(ctx, model); err != nil {
		t.Fatalf("put ModelProfile: %v", err)
	}
	template := modelPolicyTemplateRecord(t, integrationTemplateRecord(t, model.Revision),
		&domain.ModelRetryPolicy{Max: 0, BaseMS: 1, CapMS: 30000}, "never", &domain.RunBudget{
			MaxInputTokens: modelPolicyInt64(0), MaxOutputTokens: modelPolicyInt64(domain.MaximumModelBudget),
			MaxCostUSDMicros: modelPolicyInt64(0),
		})
	expected, err := domain.MaterializeAgentSpec(template.Revision, model.Revision)
	if err != nil {
		t.Fatalf("materialize expected Agent spec: %v", err)
	}
	if _, err := repository.PutTemplate(ctx, template); err != nil {
		t.Fatalf("put Template: %v", err)
	}
	loaded, err := repository.GetTemplateRevision(ctx, template.TemplateID, 1)
	if err != nil {
		t.Fatalf("get Template revision: %v", err)
	}
	spec, err := domain.MaterializeAgentSpec(loaded, model.Revision)
	if err != nil {
		t.Fatalf("materialize stored Template: %v", err)
	}
	digest, err := spec.Digest()
	if err != nil {
		t.Fatalf("digest Agent spec: %v", err)
	}
	now := time.Unix(10, 0).UTC()
	const agentID = "agent-model-policy"
	const requestID = "request-agent-model-policy"
	const specID = "agentspec-model-policy"
	begin := ports.BeginAgentCreate{
		Agent: ports.AgentRecord{
			AgentID: agentID, OrganizationID: template.OrganizationID, OwnerUserID: "user-integration", Name: "Policy Agent",
			DesiredState: domain.DesiredEnabled, LifecycleState: domain.AgentCreated,
			ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeUnknown,
			AccessRevision: "access-model-policy", ActiveOperationRequestID: requestID, AggregateSequence: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{
			AgentID: agentID, PrincipalID: "user-integration", AccessRevision: "access-model-policy",
			Active: true, CreatedAt: now, UpdatedAt: now,
		},
		Spec: ports.AgentSpecRecord{
			ID: specID, AgentID: agentID, Revision: 1, Snapshot: spec.Snapshot(), CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: requestID, RequestFingerprint: strings.Repeat("e", 64), AgentID: agentID,
			Kind: domain.OperationCreate, Phase: domain.PhaseNetworkEnsure, State: domain.OperationRunning,
			TargetSpecRevisionID: specID, ChildRequestID: domain.ChildRequestID(requestID, domain.PhaseNetworkEnsure),
			CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: "event-model-policy-create", AgentID: agentID, AggregateSequence: 1,
			SchemaVersion: 1, EventType: ports.EventAgentCreateRequested, OperationRequestID: requestID,
			Data: map[string]any{"template_id": template.TemplateID}, OccurredAt: now,
		},
	}
	if _, replayed, err := repository.BeginAgentCreate(ctx, begin); err != nil || replayed {
		t.Fatalf("persist materialized Agent: replayed=%t err=%v", replayed, err)
	}
	// This covers the durable create intent and raw execution source, without
	// pretending to provision a Runtime or publish an executable Agent here.
	source, err := repository.ReadExecutionSource(ctx, template.OrganizationID)
	if err != nil || len(source.Agents) != 1 {
		t.Fatalf("read execution source: Agents=%d err=%v", len(source.Agents), err)
	}
	if source.Agents[0].Agent.AgentID != agentID || source.Agents[0].Spec.ID != specID {
		t.Fatalf("execution source returned a different Agent spec: Agent=%q spec=%q", source.Agents[0].Agent.AgentID, source.Agents[0].Spec.ID)
	}
	expectedSnapshot := expected.Snapshot()
	expectedJSON, err := json.Marshal(expectedSnapshot)
	if err != nil {
		t.Fatalf("encode original Agent spec: %v", err)
	}
	// Compare the complete persisted representation: empty omitempty collections
	// (SystemSkills and MCP SecretEnv) legitimately decode back as nil.
	for name, actual := range map[string]domain.AgentSpecSnapshot{
		"configured": source.Agents[0].Spec.Snapshot,
		"retained":   source.Agents[0].RetainedSpec.Snapshot,
	} {
		actualJSON, err := json.Marshal(actual)
		if err != nil {
			t.Fatalf("encode %s Agent spec: %v", name, err)
		}
		if !bytes.Equal(actualJSON, expectedJSON) ||
			!reflect.DeepEqual(actual.ModelRetry, expectedSnapshot.ModelRetry) ||
			actual.Failover != expectedSnapshot.Failover ||
			!reflect.DeepEqual(actual.RunBudget, expectedSnapshot.RunBudget) {
			t.Fatalf("%s Agent spec changed: actual=%s expected=%s", name, actualJSON, expectedJSON)
		}
	}
	expectedDigest, err := expected.Digest()
	if err != nil {
		t.Fatalf("digest original Agent spec: %v", err)
	}
	replayedState, found, err := repository.ReplayAgentCreate(ctx, requestID, begin.Operation.RequestFingerprint)
	if err != nil || !found || replayedState.Spec.ID != specID || replayedState.Spec.CanonicalDigest != expectedDigest {
		t.Fatalf("original Agent create receipt changed: found=%t spec=%q digest=%q expected=%q err=%v",
			found, replayedState.Spec.ID, replayedState.Spec.CanonicalDigest, expectedDigest, err)
	}
}

func modelPolicyTemplateRecord(t *testing.T, record ports.TemplateRecord, retry *domain.ModelRetryPolicy, failover string, budget *domain.RunBudget) ports.TemplateRecord {
	t.Helper()
	snapshot := record.Revision.Snapshot()
	snapshot.ModelRetry, snapshot.Failover, snapshot.RunBudget = retry, failover, budget
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput(snapshot))
	if err != nil {
		t.Fatalf("construct model policy Template: %v", err)
	}
	record.Revision = revision
	return record
}

func assertModelPolicyTemplateSnapshot(t *testing.T, actual, expected domain.TemplateRevisionSnapshot) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("immutable Template snapshot changed: actual=%+v expected=%+v", actual, expected)
	}
}

func modelPolicyInt64(value int64) *int64 {
	return &value
}
