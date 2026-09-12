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
	specs        ports.AgentSpecSource
	store        ports.LifecycleStore
	egress       ports.EgressClient
	runtime      ports.RuntimeClient
	identities   ports.OwnerAuthorizationSource
	clock        ports.Clock
	drainTimeout time.Duration
}

type LifecycleOption func(*LifecycleService)

func WithIdentityDirectory(directory ports.OwnerAuthorizationSource) LifecycleOption {
	return func(service *LifecycleService) {
		service.identities = directory
	}
}

const defaultDrainTimeout = 5 * time.Minute

func NewLifecycleService(
	specs ports.AgentSpecSource,
	store ports.LifecycleStore,
	egress ports.EgressClient,
	runtime ports.RuntimeClient,
	clock ports.Clock,
	options ...LifecycleOption,
) *LifecycleService {
	return NewLifecycleServiceWithDrainTimeout(
		specs, store, egress, runtime, clock, defaultDrainTimeout, options...,
	)
}

func NewLifecycleServiceWithDrainTimeout(
	specs ports.AgentSpecSource,
	store ports.LifecycleStore,
	egress ports.EgressClient,
	runtime ports.RuntimeClient,
	clock ports.Clock,
	drainTimeout time.Duration,
	options ...LifecycleOption,
) *LifecycleService {
	if drainTimeout <= 0 {
		drainTimeout = defaultDrainTimeout
	}
	service := &LifecycleService{
		specs: specs, store: store, egress: egress, runtime: runtime,
		clock: clock, drainTimeout: drainTimeout,
	}
	for _, option := range options {
		if option != nil {
			option(service)
		}
	}
	return service
}

type CreateAgentInput struct {
	RequestID        string
	OrganizationID   string
	ActorPrincipalID string
	OwnerUserID      string
	Name             string
	TemplateID       string
	TemplateRevision int64
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
	Configuration                     *AgentConfigurationView
	AggregateSequence                 int64
	CreatedAt                         time.Time
	UpdatedAt                         time.Time
}

type AgentConfigurationView struct {
	TemplateID             string
	TemplateRevision       int64
	TemplateName           string
	ModelProfileID         string
	ModelProfileRevisionID string
	ModelProfileRevision   int64
	ModelProfileName       string
	Model                  domain.ModelSpec
	MaxModelRequests       int
	ContextPolicyVersion   string
	Runtime                domain.RuntimeSpecInput
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
		if state.Agent.OrganizationID != input.OrganizationID {
			return CreateAgentResult{}, fmt.Errorf("%w: Agent create operation", ErrAgentNotFound)
		}
		return createAgentResult(state), nil
	}
	authorization, err := service.authorizeOwner(ctx, input.OrganizationID, input.OwnerUserID)
	if err != nil {
		return service.replayAgentCreateAfterFailure(ctx, input.RequestID, fingerprint, err)
	}

	template, model, spec, err := service.resolveAgentSpec(ctx, input)
	if err != nil {
		return service.replayAgentCreateAfterFailure(ctx, input.RequestID, fingerprint, err)
	}
	digest, err := spec.Digest()
	if err != nil {
		return service.replayAgentCreateAfterFailure(
			ctx, input.RequestID, fingerprint, fmt.Errorf("digest Agent spec: %w", err),
		)
	}
	now := service.clock.Now()
	agentID := derivedID("agent", input.RequestID)
	specID := derivedID("agentspec", input.RequestID)
	accessSubject := derivedID("agentaccess", input.RequestID)
	accessRevision := derivedID("accessrev", input.RequestID)
	operation, err := domain.NewLifecycleOperation(domain.NewLifecycleOperationInput{
		RequestID: input.RequestID, RequestFingerprint: fingerprint,
		AgentID: agentID, Kind: domain.OperationCreate, TargetSpecRevision: specID,
		Now: now,
	})
	if err != nil {
		return service.replayAgentCreateAfterFailure(
			ctx, input.RequestID, fingerprint, fmt.Errorf("%w: %v", ErrInvalidInput, err),
		)
	}
	initial := ports.BeginAgentCreate{
		Agent: ports.AgentRecord{
			AgentID: agentID, OrganizationID: input.OrganizationID, OwnerUserID: input.OwnerUserID,
			Name: strings.TrimSpace(input.Name), DesiredState: domain.DesiredEnabled,
			LifecycleState: domain.AgentProvisioning, AccessRevision: accessRevision,
			ActiveOperationRequestID: input.RequestID, AggregateSequence: 1,
			CreatedAt: now, UpdatedAt: now,
			OwnerAuthorizationSequence: authorization.LastRevocationSequence,
		},
		Access: ports.AgentAccessRecord{
			AccessSubject: accessSubject, AgentID: agentID, PrincipalID: input.OwnerUserID,
			AccessRevision:     accessRevision,
			PromptCapabilities: ports.PromptCapabilities{Image: spec.Snapshot().Model.SupportsImages, EmbeddedContext: true},
			Active:             true, CreatedAt: now, UpdatedAt: now,
		},
		Spec: ports.AgentSpecRecord{
			ID: specID, AgentID: agentID, Revision: 1,
			Snapshot: spec.Snapshot(), CanonicalDigest: digest, CreatedAt: now,
		},
		Operation: ports.LifecycleOperationRecord{
			RequestID: input.RequestID, RequestFingerprint: fingerprint, AgentID: agentID,
			Kind: domain.OperationCreate, Phase: operation.Phase(), State: operation.State(),
			TargetSpecRevisionID: specID, ChildRequestID: operation.ChildRequestID(),
			CreatedAt: now, UpdatedAt: now,
		},
		RequestedEvent: ports.AgentEventRecord{
			EventID: derivedID("event-create-requested", input.RequestID), AgentID: agentID,
			AggregateSequence: 1, SchemaVersion: 1, EventType: ports.EventAgentCreateRequested,
			OperationRequestID: input.RequestID, TraceID: currentTraceID(ctx),
			Data: map[string]any{
				"organization_id": input.OrganizationID, "owner_user_id": input.OwnerUserID,
				"actor_principal_id": input.ActorPrincipalID,
				"template_id":        template.Snapshot().TemplateID,
				"template_revision":  template.Revision(), "agent_spec_revision_id": specID,
			},
			OccurredAt: now,
		},
	}
	state, _, err = service.store.BeginAgentCreate(ctx, initial)
	if err != nil {
		return CreateAgentResult{}, fmt.Errorf("begin Agent create: %w", err)
	}
	_ = model
	return createAgentResult(state), nil
}

func (service *LifecycleService) replayAgentCreateAfterFailure(
	ctx context.Context, requestID string, fingerprint string, cause error,
) (CreateAgentResult, error) {
	state, found, err := service.store.ReplayAgentCreate(ctx, requestID, fingerprint)
	if err != nil {
		return CreateAgentResult{}, fmt.Errorf(
			"%w (replay Agent create after failure: %v)", cause, err,
		)
	}
	if found {
		return createAgentResult(state), nil
	}
	return CreateAgentResult{}, cause
}

func (service *LifecycleService) authorizeOwner(
	ctx context.Context, organizationID, ownerUserID string,
) (ports.IdentityPrincipal, error) {
	if service.identities == nil {
		return ports.IdentityPrincipal{}, fmt.Errorf("%w: agent owner identity directory is not configured", ErrDependencyUnavailable)
	}
	principal, err := service.identities.ResolveOwnerAuthorization(ctx, organizationID, ownerUserID)
	if err != nil {
		if identityReferenceMissing(err) {
			return ports.IdentityPrincipal{}, fmt.Errorf("%w: Agent owner does not belong to the organization", ErrInvalidReference)
		}
		return ports.IdentityPrincipal{}, fmt.Errorf("%w: resolve Agent owner", ErrDependencyUnavailable)
	}
	if principal.UserID != ownerUserID || principal.OrganizationID != organizationID ||
		strings.TrimSpace(principal.MembershipID) == "" || !principal.Active || principal.LastRevocationSequence < 0 {
		return ports.IdentityPrincipal{}, fmt.Errorf("%w: Agent owner is not an active organization member", ErrInvalidReference)
	}
	return principal, nil
}

func identityReferenceMissing(err error) bool {
	var failure *ports.DependencyError
	return errors.As(err, &failure) && !failure.Retryable &&
		(failure.Code == "not_found" || failure.Code == "inactive_principal")
}

func (service *LifecycleService) GetLifecycleOperation(
	ctx context.Context, requestID string,
) (OperationView, error) {
	if !validIdentifier(requestID) {
		return OperationView{}, fmt.Errorf("%w: lifecycle operation request ID", ErrInvalidInput)
	}
	record, err := service.store.GetLifecycleOperation(ctx, requestID)
	if err != nil {
		return OperationView{}, fmt.Errorf("get lifecycle operation: %w", err)
	}
	return lifecycleOperationView(record), nil
}

func (service *LifecycleService) resolveAgentSpec(
	ctx context.Context, input CreateAgentInput,
) (domain.TemplateRevision, domain.ModelProfileRevision, domain.AgentSpec, error) {
	return service.resolveAgentSpecRevision(
		ctx, input.OrganizationID, input.TemplateID, input.TemplateRevision,
	)
}

func (service *LifecycleService) resolveAgentSpecRevision(
	ctx context.Context, organizationID string, templateID string, templateRevision int64,
) (domain.TemplateRevision, domain.ModelProfileRevision, domain.AgentSpec, error) {
	template, err := service.specs.GetTemplateRevision(ctx, templateID, templateRevision)
	if err != nil {
		return domain.TemplateRevision{}, domain.ModelProfileRevision{}, domain.AgentSpec{},
			fmt.Errorf("resolve Template revision: %w", err)
	}
	templateSnapshot := template.Snapshot()
	if templateSnapshot.OrganizationID != organizationID {
		return domain.TemplateRevision{}, domain.ModelProfileRevision{}, domain.AgentSpec{},
			fmt.Errorf("%w: Template belongs to another organization", ErrInvalidReference)
	}
	model, err := service.specs.GetCurrentModelProfileRevision(ctx, template.ModelProfileID())
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

func (service *LifecycleService) stepAgentCreate(
	ctx context.Context, state ports.AgentCreateState,
) (ports.AgentCreateState, error) {
	switch state.Operation.Phase {
	case domain.PhaseNetworkEnsure:
		return service.ensureCreateNetwork(ctx, state)
	case domain.PhaseRuntimeInitialize:
		return service.initializeCreateRuntime(ctx, state)
	case domain.PhasePublish:
		return service.publishAgentCreate(ctx, state)
	default:
		return state, fmt.Errorf("invalid create operation phase %q", state.Operation.Phase)
	}
}

func (service *LifecycleService) ensureCreateNetwork(
	ctx context.Context, state ports.AgentCreateState,
) (ports.AgentCreateState, error) {
	attachment, err := service.egress.EnsureAgentNetwork(ctx, state.Agent.AgentID)
	if err != nil {
		return service.handleCreateDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if !networkAttachmentInState(
		attachment, state.Agent.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed,
	) {
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
		Resources:  runtimeInput.Resources,
		MCPServers: domain.CloneMCPServers(runtimeInput.MCPServers),
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
		if result.Effect == "unknown" {
			return state, fmt.Errorf("%w: runtime-controller", ErrDependencyUnavailable)
		}
		code := strings.TrimSpace(result.ErrorCode)
		if code == "" {
			code = "runtime_initialization_failed"
		}
		return service.failCreate(ctx, state, code, result.ErrorDetail, false)
	case "completed":
		if !completedReadyRuntime(result) {
			return service.failCreate(ctx, state, "invalid_runtime_result", "Runtime initialization did not prove a completed ready effect", false)
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
	if state.Operation.NetworkAttachment == nil {
		return ports.AgentCreateState{}, fmt.Errorf("create operation has no network attachment")
	}
	attachment, err := service.egress.SetAgentNetworkAttachment(
		ctx,
		state.Agent.AgentID,
		ports.NetworkAttachmentOpen,
		state.Operation.NetworkAttachment.AttachmentResourceVersion,
	)
	if err != nil {
		return service.handleCreateDependencyFailure(ctx, state, "runtime-egress", err)
	}
	if !networkAttachmentReady(attachment, state.Agent.AgentID) {
		return service.failCreate(ctx, state, "invalid_network_attachment", "Runtime Egress did not confirm an active attachment", false)
	}
	if !sameNetworkCoordinates(attachment, *state.Operation.NetworkAttachment) ||
		attachment.NetworkResourceVersion != state.Operation.NetworkAttachment.NetworkResourceVersion {
		return service.failCreate(ctx, state, "network_attachment_changed", "Runtime Egress attachment changed after Runtime initialization", false)
	}
	runtime := *state.Operation.RuntimeResult
	now := service.clock.Now()
	executionID := derivedID("execution", state.Operation.RequestID)
	published, err := service.store.PublishAgentCreate(ctx, ports.PublishAgentCreate{
		RequestID: state.Operation.RequestID, Fingerprint: state.Operation.RequestFingerprint,
		NetworkAttachment: attachment,
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

func networkAttachmentReady(attachment ports.NetworkAttachment, agentID string) bool {
	return networkAttachmentInState(
		attachment, agentID, ports.NetworkStateActive, ports.NetworkAttachmentOpen,
	)
}

func networkAttachmentInState(
	attachment ports.NetworkAttachment,
	agentID string,
	networkState string,
	attachmentState string,
) bool {
	return attachment.AgentID == agentID && attachment.TunnelIPv4 != "" &&
		attachment.ResolverIPv4 != "" && attachment.EgressIPv4 != "" && attachment.EgressPort != 0 &&
		attachment.PacketContractRevision != 0 && attachment.State == networkState &&
		attachment.NetworkResourceVersion != 0 && attachment.AttachmentState == attachmentState &&
		attachment.AttachmentResourceVersion != 0
}

func (service *LifecycleService) setCurrentNetworkAttachmentState(
	ctx context.Context,
	operation ports.LifecycleOperationRecord,
	state string,
) (ports.NetworkAttachment, error) {
	attachment, err := service.egress.GetAgentNetwork(ctx, operation.AgentID)
	if err != nil {
		return ports.NetworkAttachment{}, err
	}
	return service.setOperationNetworkAttachment(ctx, operation, state, attachment)
}

// Validate after reading the resource version. A later phase changes that version,
// so an expired Activity cannot borrow a newer attachment and mutate it.
func (service *LifecycleService) setOperationNetworkAttachment(
	ctx context.Context, operation ports.LifecycleOperationRecord, desired string, attachment ports.NetworkAttachment,
) (ports.NetworkAttachment, error) {
	current, err := service.store.GetLifecycleOperation(ctx, operation.RequestID)
	if err != nil {
		return ports.NetworkAttachment{}, err
	}
	if current.State != domain.OperationRunning || current.Phase != operation.Phase || current.AgentID != operation.AgentID || current.RequestFingerprint != operation.RequestFingerprint {
		return ports.NetworkAttachment{}, ports.ErrConcurrentChange
	}
	return service.setKnownNetworkAttachmentState(ctx, operation.AgentID, desired, attachment)
}

func (service *LifecycleService) setKnownNetworkAttachmentState(
	ctx context.Context, agentID, state string, attachment ports.NetworkAttachment,
) (ports.NetworkAttachment, error) {
	if attachment.AttachmentState == state &&
		networkAttachmentInState(attachment, agentID, ports.NetworkStateActive, state) {
		return attachment, nil
	}
	if attachment.State != ports.NetworkStateActive ||
		attachment.AttachmentResourceVersion == 0 {
		return ports.NetworkAttachment{}, &ports.DependencyError{
			Service: "runtime-egress", Code: "invalid_network_attachment", Retryable: false,
		}
	}
	return service.egress.SetAgentNetworkAttachment(
		ctx, agentID, state, attachment.AttachmentResourceVersion,
	)
}

func completedReadyRuntime(result ports.RuntimeOperation) bool {
	return result.State == "completed" && result.Effect == "completed" &&
		result.LifecycleState == "ready" && result.Health == "healthy" &&
		result.RuntimeRevision != "" && result.RuntimeExecutionID != "" && result.MCPEndpoint != ""
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
		(input.ActorPrincipalID != "" && !validIdentifier(input.ActorPrincipalID)) ||
		!validIdentifier(input.OwnerUserID) || !validIdentifier(input.TemplateID) ||
		input.TemplateRevision < 1 || strings.TrimSpace(input.Name) == "" || len(strings.TrimSpace(input.Name)) > 200 {
		return fmt.Errorf("%w: Agent create input", ErrInvalidInput)
	}
	return nil
}

func validLifecycleCaller(organizationID string, actorPrincipalID string) bool {
	if organizationID == "" && actorPrincipalID == "" {
		return true
	}
	return validIdentifier(organizationID) && validIdentifier(actorPrincipalID)
}

func lifecycleScopeMatches(actualOrganizationID string, requestedOrganizationID string) bool {
	return requestedOrganizationID == "" || actualOrganizationID == requestedOrganizationID
}

func createAgentFingerprint(input CreateAgentInput) (string, error) {
	return requestFingerprint(struct {
		RequestID        string
		OrganizationID   string
		ActorPrincipalID string
		OwnerUserID      string
		Name             string
		TemplateID       string
		TemplateRevision int64
	}{
		RequestID: input.RequestID, OrganizationID: input.OrganizationID,
		ActorPrincipalID: input.ActorPrincipalID,
		OwnerUserID:      input.OwnerUserID, Name: strings.TrimSpace(input.Name),
		TemplateID: input.TemplateID, TemplateRevision: input.TemplateRevision,
	})
}

func createAgentResult(state ports.AgentCreateState) CreateAgentResult {
	operation := state.Operation
	return CreateAgentResult{
		Agent:              agentView(state.Agent),
		AgentAccessSubject: state.Access.AccessSubject,
		Operation:          lifecycleOperationView(operation),
	}
}

func agentView(agent ports.AgentRecord) AgentView {
	return AgentView{
		AgentID: agent.AgentID, OrganizationID: agent.OrganizationID,
		OwnerUserID: agent.OwnerUserID, Name: agent.Name,
		DesiredState: agent.DesiredState, LifecycleState: agent.LifecycleState,
		AccessRevision:                    agent.AccessRevision,
		AgentSpecRevisionID:               agent.AgentSpecRevisionID,
		ExecutionRevisionID:               agent.ExecutionRevisionID,
		LastSuccessfulExecutionRevisionID: agent.LastSuccessfulExecutionRevisionID,
		RuntimeRevision:                   agent.RuntimeRevision,
		RuntimeExecutionID:                agent.RuntimeExecutionID,
		RuntimeMCPEndpoint:                agent.RuntimeMCPEndpoint,
		ActiveOperationRequestID:          agent.ActiveOperationRequestID,
		FailureStage:                      agent.FailureStage,
		FailureCode:                       agent.FailureCode,
		AggregateSequence:                 agent.AggregateSequence,
		CreatedAt:                         agent.CreatedAt,
		UpdatedAt:                         agent.UpdatedAt,
	}
}

func lifecycleOperationView(operation ports.LifecycleOperationRecord) OperationView {
	return OperationView{
		RequestID: operation.RequestID, AgentID: operation.AgentID,
		Kind: operation.Kind, Phase: operation.Phase, State: operation.State,
		ErrorCode: operation.ErrorCode, ErrorDetail: operation.ErrorDetail,
		CreatedAt: operation.CreatedAt, UpdatedAt: operation.UpdatedAt,
	}
}

func currentTraceID(ctx context.Context) string {
	spanContext := trace.SpanContextFromContext(ctx)
	if !spanContext.IsValid() {
		return ""
	}
	return spanContext.TraceID().String()
}

func lifecycleRunReleaseEvent(
	ctx context.Context,
	requestID string,
	reason string,
	sourceRuntimeRevision string,
	now time.Time,
) ports.RunAdmissionEvent {
	return ports.RunAdmissionEvent{
		EventID:   derivedID("event-run-release", requestID),
		EventType: ports.EventRunAdmissionReleased, TraceID: currentTraceID(ctx),
		Data: map[string]any{
			"release_reason":          reason,
			"source_runtime_revision": sourceRuntimeRevision,
		},
		OccurredAt: now,
	}
}

func deletedRuntimeAbsenceProof(
	expectedAgentID string,
	expectedRuntimeRevision string,
	inspection ports.RuntimeInspection,
	now time.Time,
) (*ports.RuntimeAbsenceProof, bool) {
	if inspection.RuntimeRevision != expectedRuntimeRevision ||
		!runtimeInspectionProvesDeleted(expectedAgentID, inspection) {
		return nil, false
	}
	return &ports.RuntimeAbsenceProof{
		Reason: "runtime_deleted", RuntimeRevision: inspection.RuntimeRevision, ObservedAt: now,
	}, true
}

func exactReadyRuntime(
	expectedAgentID string,
	expectedRevision string,
	expectedExecutionID string,
	expectedMCPEndpoint string,
	inspection ports.RuntimeInspection,
) bool {
	return inspection.AgentID == expectedAgentID &&
		inspection.RuntimeRevision == expectedRevision &&
		inspection.RuntimeExecutionID == expectedExecutionID &&
		inspection.MCPEndpoint == expectedMCPEndpoint &&
		inspection.LifecycleState == "ready" && inspection.Health == "healthy"
}

func digestString(value string) string {
	digest := sha256.Sum256([]byte(value))
	return hex.EncodeToString(digest[:])
}
