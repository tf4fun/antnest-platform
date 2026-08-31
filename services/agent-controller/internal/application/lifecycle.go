package application

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrDependencyUnavailable = errors.New("dependency unavailable")

type LifecycleService struct {
	specs   ports.AgentSpecSource
	store   ports.LifecycleStore
	egress  ports.EgressClient
	runtime ports.RuntimeClient
	clock   ports.Clock
}

func NewLifecycleService(
	specs ports.AgentSpecSource,
	store ports.LifecycleStore,
	egress ports.EgressClient,
	runtime ports.RuntimeClient,
	clock ports.Clock,
) *LifecycleService {
	return &LifecycleService{specs: specs, store: store, egress: egress, runtime: runtime, clock: clock}
}

type CreateAgentInput struct {
	RequestID          string
	OrganizationID     string
	OwnerUserID        string
	Name               string
	TemplateID         string
	TemplateRevision   int64
	InitialTraceParent string
}

type AgentView struct {
	AgentID                           string
	OrganizationID                    string
	OwnerUserID                       string
	Name                              string
	DesiredState                      domain.DesiredState
	LifecycleState                    domain.AgentState
	AccessRevision                    string
	AgentSpecRevisionID               string
	ExecutionRevisionID               string
	LastSuccessfulExecutionRevisionID string
	RuntimeRevision                   string
	RuntimeExecutionID                string
	RuntimeMCPEndpoint                string
	ActiveOperationRequestID          string
	FailureStage                      string
	FailureCode                       string
	CreatedAt                         time.Time
	UpdatedAt                         time.Time
}

type OperationView struct {
	RequestID   string
	AgentID     string
	Kind        domain.OperationKind
	Phase       domain.OperationPhase
	State       domain.OperationState
	ErrorCode   string
	ErrorDetail string
	CreatedAt   time.Time
	UpdatedAt   time.Time
}

type CreateAgentResult struct {
	Agent              AgentView
	AgentAccessSubject string
	Operation          OperationView
}

func (service *LifecycleService) CreateAgent(
	ctx context.Context, input CreateAgentInput,
) (CreateAgentResult, error) {
	if err := validateCreateAgentInput(input); err != nil {
		return CreateAgentResult{}, err
	}
	fingerprint, err := createAgentFingerprint(input)
	if err != nil {
		return CreateAgentResult{}, err
	}
	state, found, err := service.store.ReplayAgentCreate(ctx, input.RequestID, fingerprint)
	if err != nil {
		return CreateAgentResult{}, fmt.Errorf("replay Agent create: %w", err)
	}
	if found {
		return service.continueAgentCreate(ctx, state)
	}

	template, model, spec, err := service.resolveAgentSpec(ctx, input)
	if err != nil {
		return CreateAgentResult{}, err
	}
	digest, err := spec.Digest()
	if err != nil {
		return CreateAgentResult{}, fmt.Errorf("digest Agent spec: %w", err)
	}
	now := service.clock.Now()
	agentID := derivedID("agent", input.RequestID)
	specID := derivedID("agentspec", input.RequestID)
	accessSubject := derivedID("agentaccess", input.RequestID)
	accessRevision := derivedID("accessrev", input.RequestID)
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: agentID, Kind: domain.OperationCreate, TargetSpecRevision: specID,
		InitialTraceParent: input.InitialTraceParent, Now: now,
	})
	if err != nil {
		return CreateAgentResult{}, fmt.Errorf("%w: %v", ErrInvalidInput, err)
	}
	initial := ports.BeginAgentCreate{
		Agent: ports.AgentRecord{
			AgentID: agentID, OrganizationID: input.OrganizationID, OwnerUserID: input.OwnerUserID,
			Name: strings.TrimSpace(input.Name), DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentProvisioning, AccessRevision: accessRevision,
			ActiveOperationRequestID: input.RequestID, AggregateSequence: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		Access: ports.AgentAccessRecord{
			AccessSubject: accessSubject, AgentID: agentID, PrincipalID: input.OwnerUserID,
			AccessRevision: accessRevision, Active: true, CreatedAt: now, UpdatedAt: now,
		},
		Spec: ports.AgentSpecRecord{
			ID: specID, AgentID: agentID, Revision: 1,
			Snapshot: spec.Snapshot(), CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint, AgentID: agentID,
			Kind: domain.OperationCreate, Phase: operation.Phase(), State: operation.State(),
			TargetSpecRevisionID: specID, ChildRequestID: operation.ChildRequestID(),
			InitialTraceParent: input.InitialTraceParent, Attempt: 1,
			CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-create-requested", input.RequestID), AgentID: agentID,
			AggregateSequence: 1, SchemaVersion: 1, EventType: ports.EventAgentCreateRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"organization_id": input.OrganizationID, "owner_user_id": input.OwnerUserID,
				"template_id":       template.Snapshot().TemplateID,
				"template_revision": template.Revision(), "agent_spec_revision_id": specID,
			},
			OccurredAt: now,
		},
	}
	state, _, err = service.store.BeginAgentCreate(ctx, initial)
	if err != nil {
		return CreateAgentResult{}, fmt.Errorf("begin Agent create: %w", err)
	}
	_ = model
	return service.continueAgentCreate(ctx, state)
}

func (service *LifecycleService) resolveAgentSpec(
	ctx context.Context, input CreateAgentInput,
) (domain.TemplateRevision, domain.ModelProfileRevision, domain.AgentSpec, error) {
	template, err := service.specs.GetTemplateRevision(ctx, input.TemplateID, input.TemplateRevision)
	if err != nil {
		return domain.TemplateRevision{}, domain.ModelProfileRevision{}, domain.AgentSpec{},
			fmt.Errorf("resolve Template revision: %w", err)
	}
	templateSnapshot := template.Snapshot()
	if templateSnapshot.OrganizationID != input.OrganizationID {
		return domain.TemplateRevision{}, domain.ModelProfileRevision{}, domain.AgentSpec{},
			fmt.Errorf("%w: Template belongs to another organization", ErrInvalidReference)
	}
	model, err := service.specs.GetModelProfileRevision(ctx, template.ModelProfileRevisionID())
	if err != nil {
		return domain.TemplateRevision{}, domain.ModelProfileRevision{}, domain.AgentSpec{},
			fmt.Errorf("resolve ModelProfile revision: %w", err)
	}
	spec, err := domain.MaterializeAgentSpec(template, model)
	if err != nil {
		return domain.TemplateRevision{}, domain.ModelProfileRevision{}, domain.AgentSpec{},
			fmt.Errorf("%w: %v", ErrInvalidReference, err)
	}
	return template, model, spec, nil
}

func (service *LifecycleService) continueAgentCreate(
	ctx context.Context, state ports.AgentCreateState,
) (CreateAgentResult, error) {
	if state.Operation.State != domain.OperationRunning {
		return createAgentResult(state), nil
	}
	var err error
	if state.Operation.Phase == domain.PhaseNetworkEnsure {
		state, err = service.ensureCreateNetwork(ctx, state)
		if err != nil || state.Operation.State != domain.OperationRunning {
			return createAgentResult(state), err
		}
	}
	if state.Operation.Phase == domain.PhaseRuntimeInitialize {
		state, err = service.initializeCreateRuntime(ctx, state)
		if err != nil || state.Operation.State != domain.OperationRunning ||
			state.Operation.Phase == domain.PhaseRuntimeInitialize {
			return createAgentResult(state), err
		}
	}
	if state.Operation.Phase != domain.PhasePublish {
		return CreateAgentResult{}, fmt.Errorf("invalid create operation phase %q", state.Operation.Phase)
	}
	state, err = service.publishAgentCreate(ctx, state)
	if err != nil {
		return CreateAgentResult{}, err
	}
	return createAgentResult(state), nil
}

func (service *LifecycleService) ensureCreateNetwork(
	ctx context.Context, state ports.AgentCreateState,
) (ports.AgentCreateState, error) {
	attachment, err := service.egress.EnsureAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil {
		return service.handleCreateDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if attachment.AgentID != state.Agent.AgentID || attachment.TunnelIPv4 == "" ||
		attachment.ResolverIPv4 == "" || attachment.EgressIPv4 == "" || attachment.EgressPort == 0 ||
		attachment.PacketContractRevision == 0 || attachment.State != "active" {
		return service.failCreate(ctx, state, "invalid_network_attachment", "Runtime Egress returned an incomplete attachment", false)
	}
	now := service.clock.Now()
	updated, err := service.store.RecordCreateNetwork(
		ctx, state.Operation.RequestID, state.Operation.RequestFingerprint, attachment,
		domain.ChildRequestID(state.Operation.RequestID, domain.PhaseRuntimeInitialize), now,
	)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("record Agent network attachment: %w", err)
	}
	return updated, nil
}

func (service *LifecycleService) initializeCreateRuntime(
	ctx context.Context, state ports.AgentCreateState,
) (ports.AgentCreateState, error) {
	if state.Operation.NetworkAttachment == nil {
		return ports.AgentCreateState{}, fmt.Errorf("create operation has no network attachment")
	}
	runtimeInput := state.Spec.Snapshot.Runtime
	configuration := ports.RuntimeConfiguration{
		ImageRef: runtimeInput.ImageRef, Network: *state.Operation.NetworkAttachment,
		Resources: runtimeInput.Resources,
	}
	result, err := service.runtime.InitializeRuntime(
		ctx, state.Operation.ChildRequestID, state.Agent.AgentID, configuration,
	)
	if err != nil {
		return service.handleCreateDependencyFailure(ctx, state, "runtime-controller", err)
	}
	switch result.State {
	case "running", "unknown":
		return state, nil
	case "failed":
		code := strings.TrimSpace(result.ErrorCode)
		if code == "" {
			code = "runtime_initialization_failed"
		}
		return service.failCreate(ctx, state, code, result.ErrorDetail, result.Effect == "unknown")
	case "completed":
		if result.LifecycleState != "ready" || result.Health != "healthy" ||
			result.RuntimeRevision == "" || result.RuntimeExecutionID == "" || result.MCPEndpoint == "" {
			return service.failCreate(ctx, state, "runtime_not_ready", "Runtime initialization did not prove readiness", false)
		}
	default:
		return service.failCreate(ctx, state, "invalid_runtime_result", "Runtime Controller returned an unknown state", false)
	}
	now := service.clock.Now()
	updated, err := service.store.RecordCreateRuntime(
		ctx, state.Operation.RequestID, state.Operation.RequestFingerprint, result,
		domain.ChildRequestID(state.Operation.RequestID, domain.PhasePublish), now,
	)
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("record Runtime initialization: %w", err)
	}
	return updated, nil
}

func (service *LifecycleService) publishAgentCreate(
	ctx context.Context, state ports.AgentCreateState,
) (ports.AgentCreateState, error) {
	if state.Operation.RuntimeResult == nil {
		return ports.AgentCreateState{}, fmt.Errorf("create operation has no Runtime result")
	}
	runtime := *state.Operation.RuntimeResult
	now := service.clock.Now()
	executionID := derivedID("execution", state.Operation.RequestID)
	published, err := service.store.PublishAgentCreate(ctx, ports.PublishAgentCreate{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		Execution: ports.ExecutionRecord{
			ID: executionID, AgentID: state.Agent.AgentID, Revision: 1,
			AgentSpecRevisionID: state.Spec.ID, RuntimeRevision: runtime.RuntimeRevision,
			RuntimeExecutionID: runtime.RuntimeExecutionID, RuntimeMCPEndpoint: runtime.MCPEndpoint,
			RuntimeMCPSourceDigest: digestString(runtime.MCPEndpoint),
			ChangeSummary:          map[string]any{"kind": "create"}, PublishedAt: now,
		},
		ReadyEvent: ports.AgentEventRecord{
			EventID: derivedID("event-ready", state.Operation.RequestID), AgentID: state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1, SchemaVersion: 1,
			EventType: ports.EventAgentReady, OperationRequestID: state.Operation.RequestID,
			TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"agent_spec_revision_id": state.Spec.ID, "execution_revision_id": executionID,
				"runtime_revision": runtime.RuntimeRevision,
			},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("publish Agent create: %w", err)
	}
	return published, nil
}

func (service *LifecycleService) handleCreateDependencyFailure(
	ctx context.Context, state ports.AgentCreateState, serviceName string, err error,
) (ports.AgentCreateState, error) {
	var dependencyFailure *ports.DependencyError
	if !errors.As(err, &dependencyFailure) || dependencyFailure.Retryable {
		return state, fmt.Errorf("%w: %s", ErrDependencyUnavailable, serviceName)
	}
	return service.failCreate(ctx, state, dependencyFailure.Code, dependencyFailure.Error(), false)
}

func (service *LifecycleService) failCreate(
	ctx context.Context,
	state ports.AgentCreateState,
	code string,
	detail string,
	retryable bool,
) (ports.AgentCreateState, error) {
	now := service.clock.Now()
	failed, err := service.store.FailAgentCreate(ctx, ports.FailAgentCreate{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		Stage: state.Operation.Phase, Code: code, Detail: detail, Retryable: retryable,
		FailedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-build-failed", state.Operation.RequestID), AgentID: state.Agent.AgentID,
			AggregateSequence: state.Agent.AggregateSequence + 1, SchemaVersion: 1,
			EventType: ports.EventAgentBuildFailed, OperationRequestID: state.Operation.RequestID,
			TraceID:    currentTraceID(ctx),
			Data:       map[string]any{"failure_stage": state.Operation.Phase, "failure_code": code},
			OccurredAt: now,
		},
		Now: now,
	})
	if err != nil {
		return ports.AgentCreateState{}, fmt.Errorf("record Agent create failure: %w", err)
	}
	return failed, nil
}

func validateCreateAgentInput(input CreateAgentInput) error {
	if !validIdentifier(input.RequestID) || !validIdentifier(input.OrganizationID) ||
		!validIdentifier(input.OwnerUserID) || !validIdentifier(input.TemplateID) ||
		input.TemplateRevision < 1 || strings.TrimSpace(input.Name) == "" || len(strings.TrimSpace(input.Name)) > 200 {
		return fmt.Errorf("%w: Agent create input", ErrInvalidInput)
	}
	return nil
}

func createAgentFingerprint(input CreateAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID        string
		OrganizationID   string
		OwnerUserID      string
		Name             string
		TemplateID       string
		TemplateRevision int64
	}{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		OwnerUserID: input.OwnerUserID, Name: strings.TrimSpace(input.Name),
		TemplateID: input.TemplateID, TemplateRevision: input.TemplateRevision,
	})
}

func createAgentResult(state ports.AgentCreateState) CreateAgentResult {
	agent := state.Agent
	operation := state.Operation
	return CreateAgentResult{
		Agent: AgentView{
			AgentID: agent.AgentID, OrganizationID: agent.OrganizationID,
			OwnerUserID: agent.OwnerUserID, Name: agent.Name,
			DesiredState: agent.DesiredState, LifecycleState: agent.LifecycleState,
			AccessRevision:                    agent.AccessRevision,
			AgentSpecRevisionID:               agent.AgentSpecRevisionID,
			ExecutionRevisionID:               agent.ExecutionRevisionID,
			LastSuccessfulExecutionRevisionID: agent.LastSuccessfulExecutionRevisionID,
			RuntimeRevision:                   agent.RuntimeRevision, RuntimeExecutionID: agent.RuntimeExecutionID,
			RuntimeMCPEndpoint:       agent.RuntimeMCPEndpoint,
			ActiveOperationRequestID: agent.ActiveOperationRequestID,
			FailureStage:             agent.FailureStage, FailureCode: agent.FailureCode,
			CreatedAt: agent.CreatedAt, UpdatedAt: agent.UpdatedAt,
		},
		AgentAccessSubject: state.Access.AccessSubject,
		Operation: OperationView{
			RequestID: operation.RequestID, AgentID: operation.AgentID,
			Kind: operation.Kind, Phase: operation.Phase, State: operation.State,
			ErrorCode: operation.ErrorCode, ErrorDetail: operation.ErrorDetail,
			CreatedAt: operation.CreatedAt, UpdatedAt: operation.UpdatedAt,
		},
	}
}

func currentTraceID(ctx context.Context) string {
	spanContext := trace.SpanContextFromContext(ctx)
	if !spanContext.IsValid() {
		return ""
	}
	return spanContext.TraceID().String()
}

func digestString(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
