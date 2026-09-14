package postgres

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestIdentityOffboardingComponentDisablesRuntimeAndRequiresExplicitEnable(t *testing.T) {
	ctx := context.Background()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() { otel.SetTracerProvider(previous); _ = provider.Shutdown(context.Background()) })
	repository, base := identityTestRepository(t)
	staleDefault := agentAuthorizationCommand(base.Agent)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	deps := &offboardingDependencies{runtime: ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: base.Agent.RuntimeRevision,
		RuntimeExecutionID: "", MCPEndpoint: "", LifecycleState: "provisioned", Health: "unknown"},
		network: *closedNetworkAttachment(base.Agent.AgentID)}
	deps.network.AttachmentState = ports.NetworkAttachmentOpen
	identity := &offboardingIdentity{principal: ports.IdentityPrincipal{UserID: base.Agent.OwnerUserID, OrganizationID: base.Agent.OrganizationID, MembershipID: "membership", Active: false, LastRevocationSequence: 5},
		event: ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID, Reason: "user_deactivated", OccurredAt: time.Now().UTC(), TraceParent: "00-11111111111111111111111111111111-2222222222222222-01"}}
	lifecycle := application.NewLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithIdentityDirectory(identity), application.WithLifecycleExecution(testLifecycleExecution(repository)))
	worker, err := application.NewIdentityRevocationWorker(identity, repository, lifecycle, time.Second, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	if deps.disableCalls != 0 {
		t.Fatal("receipt synchronously executed Runtime effects")
	}
	fenced, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || !fenced.IdentityRevoked() || fenced.ActiveOperationRequestID == "" {
		t.Fatalf("fence=%+v err=%v", fenced, err)
	}
	queries := application.NewAgentQueryService(repository)
	workspaceInput := application.ListWorkspaceAgentsInput{RequestID: "offboarding-list", OrganizationID: base.Agent.OrganizationID, PrincipalID: base.Agent.OwnerUserID}
	workspace, err := queries.ListWorkspaceAgents(ctx, workspaceInput)
	require.NoError(t, err)
	require.Empty(t, workspace.Items, "revoked owner cannot discover Agent metadata")
	operation, err := repository.GetLifecycleOperation(ctx, fenced.ActiveOperationRequestID)
	if err != nil || operation.OwnerRevocationSequence != 5 {
		t.Fatalf("operation=%+v err=%v", operation, err)
	}
	for range 2 {
		if err := worker.RunOnce(ctx); err != nil {
			t.Fatal(err)
		}
	}
	latest, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || latest.ActiveOperationRequestID != operation.RequestID {
		t.Fatal("duplicate receipt replaced operation")
	}
	recovery := lifecycle
	finishOffboardingOperation(t, repository, recovery, operation.RequestID, domain.OperationCompleted)
	disabled, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || (disabled.LifecycleState != domain.AgentCreated || disabled.ActivationState != domain.ActivationDisabled || disabled.RuntimeState != domain.RuntimeAbsent) || deps.disableCalls != 1 || deps.network.AttachmentState != ports.NetworkAttachmentClosed {
		t.Fatalf("disabled=%+v calls=%d err=%v", disabled, deps.disableCalls, err)
	}
	if disabled.LastSuccessfulExecutionRevisionID != base.Agent.ExecutionRevisionID {
		t.Fatal("offboarding lost retained execution")
	}
	assertOffboardingEventStream(t, repository, disabled)
	if _, err := lifecycle.EnableAgent(ctx, application.EnableAgentInput{RequestID: "enable-inactive", AgentID: base.Agent.AgentID}); !errors.Is(err, application.ErrInvalidReference) {
		t.Fatalf("inactive owner enabled Agent: %v", err)
	}
	identity.principal.Active = true
	configuration := application.NewAgentConfigurationService(repository, identity, offboardingClock{})
	_, defaultErr := configuration.SetAgentAuthorization(ctx, application.SetAgentAuthorizationInput{
		RequestID: "before-explicit-enable", AgentID: base.Agent.AgentID, PrincipalID: base.Agent.OwnerUserID,
		ExpectedAccessRevision: base.Agent.AccessRevision, ExpectedAuthorizationRevision: 1,
		Authorization: staleDefault.Authorization})
	require.ErrorIs(t, defaultErr, application.ErrAccessDenied)
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	afterRestore, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || (afterRestore.LifecycleState != domain.AgentCreated || afterRestore.ActivationState != domain.ActivationDisabled || afterRestore.RuntimeState != domain.RuntimeAbsent) {
		t.Fatal("Identity restore auto-enabled Agent")
	}
	workspace, err = queries.ListWorkspaceAgents(ctx, workspaceInput)
	require.NoError(t, err)
	require.Empty(t, workspace.Items, "Identity restoration alone does not restore Agent access")
	if _, err := lifecycle.EnableAgent(ctx, application.EnableAgentInput{RequestID: "enable-restored", AgentID: base.Agent.AgentID}); err != nil {
		t.Fatal(err)
	}
	finishOffboardingOperation(t, repository, recovery, "enable-restored", domain.OperationCompleted)
	enabled, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil || enabled.IdentityRevoked() || enabled.OwnerAuthorizationSequence != 5 || (enabled.LifecycleState != domain.AgentCreated || enabled.ActivationState != domain.ActivationEnabled || enabled.RuntimeState != domain.RuntimeUnknown) {
		t.Fatalf("explicit enable=%+v err=%v", enabled, err)
	}
	require.Equal(t, enabled.OwnerAuthorizationSequence, enabled.IdentityRevocationSequence)
	workspace, err = queries.ListWorkspaceAgents(ctx, workspaceInput)
	require.NoError(t, err)
	require.Len(t, workspace.Items, 1, "explicit Enable restores discovery even before Runtime readiness")
	require.Equal(t, enabled.AgentID, workspace.Items[0].AgentID)
	projection := publishedAgent(t, repository, enabled)
	require.Equal(t, []string{enabled.OwnerUserID}, projection.PrincipalIDs)
	assertExecutionClosed(t, repository, enabled)
	require.Equal(t, staleDefault.Query.ExpectedAccessRevision, enabled.AccessRevision)
	_, err = repository.SetAgentAuthorization(ctx, staleDefault)
	require.ErrorIs(t, err, ports.ErrAgentAccessDenied, "old identity proof must not survive revoke and explicit Enable")
	staleDefault.OwnerRevocationSequence = identity.principal.LastRevocationSequence
	_, err = repository.SetAgentAuthorization(ctx, staleDefault)
	require.NoError(t, err, "fresh proof may update the default after explicit Enable")
	found := false
	for _, span := range recorder.Ended() {
		if span.Name() == "agent_controller.identity_offboarding.receive" && span.SpanContext().TraceID().String() == "11111111111111111111111111111111" {
			found = true
		}
	}
	if !found {
		t.Fatal("missing causal consumer trace")
	}
}

func assertOffboardingEventStream(t *testing.T, repo *Repository, agent ports.AgentRecord) {
	t.Helper()
	ctx := context.Background()
	notifier, err := OpenEventNotifier(ctx, os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL"))
	if err != nil {
		t.Fatal(err)
	}
	defer notifier.Close()
	events := application.NewEventService(repo, notifier, repo)
	page, err := events.ListGlobalEvents(ctx, application.ListEventsInput{OrganizationID: agent.OrganizationID})
	if err != nil {
		t.Fatal(err)
	}
	for _, single := range []bool{false, true} {
		seen := []string{}
		stop := errors.New("stream complete")
		emit := func(event application.AgentEventView) error {
			seen = append(seen, event.EventType)
			if event.GlobalSequence == page.NextSequence {
				return stop
			}
			return nil
		}
		watchCtx, cancel := context.WithTimeout(ctx, time.Second)
		if single {
			err = events.WatchAgentEvents(watchCtx, agent.OrganizationID, agent.AgentID, 0, emit)
		} else {
			err = events.WatchGlobalEvents(watchCtx, agent.OrganizationID, 0, emit)
		}
		cancel()
		if !errors.Is(err, stop) || !slices.Contains(seen, ports.EventAgentOwnerRevoked) || !slices.Contains(seen, ports.EventAgentDisabled) {
			t.Fatalf("events=%v err=%v", seen, err)
		}
	}
}

type offboardingClock struct{}

func (offboardingClock) Now() time.Time { return time.Now().UTC() }

type offboardingIdentity struct {
	principal ports.IdentityPrincipal
	event     ports.PrincipalRevocation
}

func (identity *offboardingIdentity) ResolvePrincipal(context.Context, string, string) (ports.IdentityPrincipal, error) {
	return identity.principal, nil
}
func (identity *offboardingIdentity) ResolveOwnerAuthorization(context.Context, string, string) (ports.IdentityPrincipal, error) {
	return identity.principal, nil
}
func (identity *offboardingIdentity) ListPrincipalRevocations(_ context.Context, after int64, _ int) (ports.PrincipalRevocationPage, error) {
	if after >= identity.event.Sequence {
		return ports.PrincipalRevocationPage{NextSequence: after}, nil
	}
	return ports.PrincipalRevocationPage{Events: []ports.PrincipalRevocation{identity.event}, NextSequence: identity.event.Sequence}, nil
}

type offboardingDependencies struct {
	runtime       ports.RuntimeOperation
	network       ports.NetworkAttachment
	disableCalls  int
	rejectDisable bool
}

func (deps *offboardingDependencies) GetAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return deps.network, nil
}
func (deps *offboardingDependencies) EnsureAgentNetwork(context.Context, string) (ports.NetworkAttachment, error) {
	return deps.network, nil
}
func (deps *offboardingDependencies) SetAgentNetworkAttachment(_ context.Context, _ string, state string, _ uint64) (ports.NetworkAttachment, error) {
	deps.network.AttachmentState = state
	deps.network.AttachmentResourceVersion++
	return deps.network, nil
}
func (*offboardingDependencies) ReleaseAgentNetwork(context.Context, string, uint64) (ports.NetworkAttachment, error) {
	return ports.NetworkAttachment{}, errors.New("unexpected release")
}
func (*offboardingDependencies) InitializeRuntime(context.Context, string, string, ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected initialize")
}
func (*offboardingDependencies) UpdateRuntime(context.Context, string, string, string, ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected update")
}
func (*offboardingDependencies) DeleteRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error) {
	return ports.RuntimeOperation{}, errors.New("unexpected delete")
}
func (deps *offboardingDependencies) DisableRuntime(context.Context, string, string, string) (ports.RuntimeOperation, error) {
	deps.disableCalls++
	if deps.rejectDisable {
		return ports.RuntimeOperation{State: "failed", Effect: "not_started", ErrorCode: "platform_unavailable"}, nil
	}
	deps.runtime = ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_22222222222222222222222222222222", LifecycleState: "disabled", Health: "absent"}
	return deps.runtime, nil
}

func TestIdentityOffboardingRetriesFailedDisableWithoutRestoringAccess(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := context.Background()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	deps := &offboardingDependencies{rejectDisable: true, network: *closedNetworkAttachment(base.Agent.AgentID),
		runtime: ports.RuntimeOperation{RuntimeRevision: base.Agent.RuntimeRevision, RuntimeExecutionID: base.Agent.RuntimeExecutionID,
			MCPEndpoint: base.Agent.RuntimeMCPEndpoint, LifecycleState: "provisioned", Health: "healthy"}}
	identity := &offboardingIdentity{event: ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID, Reason: "user_deactivated", OccurredAt: time.Now().UTC()}}
	lifecycle := application.NewLifecycleService(repository, repository, deps, deps, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
	worker, err := application.NewIdentityRevocationWorker(identity, repository, lifecycle, time.Second, logger)
	if err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	agent, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	if err != nil {
		t.Fatal(err)
	}
	firstRequest := agent.ActiveOperationRequestID
	recovery := lifecycle
	finishOffboardingOperation(t, repository, recovery, firstRequest, domain.OperationFailed)
	failed, err := loadAgentRecord(ctx, repository.pool, agent.AgentID)
	if err != nil || failed.DesiredState != domain.DesiredDisabled || !failed.IdentityRevoked() || failed.ExecutionRevisionID != base.Agent.ExecutionRevisionID || deps.network.AttachmentState != ports.NetworkAttachmentClosed {
		t.Fatalf("failure restored access or lost source: %+v %v", failed, err)
	}
	pending, err := repository.ListPendingOwnerRevocations(ctx, "", 100)
	if err != nil || len(pending) != 0 {
		t.Fatalf("retry ignored cooldown: %+v %v", pending, err)
	}
	if _, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agent_lifecycle_operations SET updated_at=clock_timestamp()-interval '31 seconds' WHERE request_id=$1`, firstRequest); err != nil {
		t.Fatal(err)
	}
	if err := worker.RunOnce(ctx); err != nil {
		t.Fatal(err)
	}
	second, err := loadAgentRecord(ctx, repository.pool, agent.AgentID)
	if err != nil || second.ActiveOperationRequestID == "" || second.ActiveOperationRequestID == firstRequest {
		t.Fatalf("retry did not create new attempt: %+v %v", second, err)
	}
	deps.rejectDisable = false
	finishOffboardingOperation(t, repository, recovery, second.ActiveOperationRequestID, domain.OperationCompleted)
	stopped, err := loadAgentRecord(ctx, repository.pool, agent.AgentID)
	if err != nil || (stopped.LifecycleState != domain.AgentCreated || stopped.ActivationState != domain.ActivationDisabled || stopped.RuntimeState != domain.RuntimeAbsent) || deps.disableCalls != 2 {
		t.Fatalf("retry did not converge: %+v calls=%d %v", stopped, deps.disableCalls, err)
	}
}
func (deps *offboardingDependencies) EnableRuntime(context.Context, string, string, string, ports.RuntimeConfiguration) (ports.RuntimeOperation, error) {
	deps.runtime = ports.RuntimeOperation{State: "completed", Effect: "completed", RuntimeRevision: "rtv_33333333333333333333333333333333", RuntimeExecutionID: "", MCPEndpoint: "", LifecycleState: "provisioned", Health: "unknown"}
	return deps.runtime, nil
}
func (deps *offboardingDependencies) InspectRuntime(_ context.Context, id string) (ports.RuntimeInspection, error) {
	return ports.RuntimeInspection{AgentID: id, RuntimeRevision: deps.runtime.RuntimeRevision, RuntimeExecutionID: deps.runtime.RuntimeExecutionID, MCPEndpoint: deps.runtime.MCPEndpoint, LifecycleState: deps.runtime.LifecycleState, Health: deps.runtime.Health}, nil
}

func finishOffboardingOperation(t *testing.T, repo *Repository, service *application.LifecycleService, requestID string, expected domain.OperationState) {
	t.Helper()
	executeLifecycleWorkflowForTest(t, repo, service, requestID, expected)
}
