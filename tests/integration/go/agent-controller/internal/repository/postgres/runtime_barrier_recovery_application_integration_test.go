package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryApplicationPersistsAdmissionAndReplaysAfterReopen(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "application-original-e\u0301-🧪", "original-protected-execution-🧪")
	before := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	beforeSkills := runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store)
	client := &runtimeBarrierRecoveryApplicationSkillClient{}
	// Only RC's ready response is simulated. Catalog resolution, preparation
	// intent persistence and recovery/lifecycle admission use the real repository.
	lifecycle := application.NewLifecycleService(fixture.store, fixture.store, nil, nil,
		&catalogStateClock{now: fixture.begin.Now}, application.WithSkillPreparation(fixture.store, client))
	service := application.NewRuntimeBarrierRecoveryAdmissionService(lifecycle, fixture.store)

	accepted, err := service.Admit(ctx, *fixture.begin.Recovery)

	require.NoError(t, err)
	require.False(t, accepted.Replayed)
	assertOneRuntimeBarrierAdmission(t, ctx, fixture, before)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, accepted.State, original)
	require.Equal(t, original, accepted.Receipt)
	require.Equal(t, domain.OperationRunning, accepted.State.Operation.State)
	require.Equal(t, domain.PhaseDrain, accepted.State.Operation.Phase)
	require.Equal(t, original.Command.RequestID, accepted.State.Agent.ActiveOperationRequestID)
	require.Equal(t, fixture.base.Agent.RuntimeRevision, accepted.State.Agent.RuntimeRevision)
	require.Equal(t, fixture.base.SourceExecution.ID, accepted.State.Agent.ExecutionRevisionID)
	assertRuntimeBarrierRecoveryApplicationSkillIntent(t, ctx, fixture, accepted.State, client, beforeSkills)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, original)

	changedPolicy, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
		fixture.base.Agent.OrganizationID, "application-policy-now-manual", fixture.policy.Revision, "manual", 60000,
	))
	require.NoError(t, err)
	// The seed creates this real template through PutTemplate. Retiring it via
	// the existing catalog mutation keeps its historical revision in PostgreSQL.
	_, err = fixture.store.SetCatalogAvailability(ctx, availabilityChange(
		ports.CatalogTemplate, original.Command.TemplateID, original.Command.OrganizationID,
		"application-retire-original-template", true, false,
	))
	require.NoError(t, err)
	currentTemplate, err := fixture.store.GetTemplate(ctx, original.Command.TemplateID)
	require.NoError(t, err)
	require.False(t, currentTemplate.Enabled)
	require.Equal(t, "manual", changedPolicy.Mode)
	beforeReplay := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	fixture.store.Close()

	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	unavailableSpecs := &runtimeBarrierRecoveryApplicationUnavailableSpecs{}
	unavailableClient := &runtimeBarrierRecoveryApplicationSkillClient{err: errors.New("RC preparation unavailable after reopen")}
	// A replay must work with both catalog and Skill preparation unavailable.
	// No Temporal, Runtime or Egress implementation is supplied to this service.
	replayLifecycle := application.NewLifecycleService(unavailableSpecs, reopened, nil, nil,
		&catalogStateClock{now: original.CooldownUntil.Add(24 * time.Hour)},
		application.WithSkillPreparation(nil, unavailableClient))
	replayService := application.NewRuntimeBarrierRecoveryAdmissionService(replayLifecycle, reopened)
	retry := *fixture.begin.Recovery
	retry.Command.TemplateID = "different-current-template"
	retry.Command.TemplateRevision = 99
	retry.ExpectedPolicyRevision = changedPolicy.Revision
	retry.ExpectedOwnerUserID = "different-current-owner"
	retry.ExpectedOwnerAuthorizationSequence++

	replayed, err := replayService.Admit(ctx, retry)

	require.NoError(t, err)
	require.True(t, replayed.Replayed)
	require.Equal(t, original, replayed.Receipt)
	require.Equal(t, accepted.State.Operation, replayed.State.Operation)
	runtimeBarrierRecoveryApplicationJSONEqual(t, accepted.State.TargetSpec, replayed.State.TargetSpec)
	require.Equal(t, 0, unavailableSpecs.calls)
	require.Empty(t, unavailableClient.prepares)
	require.Equal(t, 0, unavailableClient.queries)
	require.Equal(t, 0, unavailableClient.releases)
	require.Len(t, client.prepares, 1)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, reopened, original)
	require.Equal(t, beforeReplay, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened),
		"replay cannot rewrite any Controller table, Skill intent, cooldown or pending start")
	policyAfterReplay, err := reopened.GetRuntimeBarrierRecoveryPolicy(ctx, original.Command.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, changedPolicy, policyAfterReplay)
	templateAfterReplay, err := reopened.GetTemplate(ctx, original.Command.TemplateID)
	require.NoError(t, err)
	require.False(t, templateAfterReplay.Enabled)
}

func TestRuntimeBarrierRecoveryApplicationRecoversReceiptAfterActualBeginCommitError(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "application-unknown-commit-🧪", "original-unknown-commit-execution-🧪")
	before := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	beforeSkills := runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store)
	client := &runtimeBarrierRecoveryApplicationSkillClient{}
	connectionLost := errors.New("synthetic connection lost after the real Begin commit")
	var afterCommit map[string]string
	store := &runtimeBarrierRecoveryApplicationLostCommitStore{
		Repository: fixture.store, failure: connectionLost,
		afterCommit: func() { afterCommit = runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store) },
	}
	lifecycle := application.NewLifecycleService(fixture.store, store, nil, nil,
		&catalogStateClock{now: fixture.begin.Now}, application.WithSkillPreparation(fixture.store, client))
	service := application.NewRuntimeBarrierRecoveryAdmissionService(lifecycle, fixture.store)

	result, err := service.Admit(ctx, *fixture.begin.Recovery)

	require.NoError(t, err)
	require.True(t, result.Replayed, "the application must recover the committed tuple after the injected response error")
	require.Equal(t, 1, store.beginCalls)
	require.Equal(t, 1, store.successfulCommits)
	require.False(t, store.repositoryReplayed, "the wrapped Begin really created the first admission")
	require.Equal(t, 1, store.replayCalls)
	require.NotNil(t, afterCommit)
	require.Equal(t, afterCommit, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store),
		"the synthetic failure and its recovery do not perform any later database mutation")
	assertOneRuntimeBarrierAdmission(t, ctx, fixture, before)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, result.State, original)
	require.Equal(t, original, result.Receipt)
	require.Equal(t, fixture.begin.Recovery.Command, original.Command)
	require.Equal(t, store.committedState.Operation, result.State.Operation)
	runtimeBarrierRecoveryApplicationJSONEqual(t, store.committedState.TargetSpec, result.State.TargetSpec)
	assertRuntimeBarrierRecoveryApplicationSkillIntent(t, ctx, fixture, result.State, client, beforeSkills)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, original)

	again, err := service.Admit(ctx, *fixture.begin.Recovery)
	require.NoError(t, err)
	require.True(t, again.Replayed)
	require.Equal(t, original, again.Receipt)
	require.Equal(t, result.State.Operation, again.State.Operation)
	require.Equal(t, 1, store.beginCalls)
	require.Equal(t, 1, store.successfulCommits)
	require.Equal(t, 2, store.replayCalls)
	require.Len(t, client.prepares, 1)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, original)
	require.Equal(t, afterCommit, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store))
}

type runtimeBarrierRecoveryApplicationPrepareCall struct {
	requestID string
	agentID   string
	request   ports.SkillPreparationRequest
}

// This fake represents only the RC ready boundary. It does not materialize any
// package, perform Runtime I/O or stand in for the real PostgreSQL intent store.
type runtimeBarrierRecoveryApplicationSkillClient struct {
	prepares []runtimeBarrierRecoveryApplicationPrepareCall
	queries  int
	releases int
	err      error
}

func (client *runtimeBarrierRecoveryApplicationSkillClient) PrepareSkillSet(ctx context.Context, requestID, agentID string, request ports.SkillPreparationRequest) (ports.SkillPreparationReceipt, error) {
	client.prepares = append(client.prepares, runtimeBarrierRecoveryApplicationPrepareCall{requestID: requestID, agentID: agentID, request: request})
	if client.err != nil {
		return ports.SkillPreparationReceipt{}, client.err
	}
	return (readySkillPreparationClient{}).PrepareSkillSet(ctx, requestID, agentID, request)
}

func (client *runtimeBarrierRecoveryApplicationSkillClient) GetSkillPreparation(context.Context, string, string, string) (ports.SkillPreparationReceipt, error) {
	client.queries++
	return ports.SkillPreparationReceipt{}, errors.New("unexpected RC preparation query during admission")
}

func (client *runtimeBarrierRecoveryApplicationSkillClient) ReleaseSkillPreparation(context.Context, string, string, string, string, string) error {
	client.releases++
	return errors.New("unexpected RC preparation release during admission")
}

type runtimeBarrierRecoveryApplicationUnavailableSpecs struct{ calls int }

func (source *runtimeBarrierRecoveryApplicationUnavailableSpecs) GetTemplateRevision(context.Context, string, int64) (domain.TemplateRevision, error) {
	source.calls++
	return domain.TemplateRevision{}, errors.New("template catalog unavailable after reopen")
}

func (source *runtimeBarrierRecoveryApplicationUnavailableSpecs) GetCurrentModelProfileRevision(context.Context, string) (domain.ModelProfileRevision, error) {
	source.calls++
	return domain.ModelProfileRevision{}, errors.New("model catalog unavailable after reopen")
}

type runtimeBarrierRecoveryApplicationLostCommitStore struct {
	*Repository
	failure            error
	afterCommit        func()
	beginCalls         int
	successfulCommits  int
	replayCalls        int
	repositoryReplayed bool
	committedState     ports.AgentRebuildState
}

func (store *runtimeBarrierRecoveryApplicationLostCommitStore) BeginAgentRebuild(ctx context.Context, input ports.BeginAgentRebuild) (ports.AgentRebuildState, bool, error) {
	store.beginCalls++
	state, replayed, err := store.Repository.BeginAgentRebuild(ctx, input)
	if err != nil {
		return state, replayed, err
	}
	store.successfulCommits++
	store.repositoryReplayed = replayed
	store.committedState = state
	if store.afterCommit != nil {
		store.afterCommit()
	}
	// The real transaction is already committed. Return only a synthetic error;
	// no repair SQL or second Begin is performed by this test adapter.
	return ports.AgentRebuildState{}, false, store.failure
}

func (store *runtimeBarrierRecoveryApplicationLostCommitStore) ReplayAgentRebuild(ctx context.Context, requestID, fingerprint string) (ports.AgentRebuildState, bool, error) {
	store.replayCalls++
	return store.Repository.ReplayAgentRebuild(ctx, requestID, fingerprint)
}

func runtimeBarrierRecoveryApplicationSkillCount(t *testing.T, ctx context.Context, store *Repository) int64 {
	t.Helper()
	var count int64
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.agent_skill_preparation_intents`).Scan(&count))
	return count
}

func assertRuntimeBarrierRecoveryApplicationSkillIntent(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture, state ports.AgentRebuildState, client *runtimeBarrierRecoveryApplicationSkillClient, before int64) {
	t.Helper()
	require.Equal(t, before+1, runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store))
	intent, err := fixture.store.GetSkillPreparationIntent(ctx, fixture.begin.Operation.RequestID)
	require.NoError(t, err)
	require.Equal(t, fixture.begin.Operation.RequestID, intent.RequestID)
	require.Equal(t, fixture.begin.Operation.RequestFingerprint, intent.RequestFingerprint)
	require.Equal(t, domain.OperationRebuild, intent.Kind)
	require.Equal(t, fixture.base.Agent.AgentID, intent.AgentID)
	require.Equal(t, fixture.base.Agent.OrganizationID, intent.OrganizationID)
	require.Equal(t, fixture.base.Agent.AggregateSequence, intent.ExpectedAggregateSequence)
	require.Equal(t, fixture.base.ConfiguredSpec.ID, intent.ExpectedSpecRevisionID)
	require.Equal(t, fixture.base.SourceExecution.ID, intent.ExpectedExecutionRevisionID)
	require.Equal(t, fixture.base.Agent.RuntimeRevision, intent.ExpectedRuntimeRevision)
	require.Equal(t, "ready", intent.State)
	require.Equal(t, uint32(0), intent.PreparationAttempt)
	require.Equal(t, "psr_11111111111111111111111111111111", intent.PreparedReferenceID)
	require.True(t, fixture.begin.Now.Equal(intent.CreatedAt))
	require.True(t, fixture.begin.Now.Equal(intent.UpdatedAt))
	require.Equal(t, state.TargetSpec.CanonicalDigest, intent.TargetSpecDigest)
	runtimeBarrierRecoveryApplicationJSONEqual(t, state.TargetSpec.Snapshot, intent.TargetSpec)
	require.Len(t, client.prepares, 1)
	call := client.prepares[0]
	require.Equal(t, domain.DeriveResourceID("request", "skill-prepare", intent.RequestID), call.requestID)
	require.Equal(t, intent.AgentID, call.agentID)
	require.Equal(t, intent.OrganizationID, call.request.OrganizationID)
	require.Equal(t, intent.RequestID, call.request.OwnerOperationID)
	require.Equal(t, intent.TargetSpec.SkillSetDigest, call.request.SkillSetDigest)
	require.Equal(t, domain.SkillLayoutVersion, call.request.LayoutVersion)
	require.Equal(t, 0, client.queries)
	require.Equal(t, 0, client.releases)
}

func assertRuntimeBarrierRecoveryApplicationPending(t *testing.T, ctx context.Context, store *Repository, original ports.RuntimeBarrierRecoveryReceipt) {
	t.Helper()
	pending, err := store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
	require.NoError(t, err)
	require.Equal(t, []ports.RuntimeBarrierRecoveryReceipt{original}, pending,
		"admission leaves the original command pending without starting or confirming a workflow")
}

func runtimeBarrierRecoveryApplicationSnapshot(t *testing.T, ctx context.Context, store *Repository) map[string]string {
	t.Helper()
	snapshot := runtimeBarrierAdmissionSnapshot(t, ctx, store)
	// Extend the existing admission snapshot to every Controller table, including
	// the real Skill intent and catalog/policy request receipts.
	rows, err := store.pool.Query(ctx, `SELECT tablename FROM pg_tables WHERE schemaname='agent_controller' ORDER BY tablename`)
	require.NoError(t, err)
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		require.NoError(t, rows.Scan(&table))
		tables = append(tables, table)
	}
	require.NoError(t, rows.Err())
	rows.Close()
	for _, table := range tables {
		if _, found := snapshot[table]; found {
			continue
		}
		var value string
		query := `SELECT COALESCE(jsonb_agg(to_jsonb(resource) ORDER BY to_jsonb(resource)::text),'[]'::jsonb)::text FROM ` +
			pgx.Identifier{"agent_controller", table}.Sanitize() + ` resource`
		require.NoError(t, store.pool.QueryRow(ctx, query).Scan(&value))
		snapshot[table] = value
	}
	return snapshot
}

func runtimeBarrierRecoveryApplicationJSONEqual(t *testing.T, expected, actual any) {
	t.Helper()
	expectedJSON, err := json.Marshal(expected)
	require.NoError(t, err)
	actualJSON, err := json.Marshal(actual)
	require.NoError(t, err)
	require.JSONEq(t, string(expectedJSON), string(actualJSON))
}
