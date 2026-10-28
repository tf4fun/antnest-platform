package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func modelCallPolicyTestInput(org, request string, revision int64) ports.SetModelCallPolicy {
	return ports.SetModelCallPolicy{
		RequestID: request, OrganizationID: org, ActorPrincipalID: "policy-admin",
		ExpectedRevision: revision, UnknownCost: "allow",
	}
}

func modelCallPolicyCappedInput(org, request string, revision int64) ports.SetModelCallPolicy {
	input := modelCallPolicyTestInput(org, request, revision)
	input.UnknownCost = "deny"
	input.RunCaps = domain.RunBudget{MaxInputTokens: modelCallPolicyCapValue(1000), MaxCostUSDMicros: modelCallPolicyCapValue(50)}
	input.Daily = domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyCapValue(40), HardCostUSDMicros: modelCallPolicyCapValue(60)}
	input.Monthly = domain.PeriodCaps{HardCostUSDMicros: modelCallPolicyCapValue(900)}
	return input
}

func modelCallPolicyCapValue(value int64) *int64 { return &value }

func modelCallPolicyExpected(input ports.SetModelCallPolicy, revision int64) domain.ModelCallPolicy {
	return domain.ModelCallPolicy{OrganizationID: input.OrganizationID, OrganizationBudget: domain.OrganizationBudget{
		Revision: revision, UnknownCost: input.UnknownCost,
		RunCaps: input.RunCaps, Daily: input.Daily, Monthly: input.Monthly,
	}}
}

func assertModelCallPolicyRows(t *testing.T, ctx context.Context, store *Repository, policies, receipts int64) {
	t.Helper()
	var policyCount, receiptCount int64
	err := store.pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM agent_controller.model_call_policies),
(SELECT count(*) FROM agent_controller.model_call_policy_requests)`).Scan(&policyCount, &receiptCount)
	require.NoError(t, err)
	require.Equal(t, policies, policyCount)
	require.Equal(t, receipts, receiptCount)
}

func modelCallPolicySyncState(t *testing.T, ctx context.Context, store *Repository, organizationID string) ports.ExecutionSynchronization {
	t.Helper()
	state, err := store.GetExecutionSynchronization(ctx, organizationID)
	require.NoError(t, err)
	return state
}

func insertModelCallPolicySyncRow(t *testing.T, ctx context.Context, store *Repository, organizationID string, revision, applied int64) {
	t.Helper()
	_, err := store.pool.Exec(ctx, `INSERT INTO agent_controller.execution_configuration_sync
(organization_id, revision, applied_revision, updated_at, applied_at)
VALUES ($1,$2,$3,NOW(),CASE WHEN $3::bigint > 0 THEN NOW() END)`, organizationID, revision, applied)
	require.NoError(t, err)
}

func TestModelCallPolicySyncFixturePreservesBigintRevisions(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	for _, row := range []struct {
		name           string
		organizationID string
		revision       int64
		applied        int64
	}{
		{"fixture-zero", "fixture-zero", 5, 0},
		{"fixture-positive", "fixture-positive", 5, 4},
		{"fixture-bigint", "fixture-bigint", (1 << 31) + 8, (1 << 31) + 7},
	} {
		insertModelCallPolicySyncRow(t, ctx, store, row.organizationID, row.revision, row.applied)
		state := modelCallPolicySyncState(t, ctx, store, row.organizationID)
		require.Equal(t, row.revision, state.Revision, row.name)
		require.Equal(t, row.applied, state.AppliedRevision, row.name)
		if row.applied == 0 {
			require.Nil(t, state.AppliedAt, row.name)
		} else {
			require.NotNil(t, state.AppliedAt, row.name)
		}
	}
}

func TestModelCallPolicyAbsentReadDoesNotPersistDefaultsOrHead(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	assertModelCallPolicyRows(t, ctx, store, 0, 0)
	for range 2 {
		policy, err := store.GetModelCallPolicy(ctx, "policy-org")
		require.NoError(t, err)
		require.Equal(t, domain.DefaultModelCallPolicy("policy-org"), policy)
		assertModelCallPolicyRows(t, ctx, store, 0, 0)
		_, err = store.GetExecutionSynchronization(ctx, "policy-org")
		require.ErrorIs(t, err, ports.ErrNotFound, "a default policy read must not create a publication head")
	}
}

func TestModelCallPolicyFirstSetAdvancesPublicationHeadAndKeepsApplied(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
	hints := 0
	WithExecutionChangeObserver(func(context.Context, string) { hints++ })(store)
	source, err := store.ReadExecutionSource(ctx, "policy-org")
	require.NoError(t, err)
	require.Nil(t, source.OrganizationBudget, "absent policy emits no organization_budget")

	input := modelCallPolicyCappedInput("policy-org", "policy-first", 0)
	written, err := store.SetModelCallPolicy(ctx, input)
	require.NoError(t, err)
	require.Equal(t, modelCallPolicyExpected(input, 1), written)
	require.Equal(t, 1, hints)
	assertModelCallPolicyRows(t, ctx, store, 1, 1)
	sync := modelCallPolicySyncState(t, ctx, store, "policy-org")
	require.EqualValues(t, 6, sync.Revision, "the policy CAS must advance the same publication head")
	require.EqualValues(t, 4, sync.AppliedRevision, "an old ACK must not acknowledge the new head")

	source, err = store.ReadExecutionSource(ctx, "policy-org")
	require.NoError(t, err)
	require.NotNil(t, source.OrganizationBudget)
	require.Equal(t, written.OrganizationBudget, *source.OrganizationBudget)
	snapshot, err := application.BuildExecutionSnapshot(ctx, source, mutationCredentialOpener{})
	require.NoError(t, err)
	require.NotNil(t, snapshot.OrganizationBudget)
	require.Equal(t, written.OrganizationBudget, *snapshot.OrganizationBudget)
	require.NotSame(t, source.OrganizationBudget, snapshot.OrganizationBudget,
		"the wire projection must not alias the persisted budget")
}

type modelCallPolicyCaptureGuard struct {
	err  error
	seen []ports.ExecutionCapacityInput
}

func (guard *modelCallPolicyCaptureGuard) ValidateExecutionCapacity(_ context.Context, input ports.ExecutionCapacityInput) error {
	guard.seen = append(guard.seen, input)
	return guard.err
}

func TestModelCallPolicyCapacityCheckSeesNewPolicyBeforeCommit(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	guard := &modelCallPolicyCaptureGuard{}
	WithExecutionCapacityGuard(guard)(store)
	input := modelCallPolicyCappedInput("policy-org", "capacity-observed", 0)
	written, err := store.SetModelCallPolicy(ctx, input)
	require.NoError(t, err)
	require.Len(t, guard.seen, 1)
	require.NotNil(t, guard.seen[0].Current.OrganizationBudget,
		"the in-transaction capacity check must see the replacement policy")
	require.Equal(t, written.OrganizationBudget, *guard.seen[0].Current.OrganizationBudget)
}

func TestModelCallPolicyCapacityFailureRollsBackPolicyReceiptAndHead(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
	hints := 0
	WithExecutionChangeObserver(func(context.Context, string) { hints++ })(store)
	WithExecutionCapacityGuard(rejectedMutationGuard{})(store)
	input := modelCallPolicyCappedInput("policy-org", "capacity-rejected", 0)
	_, err := store.SetModelCallPolicy(ctx, input)
	require.ErrorIs(t, err, ports.ErrExecutionCapacityExceeded)
	require.Zero(t, hints, "a rolled-back policy must not hint the publication observer")
	assertModelCallPolicyRows(t, ctx, store, 0, 0)
	sync := modelCallPolicySyncState(t, ctx, store, "policy-org")
	require.EqualValues(t, 5, sync.Revision)
	require.EqualValues(t, 4, sync.AppliedRevision)
	WithExecutionCapacityGuard(nil)(store)
	written, err := store.SetModelCallPolicy(ctx, input)
	require.NoError(t, err)
	require.EqualValues(t, 1, written.Revision)
	require.Equal(t, 1, hints)
	assertModelCallPolicyRows(t, ctx, store, 1, 1)
}

func TestModelCallPolicyReceiptFailureRollsBackPolicyAndHead(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "first-policy"
		if existing {
			name = "existing-policy"
		}
		t.Run(name, func(t *testing.T) {
			store := providerTestRepository(t)
			ctx := runtimeBarrierPolicyTestContext(t)
			insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
			before := domain.DefaultModelCallPolicy("policy-org")
			var policies, receipts int64
			head := int64(5)
			if existing {
				var err error
				before, err = store.SetModelCallPolicy(ctx, modelCallPolicyTestInput("policy-org", "before-receipt-fault", 0))
				require.NoError(t, err)
				policies, receipts = 1, 1
				head = 6
			}
			hints := 0
			WithExecutionChangeObserver(func(context.Context, string) { hints++ })(store)
			restore := installModelCallPolicyReceiptFailure(t, ctx, store)
			input := modelCallPolicyCappedInput("policy-org", "faulted-receipt", before.Revision)
			_, err := store.SetModelCallPolicy(ctx, input)
			var databaseError *pgconn.PgError
			require.ErrorAs(t, err, &databaseError, "the actual receipt INSERT must reach the injected PostgreSQL failure")
			require.Equal(t, "P0001", databaseError.Code)
			require.Zero(t, hints)
			current, err := store.GetModelCallPolicy(ctx, input.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, before, current)
			assertModelCallPolicyRows(t, ctx, store, policies, receipts)
			require.EqualValues(t, head, modelCallPolicySyncState(t, ctx, store, "policy-org").Revision,
				"the publication head must roll back with the policy and receipt")

			require.NoError(t, restore())
			written, err := store.SetModelCallPolicy(ctx, input)
			require.NoError(t, err, "the same request succeeds after the fault is removed")
			require.Equal(t, before.Revision+1, written.Revision)
			require.Equal(t, input.UnknownCost, written.UnknownCost)
			assertModelCallPolicyRows(t, ctx, store, 1, receipts+1)
		})
	}
}

func TestModelCallPolicyOriginalReceiptSurvivesLaterWritesAndReopen(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
	firstInput := modelCallPolicyCappedInput("policy-org", "policy-first", 0)
	first, err := store.SetModelCallPolicy(ctx, firstInput)
	require.NoError(t, err)
	require.Equal(t, modelCallPolicyExpected(firstInput, 1), first)
	secondInput := modelCallPolicyTestInput("policy-org", "policy-second", 1)
	second, err := store.SetModelCallPolicy(ctx, secondInput)
	require.NoError(t, err)
	require.Equal(t, modelCallPolicyExpected(secondInput, 2), second)
	head := modelCallPolicySyncState(t, ctx, store, "policy-org").Revision
	assertModelCallPolicyRows(t, ctx, store, 1, 2)

	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	replayed, err := reopened.SetModelCallPolicy(ctx, firstInput)
	require.NoError(t, err)
	require.Equal(t, first, replayed, "a stale original request returns its original receipt")
	current, err := reopened.GetModelCallPolicy(ctx, firstInput.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, second, current, "replaying revision one must not overwrite revision two")
	require.Equal(t, head, modelCallPolicySyncState(t, ctx, reopened, "policy-org").Revision,
		"a receipt replay must not advance the publication head")
	assertModelCallPolicyRows(t, ctx, reopened, 1, 2)

	for _, field := range []string{"unknown_cost", "run_caps", "daily", "monthly", "actor", "expected-revision"} {
		changed := firstInput
		switch field {
		case "unknown_cost":
			changed.UnknownCost = "allow"
		case "run_caps":
			changed.RunCaps = domain.RunBudget{MaxOutputTokens: modelCallPolicyCapValue(5)}
		case "daily":
			changed.Daily = domain.PeriodCaps{}
		case "monthly":
			changed.Monthly = domain.PeriodCaps{SoftCostUSDMicros: modelCallPolicyCapValue(1)}
		case "actor":
			changed.ActorPrincipalID = "another-admin"
		case "expected-revision":
			changed.ExpectedRevision = 1
		}
		_, err = reopened.SetModelCallPolicy(ctx, changed)
		require.ErrorIs(t, err, ports.ErrRequestConflict, "changed original request must be checked before its stale CAS: %s", field)
	}
	stale := firstInput
	stale.RequestID = "policy-new-stale"
	_, err = reopened.SetModelCallPolicy(ctx, stale)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	current, err = reopened.GetModelCallPolicy(ctx, firstInput.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, second, current)
	require.Equal(t, head, modelCallPolicySyncState(t, ctx, reopened, "policy-org").Revision)
	assertModelCallPolicyRows(t, ctx, reopened, 1, 2)

	var receipt domain.ModelCallPolicy
	var fingerprint string
	err = reopened.pool.QueryRow(ctx, `SELECT result, request_fingerprint
FROM agent_controller.model_call_policy_requests
WHERE organization_id=$1 AND request_id=$2`, firstInput.OrganizationID, firstInput.RequestID).Scan(&receipt, &fingerprint)
	require.NoError(t, err)
	require.Equal(t, first, receipt)
	require.Regexp(t, `^[0-9a-f]{64}$`, fingerprint)
}

func TestModelCallPolicySameRequestIDIsIndependentAcrossOrganizations(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	for _, input := range []ports.SetModelCallPolicy{
		modelCallPolicyCappedInput("policy-org-a", "shared-request", 0),
		modelCallPolicyTestInput("policy-org-b", "shared-request", 0),
	} {
		written, err := store.SetModelCallPolicy(ctx, input)
		require.NoError(t, err)
		require.Equal(t, modelCallPolicyExpected(input, 1), written)
		replayed, err := store.SetModelCallPolicy(ctx, input)
		require.NoError(t, err)
		require.Equal(t, written, replayed)
		current, err := store.GetModelCallPolicy(ctx, input.OrganizationID)
		require.NoError(t, err)
		require.Equal(t, written, current)
	}
	assertModelCallPolicyRows(t, ctx, store, 2, 2)
	a, err := store.GetModelCallPolicy(ctx, "policy-org-a")
	require.NoError(t, err)
	b, err := store.GetModelCallPolicy(ctx, "policy-org-b")
	require.NoError(t, err)
	require.NotEqual(t, a.OrganizationBudget, b.OrganizationBudget)
}

type modelCallPolicyTestResult struct {
	policy domain.ModelCallPolicy
	err    error
}

func runModelCallPolicyTestRequests(ctx context.Context, stores []*Repository, inputs []ports.SetModelCallPolicy) []modelCallPolicyTestResult {
	results := make([]modelCallPolicyTestResult, len(inputs))
	var wait sync.WaitGroup
	for index := range inputs {
		wait.Add(1)
		go func() {
			defer wait.Done()
			policy, err := stores[index%len(stores)].SetModelCallPolicy(ctx, inputs[index])
			results[index] = modelCallPolicyTestResult{policy: policy, err: err}
		}()
	}
	wait.Wait()
	return results
}

func TestModelCallPolicyConcurrentFirstCASAcceptsOneRequest(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
	inputs := []ports.SetModelCallPolicy{
		modelCallPolicyCappedInput("policy-org", "concurrent-first-a", 0),
		modelCallPolicyTestInput("policy-org", "concurrent-first-b", 0),
	}
	results := runModelCallPolicyTestRequests(ctx, []*Repository{store, other}, inputs)
	var winner domain.ModelCallPolicy
	accepted, conflicts := 0, 0
	for index, result := range results {
		if result.err == nil {
			accepted++
			winner = result.policy
			require.Equal(t, modelCallPolicyExpected(inputs[index], 1), result.policy)
		} else {
			require.ErrorIs(t, result.err, ports.ErrConcurrentChange)
			conflicts++
		}
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 1, conflicts)
	current, err := store.GetModelCallPolicy(ctx, "policy-org")
	require.NoError(t, err)
	require.Equal(t, winner, current)
	require.EqualValues(t, 6, modelCallPolicySyncState(t, ctx, store, "policy-org").Revision)
	assertModelCallPolicyRows(t, ctx, store, 1, 1)
}

func TestModelCallPolicyConcurrentIdenticalRequestsCommitOneReceipt(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
	input := modelCallPolicyCappedInput("policy-org", "concurrent-same", 0)
	results := runModelCallPolicyTestRequests(ctx,
		[]*Repository{store, other},
		[]ports.SetModelCallPolicy{input, input, input, input},
	)
	expected := modelCallPolicyExpected(input, 1)
	for _, result := range results {
		require.NoError(t, result.err)
		require.Equal(t, expected, result.policy)
	}
	current, err := store.GetModelCallPolicy(ctx, input.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, expected, current)
	require.EqualValues(t, 6, modelCallPolicySyncState(t, ctx, store, "policy-org").Revision,
		"identical concurrent requests advance the publication head exactly once")
	assertModelCallPolicyRows(t, ctx, store, 1, 1)
}

func TestModelCallPolicyExhaustedRevisionsConflictWithoutChanges(t *testing.T) {
	t.Run("policy-revision", func(t *testing.T) {
		store := providerTestRepository(t)
		ctx := runtimeBarrierPolicyTestContext(t)
		insertModelCallPolicySyncRow(t, ctx, store, "policy-org", 5, 4)
		policy := modelCallPolicyExpected(modelCallPolicyTestInput("policy-org", "seeded", 0), domain.MaximumModelBudget)
		raw, err := json.Marshal(policy)
		require.NoError(t, err)
		_, err = store.pool.Exec(ctx, `INSERT INTO agent_controller.model_call_policies
(organization_id, revision, policy) VALUES ($1,$2,$3)`, policy.OrganizationID, policy.Revision, raw)
		require.NoError(t, err)
		input := modelCallPolicyTestInput("policy-org", "exhausted", domain.MaximumModelBudget)
		_, err = store.SetModelCallPolicy(ctx, input)
		require.ErrorIs(t, err, ports.ErrConcurrentChange)
		current, readErr := store.GetModelCallPolicy(ctx, "policy-org")
		require.NoError(t, readErr)
		require.Equal(t, policy, current)
		require.EqualValues(t, 5, modelCallPolicySyncState(t, ctx, store, "policy-org").Revision)
		assertModelCallPolicyRows(t, ctx, store, 1, 0)
	})
	t.Run("execution-head", func(t *testing.T) {
		store := providerTestRepository(t)
		ctx := runtimeBarrierPolicyTestContext(t)
		insertModelCallPolicySyncRow(t, ctx, store, "policy-org", ports.MaximumExecutionRevision, 4)
		hints := 0
		WithExecutionChangeObserver(func(context.Context, string) { hints++ })(store)
		input := modelCallPolicyCappedInput("policy-org", "head-exhausted", 0)
		_, err := store.SetModelCallPolicy(ctx, input)
		require.ErrorIs(t, err, ports.ErrConcurrentChange)
		require.Zero(t, hints)
		current, readErr := store.GetModelCallPolicy(ctx, "policy-org")
		require.NoError(t, readErr)
		require.Equal(t, domain.DefaultModelCallPolicy("policy-org"), current,
			"execution head exhaustion must roll back the policy write")
		assertModelCallPolicyRows(t, ctx, store, 0, 0)
	})
}

func TestModelCallPolicyPublicationEmitsCompleteOrganizationBudget(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	insertModelCallPolicySyncRow(t, ctx, store, "policy-publication-org", 5, 4)

	type observation struct {
		snapshot receivedExecutionSnapshot
		err      error
	}
	observed := make(chan observation, 4)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseACK := func() { releaseOnce.Do(func() { close(release) }) }
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		var current observation
		if request.Method != http.MethodPost || request.URL.Path != "/rpc/agent-acp/apply-execution-snapshot" {
			current.err = fmt.Errorf("unexpected publication route %s %s", request.Method, request.URL.Path)
		} else {
			current.err = json.NewDecoder(http.MaxBytesReader(response, request.Body, 1<<20)).Decode(&current.snapshot)
		}
		select {
		case observed <- current:
		case <-request.Context().Done():
			return
		}
		if current.err != nil {
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		select {
		case <-release:
		case <-request.Context().Done():
			return
		}
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(ports.ExecutionAcknowledgement{
			OrganizationID: current.snapshot.OrganizationID, AppliedRevision: current.snapshot.Revision,
		}); err != nil {
			t.Errorf("write publication ACK: %v", err)
		}
	}))
	httpClient := server.Client()
	publicationContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	type publicationResult struct {
		acknowledgement ports.ExecutionAcknowledgement
		err             error
	}
	finished := make(chan publicationResult, 2)
	defer func() {
		releaseACK()
		cancel()
		httpClient.CloseIdleConnections()
		server.Close()
	}()
	client, err := acpclient.New(server.URL, 5*time.Second, httpClient)
	require.NoError(t, err)
	publisher := application.NewExecutionPublisher(store, mutationCredentialOpener{}, client)
	publish := func() {
		acknowledgement, err := publisher.Publish(publicationContext, "policy-publication-org")
		finished <- publicationResult{acknowledgement: acknowledgement, err: err}
	}
	go publish()

	var legacy observation
	select {
	case legacy = <-observed:
	case result := <-finished:
		t.Fatalf("publication ended before the HTTP request: %v", result.err)
	case <-publicationContext.Done():
		t.Fatalf("publication did not reach the HTTP peer: %v", publicationContext.Err())
	}
	require.NoError(t, legacy.err)
	require.Equal(t, "policy-publication-org", legacy.snapshot.OrganizationID)
	require.EqualValues(t, 5, legacy.snapshot.Revision)
	require.Empty(t, legacy.snapshot.OrganizationBudget, "a missing policy must not emit organization_budget")

	input := modelCallPolicyCappedInput("policy-publication-org", "publish-policy", 0)
	written, err := store.SetModelCallPolicy(ctx, input)
	require.NoError(t, err)
	pending := modelCallPolicySyncState(t, ctx, store, "policy-publication-org")
	require.EqualValues(t, 6, pending.Revision)
	require.EqualValues(t, 4, pending.AppliedRevision, "a held old ACK cannot acknowledge the new policy head")

	releaseACK()
	require.NoError(t, (<-finished).err)
	require.EqualValues(t, 5, modelCallPolicySyncState(t, ctx, store, "policy-publication-org").AppliedRevision)

	release = make(chan struct{})
	releaseOnce = sync.Once{}
	go publish()
	var configured observation
	select {
	case configured = <-observed:
	case result := <-finished:
		t.Fatalf("policy publication ended before the HTTP request: %v", result.err)
	case <-publicationContext.Done():
		t.Fatalf("policy publication did not reach the HTTP peer: %v", publicationContext.Err())
	}
	require.NoError(t, configured.err)
	require.EqualValues(t, 6, configured.snapshot.Revision)
	var fields map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(configured.snapshot.OrganizationBudget, &fields),
		"the first committed policy must emit a complete organization_budget")
	require.Len(t, fields, 5)
	for _, field := range []string{"revision", "unknown_cost", "run_caps", "daily", "monthly"} {
		require.Contains(t, fields, field)
	}
	require.NotContains(t, fields, "organization_id")
	require.JSONEq(t, fmt.Sprintf(`{"revision":%d,"unknown_cost":"deny",
"run_caps":{"max_input_tokens":1000,"max_cost_usd_micros":50},
"daily":{"soft_cost_usd_micros":40,"hard_cost_usd_micros":60},
"monthly":{"hard_cost_usd_micros":900}}`, written.Revision), string(configured.snapshot.OrganizationBudget))
	pending = modelCallPolicySyncState(t, ctx, store, "policy-publication-org")
	require.EqualValues(t, 6, pending.Revision)
	require.EqualValues(t, 5, pending.AppliedRevision, "the new publication waits for its own ACK")

	releaseACK()
	result := <-finished
	require.NoError(t, result.err)
	require.Equal(t, ports.ExecutionAcknowledgement{OrganizationID: "policy-publication-org", AppliedRevision: 6}, result.acknowledgement)
	completed := modelCallPolicySyncState(t, ctx, store, "policy-publication-org")
	require.EqualValues(t, 6, completed.Revision)
	require.EqualValues(t, 6, completed.AppliedRevision)
	require.EqualValues(t, 2, calls.Load(), "the producer must not silently replay the HTTP request")
}

func installModelCallPolicyReceiptFailure(t *testing.T, ctx context.Context, store *Repository) func() error {
	t.Helper()
	_, err := store.pool.Exec(ctx, `CREATE FUNCTION agent_controller.model_call_policy_test_fail_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='injected policy receipt failure';
END;
$$`)
	require.NoError(t, err)
	restore := func() error {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, triggerError := store.pool.Exec(cleanup, `DROP TRIGGER IF EXISTS model_call_policy_test_fail_receipt
ON agent_controller.model_call_policy_requests`)
		_, functionError := store.pool.Exec(cleanup, `DROP FUNCTION IF EXISTS agent_controller.model_call_policy_test_fail_receipt()`)
		return errors.Join(triggerError, functionError)
	}
	t.Cleanup(func() { require.NoError(t, restore(), "remove the owned PostgreSQL receipt fault") })
	_, err = store.pool.Exec(ctx, `CREATE TRIGGER model_call_policy_test_fail_receipt
BEFORE INSERT ON agent_controller.model_call_policy_requests
FOR EACH ROW EXECUTE FUNCTION agent_controller.model_call_policy_test_fail_receipt()`)
	require.NoError(t, err)
	return restore
}
