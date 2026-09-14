package application

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestCreateAgentAcceptsDurableIntentWithoutCallingRuntimeDependencies(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed", RuntimeRevision: "runtime-revision-1",
			RuntimeExecutionID: "", MCPEndpoint: "",
			LifecycleState: "provisioned", Health: "unknown",
		},
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := service.CreateAgent(
		context.Background(), lifecycleCreateInput("request-accepted-intent"),
	)
	if err != nil {
		t.Fatalf("accept Agent create: %v", err)
	}
	if len(dependencies.calls) != 0 {
		t.Fatalf("request path called lifecycle dependencies: %v", dependencies.calls)
	}
	if result.Operation.State != domain.OperationRunning ||
		result.Operation.Phase != domain.PhaseNetworkEnsure ||
		result.Agent.LifecycleState != domain.AgentNotCreated || result.Agent.ActivationState != "" || result.Agent.RuntimeState != domain.RuntimeUnknown {
		t.Fatalf("accepted lifecycle intent = %+v", result)
	}
}

func TestCreateAgentMaterializesSpecAndCompletesWithoutRuntimeReadiness(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: ports.NetworkAttachment{
			AgentID: "agent_expected", TunnelIPv4: "100.64.0.2",
			ResolverIPv4: "100.64.0.1", PacketContractRevision: 1,
			EgressIPv4: "10.20.0.8", EgressPort: 8092, State: "active",
			NetworkResourceVersion: 1, AttachmentState: ports.NetworkAttachmentClosed,
			AttachmentResourceVersion: 1,
		},
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed", RuntimeRevision: "runtime-revision-1",
			RuntimeExecutionID: "",
			MCPEndpoint:        "", LifecycleState: "provisioned",
			Health: "unknown",
		},
	}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store,
		dependencies,
		dependencies,
		fixedClock{now: time.Unix(10, 0).UTC()},
		WithIdentityDirectory(activeIdentityDirectory()),
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	result, err := executeCreateForTest(service, context.Background(), CreateAgentInput{
		RequestID: "request-create-agent", OrganizationID: "org-1",
		OwnerUserID: "user-1", Name: "Research Agent",
		TemplateID: "template-1", TemplateRevision: 1,
	})
	if err != nil {
		t.Fatalf("create Agent: %v", err)
	}

	if !reflect.DeepEqual(
		dependencies.calls,
		[]string{"egress.ensure", "runtime.initialize", "egress.attachment.open"},
	) {
		t.Fatalf("dependency order = %v", dependencies.calls)
	}
	if (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("Agent was published before a completed Runtime: %+v", result)
	}
	if result.Agent.AgentSpecRevisionID == "" || result.Agent.ExecutionRevisionID != "" {
		t.Fatalf("published revision identities are missing: %+v", result.Agent)
	}
	if result.Agent.OwnerUserID != "user-1" {
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
	if !reflect.DeepEqual(dependencies.runtimeConfiguration.MCPServers, template.Snapshot().Runtime.MCPServers) {
		t.Fatal("create did not forward frozen MCP configuration")
	}
	if store.beginState.Agent.RuntimeRevision != "runtime-revision-1" ||
		store.published.CreatedEvent.EventType != ports.EventAgentCreated {
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
		WithIdentityDirectory(&identityDirectoryStub{err: errors.New("identity unavailable")}),
	)

	result, err := executeCreateForTest(service, context.Background(), CreateAgentInput{
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
	if (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeAvailable) || result.Operation.State != domain.OperationCompleted {
		t.Fatalf("completed result was not replayed: %+v", result)
	}
}

func TestCreateAgentRunningRetryKeepsPersistedAuthorizationDecision(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	input := lifecycleCreateInput("request-create-agent")
	fingerprint, err := createAgentFingerprint(input)
	if err != nil {
		t.Fatalf("fingerprint create intent: %v", err)
	}
	running := completedCreateState(t, template, model)
	running.Agent.LifecycleState, running.Agent.ActivationState, running.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	running.Agent.AgentSpecRevisionID = ""
	running.Agent.ExecutionRevisionID = ""
	running.Agent.LastSuccessfulExecutionRevisionID = ""
	running.Agent.RuntimeRevision = ""
	running.Agent.RuntimeExecutionID = ""
	running.Agent.RuntimeMCPEndpoint = ""
	running.Operation.Phase = domain.PhaseNetworkEnsure
	running.Operation.State = domain.OperationRunning
	running.Operation.RequestFingerprint = fingerprint
	running.Operation.ChildRequestID = domain.ChildRequestID(
		running.Operation.RequestID, domain.PhaseNetworkEnsure,
	)
	store := &lifecycleStoreStub{beginState: running, replayed: true}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed", RuntimeRevision: "runtime-revision-1",
			RuntimeExecutionID: "", MCPEndpoint: "",
			LifecycleState: "provisioned", Health: "unknown",
		},
	}
	identities := &identityDirectoryStub{err: errors.New("identity unavailable")}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model}, store,
		dependencies, dependencies, fixedClock{now: time.Unix(20, 0).UTC()},
		WithIdentityDirectory(identities),
	)

	result, err := executeCreateForTest(service, context.Background(), input)
	if err != nil {
		t.Fatalf("continue persisted create intent: %v", err)
	}
	if identities.calls != 0 {
		t.Fatalf("persisted create intent revalidated Identity %d times", identities.calls)
	}
	if (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
		result.Operation.State != domain.OperationCompleted {
		t.Fatalf("persisted create intent did not converge: %+v", result)
	}
}

func TestCreateAgentReplaysConcurrentIntentAfterIdentityFailure(t *testing.T) {
	t.Parallel()

	template := mustLifecycleTemplate(t)
	model := mustLifecycleModel(t)
	store := &lifecycleStoreStub{
		beginState: completedCreateState(t, template, model), replayOnCall: 2,
	}
	identities := &identityDirectoryStub{err: errors.New("identity unavailable")}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model}, store,
		&lifecycleDependenciesStub{}, &lifecycleDependenciesStub{},
		fixedClock{now: time.Unix(20, 0).UTC()}, WithIdentityDirectory(identities),
	)

	result, err := executeCreateForTest(
		service, context.Background(), lifecycleCreateInput("request-create-agent"),
	)
	if err != nil {
		t.Fatalf("replay concurrently persisted create intent: %v", err)
	}
	if result.Operation.State != domain.OperationCompleted || store.replayCalls != 2 {
		t.Fatalf("concurrent create was not replayed: result=%+v calls=%d", result, store.replayCalls)
	}
	if identities.calls != 1 {
		t.Fatalf("Identity calls=%d want=1", identities.calls)
	}
}

func TestCreateAgentFingerprintNormalizesDisplayName(t *testing.T) {
	t.Parallel()

	input := CreateAgentInput{
		RequestID: "request-create-agent", OrganizationID: "org-1",
		OwnerUserID: "user-1", Name: "Research Agent",
		TemplateID: "template-1", TemplateRevision: 1,
	}
	first, err := createAgentFingerprint(input)
	if err != nil {
		t.Fatalf("first fingerprint: %v", err)
	}
	input.Name = "  Research Agent  "
	second, err := createAgentFingerprint(input)
	if err != nil {
		t.Fatalf("second fingerprint: %v", err)
	}
	if first != second {
		t.Fatalf("display whitespace changed business fingerprint: %q != %q", first, second)
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
		State: ports.NetworkStateQuarantined, NetworkResourceVersion: 2,
		AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 1,
	}}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: template, model: model},
		store, dependencies, dependencies, fixedClock{now: time.Unix(30, 0).UTC()},
		WithIdentityDirectory(activeIdentityDirectory()),
	)

	result, err := executeCreateForTest(service, context.Background(), CreateAgentInput{
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
	if (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) ||
		result.Operation.State != domain.OperationFailed ||
		result.Operation.ErrorCode != "invalid_network_attachment" {
		t.Fatalf("inactive network result = %+v", result)
	}
}

func TestCreateAgentRejectsRuntimeWithoutConfirmedEffect(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		network: validLifecycleNetwork(),
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "unknown", RuntimeRevision: "runtime-revision-1",
			RuntimeExecutionID: "", MCPEndpoint: "",
			LifecycleState: "provisioned", Health: "unknown",
		},
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeCreateForTest(
		service, context.Background(), lifecycleCreateInput("request-unconfirmed-effect"),
	)
	if err != nil {
		t.Fatalf("create Agent: %v", err)
	}
	if result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "invalid_runtime_result" {
		t.Fatalf("unconfirmed Runtime result = %+v", result)
	}
	if store.published.RequestID != "" {
		t.Fatalf("unconfirmed Runtime was published: %+v", store.published)
	}
}

func TestCreateAgentRequiresActiveOrganizationOwnerBeforePersistingIntent(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{}
	identities := &identityDirectoryStub{principal: ports.IdentityPrincipal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1", Active: false,
	}}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: mustLifecycleTemplate(t), model: mustLifecycleModel(t)},
		store, dependencies, dependencies, fixedClock{now: time.Unix(40, 0).UTC()},
		WithIdentityDirectory(identities),
	)

	_, err := service.CreateAgent(context.Background(), lifecycleCreateInput("request-inactive-owner"))
	if !errors.Is(err, ErrInvalidReference) {
		t.Fatalf("inactive owner error = %v, want invalid reference", err)
	}
	if identities.calls != 1 || store.initial.Agent.AgentID != "" || len(dependencies.calls) != 0 {
		t.Fatalf("owner validation leaked effects: identity=%d initial=%+v dependencies=%v",
			identities.calls, store.initial, dependencies.calls)
	}
}

func TestCreateAgentFailsAsDependencyUnavailableWithoutIdentityDirectory(t *testing.T) {
	t.Parallel()

	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{}
	service := NewLifecycleService(
		lifecycleSpecSourceStub{template: mustLifecycleTemplate(t), model: mustLifecycleModel(t)},
		store, dependencies, dependencies, fixedClock{now: time.Unix(41, 0).UTC()},
		WithLifecycleExecution(testExecutionForStore(store)),
	)

	_, err := service.CreateAgent(context.Background(), lifecycleCreateInput("request-missing-identity"))
	if !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("missing Identity directory error = %v, want dependency unavailable", err)
	}
	if store.initial.Agent.AgentID != "" || len(dependencies.calls) != 0 {
		t.Fatalf("missing Identity directory leaked effects: initial=%+v dependencies=%v",
			store.initial, dependencies.calls)
	}
}

func TestCreateAgentRejectsChangedNetworkAtPublicationBarrier(t *testing.T) {
	t.Parallel()

	first := validLifecycleNetwork()
	second := first
	second.TunnelIPv4 = "100.64.0.3"
	store := &lifecycleStoreStub{}
	dependencies := &lifecycleDependenciesStub{
		networkResults: []ports.NetworkAttachment{first, second},
		runtime: ports.RuntimeOperation{
			State: "completed", Effect: "completed", RuntimeRevision: "runtime-revision-1",
			RuntimeExecutionID: "", MCPEndpoint: "",
			LifecycleState: "provisioned", Health: "unknown",
		},
	}
	service := newLifecycleTestService(t, store, dependencies)

	result, err := executeCreateForTest(
		service, context.Background(), lifecycleCreateInput("request-network-changed"),
	)
	if err != nil {
		t.Fatalf("create Agent: %v", err)
	}
	if result.Operation.State != domain.OperationFailed || result.Operation.ErrorCode != "network_attachment_changed" {
		t.Fatalf("changed network result = %+v", result)
	}
	if store.published.RequestID != "" {
		t.Fatalf("stale Runtime binding was published: %+v", store.published)
	}
}

func TestCreateAgentConvergesAfterConcurrentExactReplay(t *testing.T) {
	t.Parallel()

	for _, phase := range []string{"network", "runtime", "publish"} {
		phase := phase
		t.Run(phase, func(t *testing.T) {
			t.Parallel()
			store := &lifecycleStoreStub{concurrentPhase: phase}
			dependencies := &lifecycleDependenciesStub{
				network: validLifecycleNetwork(),
				runtime: ports.RuntimeOperation{
					State: "completed", Effect: "completed", RuntimeRevision: "runtime-revision-1",
					RuntimeExecutionID: "", MCPEndpoint: "",
					LifecycleState: "provisioned", Health: "unknown",
				},
			}
			service := newLifecycleTestService(t, store, dependencies)

			result, err := executeCreateForTest(
				service, context.Background(), lifecycleCreateInput("request-concurrent-"+phase),
			)
			if err != nil {
				t.Fatalf("converge exact replay: %v", err)
			}
			if result.Operation.State != domain.OperationCompleted || (result.Agent.LifecycleState != domain.AgentCreated || result.Agent.ActivationState != domain.ActivationEnabled || result.Agent.RuntimeState != domain.RuntimeUnknown) {
				t.Fatalf("converged result = %+v", result)
			}
		})
	}
}

func TestGetLifecycleOperationReturnsDurableState(t *testing.T) {
	t.Parallel()

	now := time.Unix(40, 0).UTC()
	store := &lifecycleStoreStub{operation: ports.LifecycleOperationRecord{
		RequestID: "request-operation", AgentID: "agent-1", Kind: domain.OperationCreate,
		Phase: domain.PhaseRuntimeInitialize, State: domain.OperationRunning,
		CreatedAt: now, UpdatedAt: now,
	}}
	service := newLifecycleTestService(t, store, &lifecycleDependenciesStub{})

	operation, err := service.GetLifecycleOperation(context.Background(), "request-operation")
	if err != nil {
		t.Fatalf("get lifecycle operation: %v", err)
	}
	if operation.RequestID != "request-operation" || operation.Phase != domain.PhaseRuntimeInitialize {
		t.Fatalf("operation = %+v", operation)
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

func (source lifecycleSpecSourceStub) GetCurrentModelProfileRevision(
	_ context.Context, id string,
) (domain.ModelProfileRevision, error) {
	if source.model.Snapshot().ModelProfileID != id {
		return domain.ModelProfileRevision{}, ports.ErrNotFound
	}
	return source.model, nil
}

type lifecycleDependenciesStub struct {
	calls                []string
	network              ports.NetworkAttachment
	networkResults       []ports.NetworkAttachment
	networkIndex         int
	runtime              ports.RuntimeOperation
	runtimeConfiguration ports.RuntimeConfiguration
	runtimeRequestID     string
	runtimeAgentID       string
}

func (dependency *lifecycleDependenciesStub) EnsureAgentNetwork(
	_ context.Context, agentID string,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.ensure")
	result := dependency.network
	if dependency.networkIndex < len(dependency.networkResults) {
		result = dependency.networkResults[dependency.networkIndex]
	}
	dependency.networkIndex++
	result.AgentID = agentID
	return result, nil
}

func (dependency *lifecycleDependenciesStub) GetAgentNetwork(
	context.Context, string,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network read")
}

func (dependency *lifecycleDependenciesStub) SetAgentNetworkAttachment(
	_ context.Context, agentID string, state string, _ uint64,
) (ports.NetworkAttachment, error) {
	dependency.calls = append(dependency.calls, "egress.attachment."+state)
	result := dependency.network
	if dependency.networkIndex < len(dependency.networkResults) {
		result = dependency.networkResults[dependency.networkIndex]
	}
	dependency.networkIndex++
	result.AgentID = agentID
	result.AttachmentState = state
	if result.AttachmentResourceVersion == 0 {
		result.AttachmentResourceVersion = 1
	}
	result.AttachmentResourceVersion++
	return result, nil
}

func (dependency *lifecycleDependenciesStub) ReleaseAgentNetwork(
	context.Context, string, uint64,
) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected Egress network release")
}

func (dependency *lifecycleDependenciesStub) InitializeRuntime(
	_ context.Context, requestID string, agentID string, configuration ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	dependency.calls = append(dependency.calls, "runtime.initialize")
	dependency.runtimeRequestID = requestID
	dependency.runtimeAgentID = agentID
	dependency.runtimeConfiguration = configuration
	return dependency.runtime, nil
}

func (dependency *lifecycleDependenciesStub) UpdateRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime update")
}

func (dependency *lifecycleDependenciesStub) DisableRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime disable")
}

func (dependency *lifecycleDependenciesStub) EnableRuntime(
	context.Context, string, string, string, ports.RuntimeConfiguration,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime enable")
}

func (dependency *lifecycleDependenciesStub) DeleteRuntime(
	context.Context, string, string, string,
) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected Runtime delete")
}

func (dependency *lifecycleDependenciesStub) InspectRuntime(
	context.Context, string,
) (ports.RuntimeInspection, error) {
	return ports.RuntimeInspection{}, errors.New("unexpected Runtime inspection")
}

type lifecycleStoreStub struct {
	initial            ports.BeginAgentCreate
	beginState         ports.AgentCreateState
	replayed           bool
	replayCalls        int
	replayOnCall       int
	published          ports.PublishAgentCreate
	failed             ports.FailAgentCreate
	operation          ports.LifecycleOperationRecord
	concurrentPhase    string
	concurrentReturned bool
}

func (store *lifecycleStoreStub) ConfirmLifecycleDrain(context.Context, ports.ConfirmLifecycleDrain) (ports.LifecycleOperationRecord, error) {
	return ports.LifecycleOperationRecord{}, errors.New("unexpected Agent drain confirmation")
}

func (store *lifecycleStoreStub) GetLifecycleOperation(
	_ context.Context, _ string,
) (ports.LifecycleOperationRecord, error) {
	return store.operation, nil
}

func (store *lifecycleStoreStub) GetAgentLifecycleBase(
	context.Context, string,
) (ports.AgentLifecycleBase, error) {
	return ports.AgentLifecycleBase{}, errors.New("unexpected Agent lifecycle base read")
}

func (store *lifecycleStoreStub) ReplayAgentRebuild(
	context.Context, string, string,
) (ports.AgentRebuildState, bool, error) {
	return ports.AgentRebuildState{}, false, errors.New("unexpected Agent rebuild replay")
}

func (store *lifecycleStoreStub) BeginAgentRebuild(
	context.Context, ports.BeginAgentRebuild,
) (ports.AgentRebuildState, bool, error) {
	return ports.AgentRebuildState{}, false, errors.New("unexpected Agent rebuild begin")
}

func (store *lifecycleStoreStub) AdvanceAgentRebuild(
	context.Context, ports.AdvanceAgentRebuild,
) (ports.LifecycleAdvanceResult, error) {
	return ports.LifecycleAdvanceResult{}, errors.New("unexpected Agent rebuild advance")
}

func (store *lifecycleStoreStub) PublishAgentRebuild(
	context.Context, ports.PublishAgentRebuild,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, errors.New("unexpected Agent rebuild publish")
}

func (store *lifecycleStoreStub) FailAgentRebuild(
	context.Context, ports.FailAgentRebuild,
) (ports.AgentRebuildState, error) {
	return ports.AgentRebuildState{}, errors.New("unexpected Agent rebuild failure")
}

func (store *lifecycleStoreStub) ReplayAgentDisable(
	context.Context, string, string,
) (ports.AgentDisableState, bool, error) {
	return ports.AgentDisableState{}, false, errors.New("unexpected Agent disable replay")
}

func (store *lifecycleStoreStub) BeginAgentDisable(
	context.Context, ports.BeginAgentDisable,
) (ports.AgentDisableState, bool, error) {
	return ports.AgentDisableState{}, false, errors.New("unexpected Agent disable begin")
}

func (store *lifecycleStoreStub) AdvanceAgentDisable(
	context.Context, ports.AdvanceAgentDisable,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, errors.New("unexpected Agent disable advance")
}

func (store *lifecycleStoreStub) PublishAgentDisable(
	context.Context, ports.PublishAgentDisable,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, errors.New("unexpected Agent disable publish")
}

func (store *lifecycleStoreStub) FailAgentDisable(
	context.Context, ports.FailAgentDisable,
) (ports.AgentDisableState, error) {
	return ports.AgentDisableState{}, errors.New("unexpected Agent disable failure")
}

func (store *lifecycleStoreStub) GetAgentEnableBase(
	context.Context, string,
) (ports.AgentEnableBase, error) {
	return ports.AgentEnableBase{}, errors.New("unexpected Agent enable base read")
}

func (store *lifecycleStoreStub) ReplayAgentEnable(
	context.Context, string, string,
) (ports.AgentEnableState, bool, error) {
	return ports.AgentEnableState{}, false, errors.New("unexpected Agent enable replay")
}

func (store *lifecycleStoreStub) BeginAgentEnable(
	context.Context, ports.BeginAgentEnable,
) (ports.AgentEnableState, bool, error) {
	return ports.AgentEnableState{}, false, errors.New("unexpected Agent enable begin")
}

func (store *lifecycleStoreStub) AdvanceAgentEnable(
	context.Context, ports.AdvanceAgentEnable,
) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, errors.New("unexpected Agent enable advance")
}

func (store *lifecycleStoreStub) PublishAgentEnable(
	context.Context, ports.PublishAgentEnable,
) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, errors.New("unexpected Agent enable publish")
}

func (store *lifecycleStoreStub) FailAgentEnable(
	context.Context, ports.FailAgentEnable,
) (ports.AgentEnableState, error) {
	return ports.AgentEnableState{}, errors.New("unexpected Agent enable failure")
}

func (store *lifecycleStoreStub) GetAgentDeleteBase(
	context.Context, string,
) (ports.AgentDeleteBase, error) {
	return ports.AgentDeleteBase{}, errors.New("unexpected Agent delete base read")
}

func (store *lifecycleStoreStub) ReplayAgentDelete(
	context.Context, string, string,
) (ports.AgentDeleteState, bool, error) {
	return ports.AgentDeleteState{}, false, errors.New("unexpected Agent delete replay")
}

func (store *lifecycleStoreStub) BeginAgentDelete(
	context.Context, ports.BeginAgentDelete,
) (ports.AgentDeleteState, bool, error) {
	return ports.AgentDeleteState{}, false, errors.New("unexpected Agent delete begin")
}

func (store *lifecycleStoreStub) AdvanceAgentDelete(
	context.Context, ports.AdvanceAgentDelete,
) (ports.AgentDeleteState, error) {
	return ports.AgentDeleteState{}, errors.New("unexpected Agent delete advance")
}

func (store *lifecycleStoreStub) PublishAgentDelete(
	context.Context, ports.PublishAgentDelete,
) (ports.AgentDeleteState, error) {
	return ports.AgentDeleteState{}, errors.New("unexpected Agent delete publish")
}

func (store *lifecycleStoreStub) ReplayAgentCreate(
	_ context.Context, _ string, _ string,
) (ports.AgentCreateState, bool, error) {
	store.replayCalls++
	found := store.replayed || store.replayOnCall > 0 && store.replayCalls >= store.replayOnCall
	return store.beginState, found, nil
}

func (store *lifecycleStoreStub) BeginAgentCreate(
	_ context.Context, input ports.BeginAgentCreate,
) (ports.AgentCreateState, bool, error) {
	store.initial = input
	if store.replayed {
		return store.beginState, true, nil
	}
	store.beginState = ports.AgentCreateState{
		Agent: input.Agent, Access: input.Access, Spec: input.Spec,
		Operation: input.Operation,
	}
	store.replayed = true
	return store.beginState, false, nil
}

func (store *lifecycleStoreStub) RecordCreateNetwork(
	_ context.Context, requestID string, fingerprint string,
	attachment ports.NetworkAttachment, nextChildRequestID string, now time.Time,
) (ports.AgentCreateState, error) {
	state := store.beginState
	if state.Agent.AgentID == "" {
		state = ports.AgentCreateState{
			Agent: store.initial.Agent, Access: store.initial.Access, Spec: store.initial.Spec,
			Operation: store.initial.Operation,
		}
	}
	state.Operation.Phase = domain.PhaseRuntimeInitialize
	state.Operation.ChildRequestID = nextChildRequestID
	state.Operation.NetworkAttachment = &attachment
	state.Operation.UpdatedAt = now
	store.beginState = state
	if store.takeConcurrent("network") {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
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
	if store.takeConcurrent("runtime") {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	return state, nil
}

func (store *lifecycleStoreStub) PublishAgentCreate(
	_ context.Context, input ports.PublishAgentCreate,
) (ports.AgentCreateState, error) {
	store.published = input
	state := store.beginState
	state.Agent.LifecycleState, state.Agent.ActivationState, state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
	state.Agent.AgentSpecRevisionID = state.Spec.ID
	state.Agent.ExecutionRevisionID = ""
	state.Agent.RuntimeRevision = state.Operation.RuntimeResult.RuntimeRevision
	state.Agent.RuntimeExecutionID = ""
	state.Agent.RuntimeMCPEndpoint = ""
	state.Agent.ActiveOperationRequestID = ""
	state.Agent.UpdatedAt = input.Now
	state.Operation.Phase = domain.PhaseCompleted
	state.Operation.State = domain.OperationCompleted
	state.Operation.NetworkAttachment = &input.NetworkAttachment
	state.Operation.ChildRequestID = ""
	state.Operation.UpdatedAt = input.Now
	store.beginState = state
	if store.takeConcurrent("publish") {
		return ports.AgentCreateState{}, ports.ErrConcurrentChange
	}
	return state, nil
}

func (store *lifecycleStoreStub) takeConcurrent(phase string) bool {
	if store.concurrentReturned || store.concurrentPhase != phase {
		return false
	}
	store.concurrentReturned = true
	store.replayed = true
	return true
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
	state.Agent.LifecycleState, state.Agent.ActivationState, state.Agent.RuntimeState = domain.AgentCreated, domain.ActivationEnabled, domain.RuntimeUnknown
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
	runtime := validRuntimeInput()
	runtime.ImageRef = "antnest/runtime:latest"
	runtime.MCPServers = []domain.MCPServer{{ID: "documents", Command: "node", Args: []string{"/workspace/documents.js"}, Env: map[string]string{"TOKEN": "synthetic-token"}}}
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: "template-1", OrganizationID: "org-1", Revision: 1,
		ModelProfileID: "model-1", SystemPrompt: "Be useful.",
		MaxModelRequests: 12, ContextPolicyVersion: domain.ContextPolicyV1,
		Runtime: runtime,
	})
	if err != nil {
		t.Fatalf("Template revision: %v", err)
	}
	return revision
}

type lifecycleDependencies interface {
	ports.EgressClient
	ports.RuntimeClient
}

func newLifecycleTestService(
	t *testing.T, store ports.LifecycleStore, dependencies lifecycleDependencies,
) *LifecycleService {
	t.Helper()
	return NewLifecycleService(
		lifecycleSpecSourceStub{template: mustLifecycleTemplate(t), model: mustLifecycleModel(t)},
		store, dependencies, dependencies, fixedClock{now: time.Unix(50, 0).UTC()},
		WithIdentityDirectory(activeIdentityDirectory()),
		WithLifecycleExecution(testExecutionForStore(store)),
	)
}

type identityDirectoryStub struct {
	principal ports.IdentityPrincipal
	err       error
	calls     int
}

func (stub *identityDirectoryStub) ResolveOwnerAuthorization(ctx context.Context, org, user string) (ports.IdentityPrincipal, error) {
	return stub.ResolvePrincipal(ctx, org, user)
}

func (stub *identityDirectoryStub) ResolvePrincipal(
	context.Context, string, string,
) (ports.IdentityPrincipal, error) {
	stub.calls++
	return stub.principal, stub.err
}

func activeIdentityDirectory() *identityDirectoryStub {
	return &identityDirectoryStub{principal: ports.IdentityPrincipal{
		UserID: "user-1", OrganizationID: "org-1", MembershipID: "membership-1", Active: true,
	}}
}

func lifecycleCreateInput(requestID string) CreateAgentInput {
	return CreateAgentInput{
		RequestID: requestID, OrganizationID: "org-1", OwnerUserID: "user-1",
		Name: "Research Agent", TemplateID: "template-1", TemplateRevision: 1,
	}
}

func validLifecycleNetwork() ports.NetworkAttachment {
	return ports.NetworkAttachment{
		TunnelIPv4: "100.64.0.2", ResolverIPv4: "100.64.0.1",
		PacketContractRevision: 1, EgressIPv4: "10.20.0.8", EgressPort: 8092,
		State: ports.NetworkStateActive, NetworkResourceVersion: 1,
		AttachmentState: ports.NetworkAttachmentClosed, AttachmentResourceVersion: 1,
	}
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
			LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, RuntimeState: domain.RuntimeAvailable, AccessRevision: "access-revision-1",
			AgentSpecRevisionID: "agentspec-existing", ExecutionRevisionID: "execution-existing",
			LastSuccessfulExecutionRevisionID: "execution-existing",
			RuntimeRevision:                   "runtime-existing", RuntimeExecutionID: "runtime-execution-existing",
			RuntimeMCPEndpoint: "http://runtime/mcp", CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{AgentID: "agent-existing"},
		Spec:   ports.AgentSpecRecord{ID: "agentspec-existing", AgentID: "agent-existing", Revision: 1, Snapshot: spec.Snapshot()},
		Operation: ports.LifecycleOperationRecord{
			RequestID: "request-create-agent", AgentID: "agent-existing",
			Kind: domain.OperationCreate, Phase: domain.PhaseCompleted,
			State: domain.OperationCompleted, CreatedAt: now, UpdatedAt: now,
		},
	}
}
