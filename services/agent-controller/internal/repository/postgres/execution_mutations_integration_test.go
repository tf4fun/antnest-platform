package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionRevisionIncludesCreationAndIndependentReadiness(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedConfiguredAgentForTest(t, t.Context(), repository, false)
	before, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	// Provider + Model + create begin + create publication; intermediate phases
	// and the Template save do not alter the execution projection.
	require.EqualValues(t, 4, before.Revision)
	require.Empty(t, before.Agents[0].Agent.ExecutionRevisionID)
	op, err := repository.GetLifecycleOperation(t.Context(), "request-create-for-rebuild")
	require.NoError(t, err)
	_, err = repository.PublishAgentCreate(t.Context(), ports.PublishAgentCreate{
		RequestID: op.RequestID, Fingerprint: op.RequestFingerprint,
	})
	require.NoError(t, err, "replaying publication is not another change")
	unchanged, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision, unchanged.Revision)
	observeRuntimeForTest(t, t.Context(), repository, base.Agent, op, "execution-capacity-ready", "runtime-capacity-ready", "http://runtime:8091/mcp")
	after, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, after.Revision)
	require.Equal(t, "execution-capacity-ready", after.Agents[0].Agent.ExecutionRevisionID)
}

func TestExecutionRevisionIgnoresRepeatedRuntimeCondition(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	before, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	current := ports.RuntimeInspection{
		AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		RuntimeExecutionID: base.Agent.RuntimeExecutionID, MCPEndpoint: base.Agent.RuntimeMCPEndpoint,
		LifecycleState: "provisioned", Phase: "running", Health: "healthy", ObservedAt: base.Agent.RuntimeObservedAt.Add(time.Minute),
	}
	_, err = repository.RecordRuntimeCondition(t.Context(), ports.RecordRuntimeCondition{Inspection: current, ExpectedAggregateSequence: base.Agent.AggregateSequence})
	require.NoError(t, err)
	after, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision, after.Revision)
}

func TestExecutionRevisionRuntimeLossAndObservationReplay(t *testing.T) {
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	before, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	observation := ports.RuntimeObservation{Sequence: 1, AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision,
		Kind: ports.RuntimeObservationRestarted, ObservedAt: base.Agent.RuntimeObservedAt.Add(time.Minute)}
	require.NoError(t, repository.ApplyRuntimeObservation(t.Context(), observation))
	after, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, after.Revision)
	require.NoError(t, repository.ApplyRuntimeObservation(t.Context(), observation))
	again, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, after.Revision, again.Revision)
}

type rejectedMutationGuard struct{}

func (rejectedMutationGuard) ValidateExecutionCapacity(context.Context, ports.ExecutionCapacityInput) error {
	return ports.ErrExecutionCapacityExceeded
}

func TestExecutionRevisionRevocationAndAuthorizationRollback(t *testing.T) {
	repository, base := identityTestRepository(t)
	before, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	input := ports.SetAgentAuthorization{
		OrganizationID:   base.Agent.OrganizationID,
		Query:            ports.AgentOwnerScope{AgentID: base.Agent.AgentID, PrincipalID: base.Agent.OwnerUserID, ExpectedAccessRevision: base.Agent.AccessRevision},
		ExpectedRevision: 1, EventID: "execution-auth-change", Now: time.Now().UTC(),
		Authorization: domain.Authorization{Mode: domain.AuthorizationApprove, ToolRules: []domain.ToolRule{}},
	}
	WithExecutionCapacityGuard(rejectedMutationGuard{})(repository)
	_, err = repository.SetAgentAuthorization(t.Context(), input)
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	after, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, after)
	WithExecutionCapacityGuard(nil)(repository)
	_, err = repository.SetAgentAuthorization(t.Context(), input)
	require.NoError(t, err)
	after, err = repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, after.Revision)
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID, Reason: "user_deactivated", OccurredAt: time.Now().UTC()}
	require.NoError(t, repository.ApplyIdentityRevocation(t.Context(), 0, event, ""))
	require.NoError(t, repository.ApplyIdentityRevocation(t.Context(), 0, event, ""))
	final, err := repository.ReadExecutionSource(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+2, final.Revision)
}

func TestExecutionRevisionRepeatedRevocationOnlyAdvancesWatermarks(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := t.Context()
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, Reason: "membership_deactivated", OccurredAt: time.Now().UTC()}
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 0, event, ""))
	before, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	beforeAgent, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	require.NoError(t, err)
	beforeSnapshot, err := application.BuildExecutionSnapshot(ctx, before, mutationCredentialOpener{})
	require.NoError(t, err)

	event.Sequence, event.OrganizationID, event.Reason = 6, "", "user_deactivated"
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 5, event, ""))
	after, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision, after.Revision, "already-revoked access is not a new execution configuration")
	afterSnapshot, err := application.BuildExecutionSnapshot(ctx, after, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Equal(t, beforeSnapshot, afterSnapshot)
	agent, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	require.NoError(t, err)
	require.EqualValues(t, 6, agent.IdentityRevocationSequence)
	require.Equal(t, beforeAgent.AggregateSequence+1, agent.AggregateSequence)
	cursor, err := repository.GetIdentityRevocationCursor(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 6, cursor)
	var events int
	require.NoError(t, repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_events
WHERE agent_id=$1 AND event_type=$2`, agent.AgentID, ports.EventAgentOwnerRevoked).Scan(&events))
	require.Equal(t, 2, events)
	_, _, err = repository.BeginAgentCreate(ctx, identityCreate(base, "stale-owner-after-global-revocation", base.Agent.OrganizationID, 5))
	require.ErrorIs(t, err, ports.ErrConcurrentChange, "the newer global watermark must still prevent stale authorization")
}

type mutationCredentialOpener struct{}

func (mutationCredentialOpener) Open(context.Context, ports.CredentialIdentity, ports.SealedSecret) (string, error) {
	return "synthetic-revision-test-secret", nil
}

func TestExecutionRevisionGlobalRevocationAdvancesOnlyChangedOrganizations(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := t.Context()
	other := seedExecutionAgentInOrganization(t, repository, base, "org-other")
	_, _, err := repository.BeginAgentCreate(ctx, identityCreate(base, "same-organization-agent", base.Agent.OrganizationID, 0))
	require.NoError(t, err)
	initial, err := repository.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, Reason: "membership_deactivated", OccurredAt: time.Now().UTC()}
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 0, event, ""))
	first, err := repository.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, initial.Revision+1, first.Revision, "multiple changed Agents advance their organization only once")
	otherBefore, err := repository.GetExecutionSynchronization(ctx, other.OrganizationID)
	require.NoError(t, err)
	event.Sequence, event.OrganizationID, event.Reason = 6, "", "user_deactivated"
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 5, event, ""))
	unchanged, err := repository.GetExecutionSynchronization(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, first, unchanged)
	otherAfter, err := repository.GetExecutionSynchronization(ctx, other.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, otherBefore.Revision+1, otherAfter.Revision)
	for _, id := range []string{base.Agent.AgentID, "same-organization-agent", other.AgentID} {
		agent, err := loadAgentRecord(ctx, repository.pool, id)
		require.NoError(t, err)
		require.EqualValues(t, 6, agent.IdentityRevocationSequence)
	}
}

type organizationMutationGuard struct {
	reject string
	seen   []string
}

func TestExecutionRevisionMixedRevocationWithinOrganization(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := t.Context()
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, Reason: "membership_deactivated", OccurredAt: time.Now().UTC()}
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 0, event, ""))
	_, _, err := repository.BeginAgentCreate(ctx, identityCreate(base, "reauthorized-agent", base.Agent.OrganizationID, 5))
	require.NoError(t, err)
	before, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	beforeSnapshot, err := application.BuildExecutionSnapshot(ctx, before, mutationCredentialOpener{})
	require.NoError(t, err)
	event.Sequence, event.OrganizationID, event.Reason = 6, "", "user_deactivated"
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 5, event, ""))
	after, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision+1, after.Revision)
	afterSnapshot, err := application.BuildExecutionSnapshot(ctx, after, mutationCredentialOpener{})
	require.NoError(t, err)
	for i, agent := range afterSnapshot.Agents {
		require.Empty(t, agent.PrincipalIDs)
		if agent.AgentID == "reauthorized-agent" {
			require.Equal(t, []string{base.Agent.OwnerUserID}, beforeSnapshot.Agents[i].PrincipalIDs)
		} else {
			require.Equal(t, beforeSnapshot.Agents[i], agent)
		}
	}
	for _, id := range []string{base.Agent.AgentID, "reauthorized-agent"} {
		agent, err := loadAgentRecord(ctx, repository.pool, id)
		require.NoError(t, err)
		require.EqualValues(t, 6, agent.IdentityRevocationSequence)
	}
}

func TestExecutionRevisionDeletedIntentRevocationOnlyAdvancesWatermarks(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := t.Context()
	_, err := repository.pool.Exec(ctx, `UPDATE agent_controller.agents SET desired_state='deleted' WHERE id=$1`, base.Agent.AgentID)
	require.NoError(t, err)
	before, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	beforeSnapshot, err := application.BuildExecutionSnapshot(ctx, before, mutationCredentialOpener{})
	require.NoError(t, err)
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID,
		Reason: "user_deactivated", OccurredAt: time.Now().UTC()}
	require.NoError(t, repository.ApplyIdentityRevocation(ctx, 0, event, ""))
	after, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before.Revision, after.Revision)
	afterSnapshot, err := application.BuildExecutionSnapshot(ctx, after, mutationCredentialOpener{})
	require.NoError(t, err)
	require.Equal(t, beforeSnapshot, afterSnapshot)
	agent, err := loadAgentRecord(ctx, repository.pool, base.Agent.AgentID)
	require.NoError(t, err)
	require.Equal(t, domain.DesiredDeleted, agent.DesiredState)
	require.EqualValues(t, 5, agent.IdentityRevocationSequence)
	require.Equal(t, base.Agent.AggregateSequence+1, agent.AggregateSequence)
	cursor, err := repository.GetIdentityRevocationCursor(ctx)
	require.NoError(t, err)
	require.EqualValues(t, 5, cursor)
	var events int
	require.NoError(t, repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_events
WHERE agent_id=$1 AND event_type=$2`, agent.AgentID, ports.EventAgentOwnerRevoked).Scan(&events))
	require.Equal(t, 1, events)
}

func (guard *organizationMutationGuard) ValidateExecutionCapacity(_ context.Context, input ports.ExecutionCapacityInput) error {
	guard.seen = append(guard.seen, input.Current.OrganizationID)
	if input.Current.OrganizationID == guard.reject {
		return ports.ErrExecutionCapacityExceeded
	}
	return nil
}

func TestExecutionRevisionGlobalRevocationRollsBackAllOrganizations(t *testing.T) {
	repository, base := identityTestRepository(t)
	ctx := t.Context()
	other := seedExecutionAgentInOrganization(t, repository, base, "org-z")
	firstBefore, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	secondBefore, err := repository.ReadExecutionSource(ctx, other.OrganizationID)
	require.NoError(t, err)
	guard := &organizationMutationGuard{reject: other.OrganizationID}
	WithExecutionCapacityGuard(guard)(repository)
	event := ports.PrincipalRevocation{Sequence: 5, UserID: base.Agent.OwnerUserID, Reason: "user_deactivated", OccurredAt: time.Now().UTC()}
	require.ErrorIs(t, repository.ApplyIdentityRevocation(ctx, 0, event, ""), ports.ErrExecutionCapacityExceeded)
	require.Equal(t, []string{base.Agent.OrganizationID, other.OrganizationID}, guard.seen)
	firstAfter, err := repository.ReadExecutionSource(ctx, base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, firstBefore, firstAfter, "a later organization's rejection must roll back an earlier revision")
	secondAfter, err := repository.ReadExecutionSource(ctx, other.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, secondBefore, secondAfter)
	cursor, err := repository.GetIdentityRevocationCursor(ctx)
	require.NoError(t, err)
	require.Zero(t, cursor)
	var events, watermarks int
	require.NoError(t, repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_events WHERE event_type=$1`, ports.EventAgentOwnerRevoked).Scan(&events))
	require.NoError(t, repository.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.owner_revocations`).Scan(&watermarks))
	require.Zero(t, events)
	require.Zero(t, watermarks)
}

func seedExecutionAgentInOrganization(t *testing.T, repository *Repository, base ports.AgentLifecycleBase, organization string) ports.AgentRecord {
	t.Helper()
	ctx := t.Context()
	model := integrationModelRecord(t)
	model.RequestID, model.ModelProfileID, model.OrganizationID = "model-request-"+organization, "model-"+organization, organization
	model.ProviderConnectionID = "provider-" + organization
	modelInput := domain.ModelProfileRevisionInput(model.Revision.Snapshot())
	modelInput.ID, modelInput.ModelProfileID, modelInput.OrganizationID = "modelrev-"+organization, model.ModelProfileID, organization
	var err error
	model.Revision, err = domain.NewModelProfileRevision(modelInput)
	require.NoError(t, err)
	seedProviderForModel(t, repository, model)
	_, err = repository.PutModelProfile(ctx, model)
	require.NoError(t, err)
	template := integrationTemplateRecord(t, model.Revision)
	template.RequestID, template.TemplateID, template.OrganizationID = "template-request-"+organization, "template-"+organization, organization
	templateInput := domain.TemplateRevisionInput(template.Revision.Snapshot())
	templateInput.TemplateID, templateInput.OrganizationID = template.TemplateID, organization
	template.Revision, err = domain.NewTemplateRevision(templateInput)
	require.NoError(t, err)
	_, err = repository.PutTemplate(ctx, template)
	require.NoError(t, err)
	spec, err := domain.MaterializeAgentSpec(template.Revision, model.Revision)
	require.NoError(t, err)
	input := identityCreate(base, "agent-"+organization, organization, 0)
	input.Spec.Snapshot = spec.Snapshot()
	input.Spec.CanonicalDigest, err = spec.Digest()
	require.NoError(t, err)
	_, _, err = repository.BeginAgentCreate(ctx, input)
	require.NoError(t, err)
	return input.Agent
}
