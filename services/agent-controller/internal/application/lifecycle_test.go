package application

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCreateAgentMaterializesSpecAndPublishesOnlyAfterRuntimeReady(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: ports.NetworkAttachment{
			AgentID: "agent_expected", TunnelIPv4: "100.64.0.2",
			ResolverIPv4: "100.64.0.1", PacketContractRevision: 1,
			EgressIPv4: "10.20.0.8", EgressPort: 8092, State: "active",
		},
		runtime: ports.RuntimeOperation{
			State: "completed", RuntimeRevision: "runtime-revision-1",
			RuntimeExecutionID: "execution-identity-1",
			MCPEndpoint:        "http://runtime-agent:8091/mcp", LifecycleState: "ready",
			Health: "healthy",
		},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store,
		dependencies,
		dependencies,
		fixedClock{now: time.Unix(10, 0).UTC()},
	)

	result, err := service.CreateAgent(context.Background(), CreateAgentInput{
		RequestID: "request-create-agent", OrganizationID: "org-1",
		OwnerUserID: "user-1", Name: "Research Agent",
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("create Agent: %v", err)
	}

	if !reflect.DeepEqual(dependencies.calls, []string{"egress.ensure", "runtime.initialize"}) {
		t.Fatalf("dependency order = %v", dependencies.calls)
	}
	if result.Agent.LifecycleState != domain.AgentAvailable || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("Agent was published before a completed Runtime: %+v", result)
	}
	if result.Agent.AgentSpecRevisionID == "" || result.Agent.ExecutionRevisionID == "" {
		t.Fatalf("published revision identities are missing: %+v", result.Agent)
	}
	if result.AgentAccessSubject == "" || result.Agent.OwnerUserID != "user-1" {
		t.Fatalf("owner access binding is incomplete: %+v", result)
	}
	if store.initial.Spec.Snapshot.TemplateRevision != 1 ||
		store.initial.Spec.Snapshot.ModelProfileRevisionID != model.ID() {
		t.Fatalf("Agent spec did not freeze exact Catalog revisions: %+v", store.initial.Spec)
	}
	specPayload, err := json.Marshal(store.initial.Spec.Snapshot)
	if err != nil {
		t.Fatalf("marshal Agent spec: %v", err)
	}
	if strings.Contains(string(specPayload), "skill") {
		t.Fatalf("Stage 2 Agent spec must have no Skill surface: %s", specPayload)
	}
	if dependencies.runtimeConfiguration.Network.TunnelIPv4 != "100.64.0.2" ||
		dependencies.runtimeConfiguration.ImageRef != template.Snapshot().Runtime.ImageRef {
		t.Fatalf("Runtime configuration was not assembled from frozen spec and Egress: %+v", dependencies.runtimeConfiguration)
	}
	if store.published.Execution.RuntimeRevision != "runtime-revision-1" ||
		store.published.ReadyEvent.EventType != ports.EventAgentReady {
		t.Fatalf("publish transaction is incomplete: %+v", store.published)
	}
}

func TestCreateAgentCompletedRetryDoesNotRepeatDependencies(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	completed := completedCreateState(t, template, model)
	store := &lifecycleStoreStub{beginState: completed, replayed: true}
	dependencies := &lifecycleDependenciesStub{}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store,
		dependencies,
		dependencies,
		fixedClock{now: time.Unix(20, 0).UTC()},
	)

	result, err := service.CreateAgent(context.Background(), CreateAgentInput{
		RequestID: "request-create-agent", OrganizationID: "org-1",
		OwnerUserID: "user-1", Name: "Research Agent",
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("replay create Agent: %v", err)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("completed retry repeated external effects: %v", dependencies.calls)
	}
	if result.Agent.LifecycleState != domain.AgentAvailable || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("completed result was not replayed: %+v", result)
	}
}

func TestCreateAgentFingerprintIgnoresTraceContext(t *testing.T) {
	t.Parallel()

	input := CreateAgentInput{
		RequestID: "request-create-agent", OrganizationID: "org-1",
		OwnerUserID: "user-1", Name: "Research Agent",
		TemplateID: "template-1", TemplateRevision: 1,
		InitialTraceParent: "00-11111111111111111111111111111111-1111111111111111-01",
	}
	first, err := createAgentFingerprint(input)
	if err != nil {
		t.Fatalf("first fingerprint: %v", err)
	}
	input.InitialTraceParent = "00-22222222222222222222222222222222-2222222222222222-01"
	second, err := createAgentFingerprint(input)
	if err != nil {
		t.Fatalf("second fingerprint: %v", err)
	}
	if first != second {
		t.Fatalf("trace context changed business fingerprint: %q != %q", first, second)
	}
}

func TestCreateAgentDoesNotStartRuntimeWithInactiveNetwork(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{network: ports.NetworkAttachment{
		TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: "quarantined",
	}}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(30, 0).UTC()},
	)

	result, err := service.CreateAgent(context.Background(), CreateAgentInput{
		RequestID: "request-inactive-network", OrganizationID: "org-1",
		OwnerUserID: "user-1", Name: "Research Agent",
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("create Agent: %v", err)
	}
	if !reflect.DeepEqual(dependencies.calls, []string{"egress.ensure"}) {
		t.Fatalf("inactive network reached Runtime: %v", dependencies.calls)
	}
	if result.Agent.LifecycleState != domain.AgentUnavailable ||
		result.Operation.State != domain.OperationFailed ||
		result.Operation.ErrorCode != "invalid_network_attachment" {
		t.Fatalf("inactive network result = %+v", result)
	}
}

type lifecycleSpecSourceStub struct {
	template domain.TemplateRevision
	model    domain.ModelProfileRevision
}

func (source lifecycleSpecSourceStub) GetTemplateRevision(
	_ context.Context, templateID string, revision int64,
) (domain.TemplateRevision, error) {
	if source.template.Snapshot().TemplateID != templateID || source.template.Revision() != revision {
		return domain.TemplateRevision{}, ports.ErrNotFound
	}
	return source.template, nil
}

func (source lifecycleSpecSourceStub) GetModelProfileRevision(
	_ context.Context, id string,
) (domain.ModelProfileRevision, error) {
	if source.model.ID() != id {
		return domain.ModelProfileRevision{}, ports.ErrNotFound
	}
	return source.model, nil
}

type lifecycleDependenciesStub struct {
	calls                []string
	network              ports.NetworkAttachment
	runtime              ports.RuntimeOperation
	runtimeConfiguration ports.RuntimeConfiguration
}

func (dependency *lifecycleDependenciesStub) EnsureAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.ensure")
	result := dependency.network
	result.AgentID = agentID
	return result, nil
}

func (dependency *lifecycleDependenciesStub) InitializeRuntime(
	_ context.Context, _ string, _ string, configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.initialize")
	dependency.runtimeConfiguration = configuration
	return dependency.runtime, nil
}

type lifecycleStoreStub struct {
	initial    ports.BeginAgentCreate
	beginState ports.AgentCreateState
	replayed   bool
	published  ports.PublishAgentCreate
	failed     ports.FailAgentCreate
}

func (store *lifecycleStoreStub) ReplayAgentCreate(
	_ context.Context, _ string, _ string,
) (ports.AgentCreateState, bool, error) {
	return store.beginState, store.replayed, nil
}

func (store *lifecycleStoreStub) BeginAgentCreate(
	_ context.Context, input ports.BeginAgentCreate,
) (ports.AgentCreateState, bool, error) {
	store.initial = input
	if store.replayed {
		return store.beginState, true, nil
	}
	return ports.AgentCreateState{
		Agent: input.Agent, Access: input.Access, Spec: input.Spec,
		Operation: input.Operation,
	}, false, nil
}

func (store *lifecycleStoreStub) RecordCreateNetwork(
	_ context.Context, requestID string, fingerprint string,
	attachment ports.NetworkAttachment, nextChildRequestID string, now time.Time,
) (ports.AgentCreateState, error) {
	state := ports.AgentCreateState{
		Agent: store.initial.Agent, Access: store.initial.Access, Spec: store.initial.Spec,
		Operation: store.initial.Operation,
	}
	state.Operation.Phase = domain.PhaseRuntimeInitialize
	state.Operation.ChildRequestID = nextChildRequestID
	state.Operation.NetworkAttachment = &attachment
	state.Operation.UpdatedAt = now
	store.beginState = state
	return state, nil
}

func (store *lifecycleStoreStub) RecordCreateRuntime(
	_ context.Context, _ string, _ string,
	runtime ports.RuntimeOperation, nextChildRequestID string, now time.Time,
) (ports.AgentCreateState, error) {
	state := store.beginState
	state.Operation.Phase = domain.PhasePublish
	state.Operation.ChildRequestID = nextChildRequestID
	state.Operation.RuntimeResult = &runtime
	state.Operation.UpdatedAt = now
	store.beginState = state
	return state, nil
}

func (store *lifecycleStoreStub) PublishAgentCreate(
	_ context.Context, input ports.PublishAgentCreate,
) (ports.AgentCreateState, error) {
	store.published = input
	state := store.beginState
	state.Agent.LifecycleState = domain.AgentAvailable
	state.Agent.AgentSpecRevisionID = state.Spec.ID
	state.Agent.ExecutionRevisionID = input.Execution.ID
	state.Agent.LastSuccessfulExecutionRevisionID = input.Execution.ID
	state.Agent.RuntimeRevision = input.Execution.RuntimeRevision
	state.Agent.RuntimeExecutionID = input.Execution.RuntimeExecutionID
	state.Agent.RuntimeMCPEndpoint = input.Execution.RuntimeMCPEndpoint
	state.Agent.ActiveOperationRequestID = ""
	state.Agent.UpdatedAt = input.Now
	state.Operation.Phase = domain.PhaseCompleted
	state.Operation.State = domain.OperationCompleted
	state.Operation.ChildRequestID = ""
	state.Operation.UpdatedAt = input.Now
	return state, nil
}

func (store *lifecycleStoreStub) FailAgentCreate(
	_ context.Context, input ports.FailAgentCreate,
) (ports.AgentCreateState, error) {
	store.failed = input
	state := store.beginState
	if state.Agent.AgentID == "" {
		state = ports.AgentCreateState{
			Agent: store.initial.Agent, Access: store.initial.Access, Spec: store.initial.Spec,
			Operation: store.initial.Operation,
		}
	}
	state.Agent.LifecycleState = domain.AgentUnavailable
	state.Agent.ActiveOperationRequestID = ""
	state.Agent.FailureStage = string(input.Stage)
	state.Agent.FailureCode = input.Code
	state.Agent.FailureDetail = input.Detail
	state.Agent.AggregateSequence = input.FailedEvent.AggregateSequence
	state.Agent.UpdatedAt = input.Now
	state.Operation.State = domain.OperationFailed
	state.Operation.ErrorCode = input.Code
	state.Operation.ErrorDetail = input.Detail
	state.Operation.Retryable = input.Retryable
	state.Operation.UpdatedAt = input.Now
	return state, nil
}

func mustLifecycleTemplate(t *testing.T) domain.TemplateRevision {
	t.Helper()
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileRevisionID: "model-revision-1", SystemPrompt: "Be useful.",
		MaxModelRequests: 12, ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: validRuntimeInput(),
	})
	if err != nil {
		t.Fatalf("Template revision: %v", err)
	}
	return revision
}

func mustLifecycleModel(t *testing.T) domain.ModelProfileRevision {
	t.Helper()
	return mustModelRevision(t, "model-revision-1", "org-1")
}

func completedCreateState(
	t *testing.T, template domain.TemplateRevision, model domain.ModelProfileRevision,
) ports.AgentCreateState {
	t.Helper()
	spec, err := domain.MaterializeAgentSpec(template, model)
	if err != nil {
		t.Fatalf("materialize Agent spec: %v", err)
	}
	now := time.Unix(10, 0).UTC()
	return ports.AgentCreateState{
		Agent: ports.AgentRecord{
			AgentID: "agent-existing", OrganizationID: "org-1", OwnerUserID: "user-1",
			Name: "Research Agent", DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentAvailable, AccessRevision: "access-revision-1",
			AgentSpecRevisionID: "agentspec-existing", ExecutionRevisionID: "execution-existing",
			LastSuccessfulExecutionRevisionID: "execution-existing",
			RuntimeRevision:                   "runtime-existing", RuntimeExecutionID: "runtime-execution-existing",
			RuntimeMCPEndpoint: "http://runtime/mcp", CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{AccessSubject: "access-existing", AgentID: "agent-existing"},
		Spec:   ports.AgentSpecRecord{ID: "agentspec-existing", AgentID: "agent-existing", Revision: 1, Snapshot: spec.Snapshot()},
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-create-agent", AgentID: "agent-existing",
			Kind: domain.OperationCreate, Phase: domain.PhaseCompleted,
			State: domain.OperationCompleted, CreatedAt: now, UpdatedAt: now,
		},
	}
}
