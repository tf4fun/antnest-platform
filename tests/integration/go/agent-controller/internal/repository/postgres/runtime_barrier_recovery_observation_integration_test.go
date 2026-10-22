package postgres

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

// PostgreSQL, candidate enumeration, Skill intent persistence and recovery
// admission are real. ACP's observation and RC's Skill-ready response are the
// only synthetic boundaries; no Temporal, Runtime or Egress service is started.
func TestRuntimeBarrierRecoveryObservationPGAvailableCandidateAdmitsOnceAcrossReopen(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "observation-original-e\u0301-🧪\x00barrier", "protected-original-execution-🧪")
	require.Equal(t, domain.RuntimeAvailable, fixture.base.Agent.RuntimeState)
	require.True(t, fixture.base.Agent.CanObserveRuntime())
	require.NotEqual(t, fixture.base.Agent.RuntimeExecutionID, fixture.begin.Recovery.Fact.Barrier.RuntimeExecutionID,
		"the retained barrier execution is not required to equal current Runtime health")
	beforeCounts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	beforeSkills := runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store)
	calls := &runtimeBarrierObservationPGCalls{}
	store := &runtimeBarrierObservationPGStore{Repository: fixture.store, calls: calls}
	reader := &runtimeBarrierObservationPGReader{calls: calls, fact: fixture.begin.Recovery.Fact}
	client := &runtimeBarrierRecoveryApplicationSkillClient{}
	admitter := runtimeBarrierObservationPGAdmission(fixture.store, fixture.begin.Now, client, calls)
	worker := newRuntimeBarrierObservationPGWorker(t, store, reader, admitter)

	require.NoError(t, worker.RunOnce(ctx))

	observed := calls.snapshot()
	require.Equal(t, []ports.AgentQuery{runtimeBarrierObservationPGQuery()}, observed.lists,
		"the real Agent query must include available Agents rather than filter Runtime state")
	require.Len(t, observed.listedAgents, 1)
	require.Equal(t, fixture.base.Agent.AgentID, observed.listedAgents[0].AgentID)
	require.Equal(t, domain.RuntimeAvailable, observed.listedAgents[0].RuntimeState)
	require.Equal(t, []string{fixture.base.Agent.AgentID}, observed.bases)
	require.Equal(t, []ports.RuntimeBarrierQuery{runtimeBarrierObservationPGBarrierQuery(fixture)}, observed.queries)
	require.Equal(t, []string{fixture.base.Agent.OrganizationID}, observed.policyOrganizations)
	require.Equal(t, []ports.RuntimeBarrierRecoveryIntent{*fixture.begin.Recovery}, observed.intents)
	require.Len(t, observed.results, 1)
	require.NoError(t, observed.errors[0])
	accepted := observed.results[0]
	require.False(t, accepted.Replayed)
	assertOneRuntimeBarrierAdmission(t, ctx, fixture, beforeCounts)
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	assertRuntimeBarrierAdmissionReceipt(t, fixture, accepted.State, original)
	require.Equal(t, original, accepted.Receipt)
	require.Equal(t, domain.OperationRunning, accepted.State.Operation.State)
	require.Equal(t, domain.PhaseDrain, accepted.State.Operation.Phase)
	require.Equal(t, original.Command.RequestID, accepted.State.Agent.ActiveOperationRequestID)
	assertRuntimeBarrierRecoveryApplicationSkillIntent(t, ctx, fixture, accepted.State, client, beforeSkills)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, original)
	var startedAt *time.Time
	require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT started_at
FROM agent_controller.runtime_barrier_recovery_starts WHERE request_id=$1`, original.Command.RequestID).Scan(&startedAt))
	require.Nil(t, startedAt, "observation accepts a pending command without starting or confirming a workflow")
	countsAfterAdmission := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
	metadataAfterAdmission := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	fixture.store.Close()

	// Reopen the actual pool without calling the seed/reset helper a second time.
	// The new worker has no in-memory cursor or original-worker result to reuse.
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	restartedCalls := &runtimeBarrierObservationPGCalls{}
	restartedStore := &runtimeBarrierObservationPGStore{Repository: reopened, calls: restartedCalls}
	restartedReader := &runtimeBarrierObservationPGReader{calls: restartedCalls, fact: fixture.begin.Recovery.Fact}
	restartedClient := &runtimeBarrierRecoveryApplicationSkillClient{}
	restartedAdmitter := runtimeBarrierObservationPGAdmission(reopened, fixture.begin.Now.Add(time.Hour), restartedClient, restartedCalls)
	restartedWorker := newRuntimeBarrierObservationPGWorker(t, restartedStore, restartedReader, restartedAdmitter)

	require.NoError(t, restartedWorker.RunOnce(ctx))

	restarted := restartedCalls.snapshot()
	require.Equal(t, []ports.AgentQuery{runtimeBarrierObservationPGQuery()}, restarted.lists)
	require.Len(t, restarted.listedAgents, 1, "the active Agent remains in the real created/enabled query")
	require.Equal(t, original.Command.RequestID, restarted.listedAgents[0].ActiveOperationRequestID)
	require.Empty(t, restarted.queries, "a persisted active lifecycle prevents a new ACP observation")
	require.Empty(t, restarted.intents, "an active original operation is not re-admitted")
	require.Empty(t, restartedClient.prepares)
	require.Equal(t, 0, restartedClient.queries)
	require.Equal(t, 0, restartedClient.releases)
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, reopened, original)
	require.Equal(t, countsAfterAdmission, readRuntimeBarrierAdmissionCounts(t, ctx, reopened, fixture.base.Agent.AgentID))
	require.Equal(t, metadataAfterAdmission, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened),
		"restart preserves every Controller row, including receipt, Skill intent, cooldown and pending command")
}

func TestRuntimeBarrierRecoveryObservationPGTransactionRejectsInterveningPolicyAndOwnerBinding(t *testing.T) {
	for _, change := range []string{"auto policy becomes manual", "active owner binding becomes inactive"} {
		t.Run(change, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "observed-before-state-change-🧪", "protected-before-state-change-🧪")
			beforeCounts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
			beforeSkills := runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store)
			beforeCore := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
			require.Zero(t, beforeCounts.operations)
			require.Zero(t, beforeCounts.receipts)
			require.Zero(t, beforeCounts.cooldowns)
			require.Zero(t, beforeCounts.starts)
			calls := &runtimeBarrierObservationPGCalls{}
			store := &runtimeBarrierObservationPGStore{Repository: fixture.store, calls: calls}
			reader := &runtimeBarrierObservationPGReader{calls: calls, fact: fixture.begin.Recovery.Fact}
			client := &runtimeBarrierRecoveryApplicationSkillClient{}
			admitter := runtimeBarrierObservationPGAdmission(fixture.store, fixture.begin.Now, client, calls)
			changed := false
			admitter.before = func(ctx context.Context, intent ports.RuntimeBarrierRecoveryIntent) error {
				observed := calls.snapshot()
				if len(observed.lists) != 1 || len(observed.bases) != 1 || len(observed.queries) != 1 || len(observed.policyOrganizations) != 1 {
					return fmt.Errorf("intervening mutation requires completed real candidate, base, barrier and policy reads")
				}
				if change == "auto policy becomes manual" {
					_, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
						fixture.base.Agent.OrganizationID, "observation-policy-now-manual", intent.ExpectedPolicyRevision, "manual", 60000))
					if err != nil {
						return err
					}
				} else {
					// This fixture-only SQL changes the actual binding while leaving
					// Agent CAS and owner/revocation sequence fields untouched.
					result, err := fixture.store.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings
SET active=false, updated_at=clock_timestamp()
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 AND active`,
						fixture.base.Agent.AgentID, fixture.base.Agent.OwnerUserID, fixture.base.Agent.AccessRevision)
					if err != nil {
						return err
					}
					if result.RowsAffected() != 1 {
						return fmt.Errorf("owner binding fixture did not change exactly one current row")
					}
				}
				changed = true
				return nil
			}
			worker := newRuntimeBarrierObservationPGWorker(t, store, reader, admitter)

			err := worker.RunOnce(ctx)

			require.True(t, changed, "the actual database change must precede the real admission service")
			require.ErrorIs(t, err, ports.ErrConcurrentChange)
			require.NotErrorIs(t, err, ports.ErrInvalidRuntimeBarrierRecovery)
			observed := calls.snapshot()
			require.Equal(t, []ports.RuntimeBarrierRecoveryIntent{*fixture.begin.Recovery}, observed.intents)
			require.Len(t, observed.errors, 1)
			require.ErrorIs(t, observed.errors[0], ports.ErrConcurrentChange)
			require.Equal(t, beforeCounts, readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID))
			receipt, found, readErr := fixture.store.ReplayRuntimeBarrierRecovery(ctx,
				fixture.base.Agent.OrganizationID, fixture.base.Agent.AgentID, fixture.begin.Recovery.Fact.Barrier.BarrierID)
			require.NoError(t, readErr)
			require.False(t, found)
			require.Equal(t, ports.RuntimeBarrierRecoveryReceipt{}, receipt)
			pending, readErr := fixture.store.ListPendingRuntimeBarrierRecoveryStarts(ctx, "", 10)
			require.NoError(t, readErr)
			require.Empty(t, pending)
			currentBase, readErr := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
			require.NoError(t, readErr)
			require.Equal(t, fixture.base.Agent, currentBase.Agent,
				"a rejected recovery cannot alter Agent CAS, Runtime binding or lifecycle ownership")
			afterCore := runtimeBarrierAdmissionSnapshot(t, ctx, fixture.store)
			for table, original := range beforeCore {
				if change == "auto policy becomes manual" && table == "runtime_barrier_recovery_policies" {
					continue
				}
				require.Equal(t, original, afterCore[table], "rejected admission changed core table %s", table)
			}
			currentPolicy, readErr := fixture.store.GetRuntimeBarrierRecoveryPolicy(ctx, fixture.base.Agent.OrganizationID)
			require.NoError(t, readErr)
			if change == "auto policy becomes manual" {
				require.Equal(t, "manual", currentPolicy.Mode)
				require.Equal(t, fixture.policy.Revision+1, currentPolicy.Revision)
			} else {
				require.Equal(t, fixture.policy, currentPolicy)
				var active bool
				require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT active FROM agent_controller.agent_access_bindings
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3`, fixture.base.Agent.AgentID,
					fixture.base.Agent.OwnerUserID, fixture.base.Agent.AccessRevision).Scan(&active))
				require.False(t, active)
			}
			// Preparation deliberately precedes the guarded Begin transaction.
			// These are not full-database-unchanged assertions: the real prepared
			// Skill intent and the injected policy/binding mutation remain durable.
			require.Equal(t, beforeSkills+1, runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store))
			intent, readErr := fixture.store.GetSkillPreparationIntent(ctx, fixture.begin.Operation.RequestID)
			require.NoError(t, readErr)
			require.Equal(t, "ready", intent.State)
			require.Len(t, client.prepares, 1)
			require.Equal(t, 0, client.queries)
			require.Equal(t, 0, client.releases)
		})
	}
}

func TestRuntimeBarrierRecoveryObservationPGCancellationJoinsActualHeldReaderWithoutAdmission(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "held-observation-barrier-🧪", "held-original-execution-🧪")
	before := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	calls := &runtimeBarrierObservationPGCalls{}
	store := &runtimeBarrierObservationPGStore{Repository: fixture.store, calls: calls}
	client := &runtimeBarrierRecoveryApplicationSkillClient{}
	admitter := runtimeBarrierObservationPGAdmission(fixture.store, fixture.begin.Now, client, calls)
	reader := &runtimeBarrierObservationPGReader{calls: calls, fact: fixture.begin.Recovery.Fact}
	started, cancellationSeen := make(chan struct{}), make(chan struct{})
	released, dependencyReturned, joined := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var startOnce, cancellationOnce, releaseOnce, returnedOnce sync.Once
	release := func() { releaseOnce.Do(func() { close(released) }) }
	reader.returned = func() { returnedOnce.Do(func() { close(dependencyReturned) }) }
	reader.hold = func(ctx context.Context) {
		startOnce.Do(func() { close(started) })
		select {
		case <-ctx.Done():
			cancellationOnce.Do(func() { close(cancellationSeen) })
			<-released
		case <-released:
		}
	}
	worker := newRuntimeBarrierObservationPGWorker(t, store, reader, admitter)
	caller, cancel := context.WithCancel(ctx)
	results := make(chan error, 1)
	// Registered after the repository owner: release and actual dependency/worker
	// joins must happen before its pool is closed, including assertion failures.
	t.Cleanup(func() {
		cancel()
		release()
		cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		select {
		case <-joined:
		case <-cleanup.Done():
			t.Error("owned observation worker did not join after reader release")
		}
		select {
		case <-started:
			select {
			case <-dependencyReturned:
			case <-cleanup.Done():
				t.Error("actual held ACP reader did not return after release")
			}
		default:
		}
	})
	go func() { defer close(joined); results <- worker.RunOnce(caller) }()
	select {
	case <-started:
	case <-joined:
		t.Fatalf("observation returned before the actual reader started: %v", <-results)
	case <-ctx.Done():
		t.Fatal("observation did not reach the actual held reader")
	}
	observed := calls.snapshot()
	require.Equal(t, []ports.AgentQuery{runtimeBarrierObservationPGQuery()}, observed.lists)
	require.Equal(t, []string{fixture.base.Agent.AgentID}, observed.bases)
	require.Equal(t, []ports.RuntimeBarrierQuery{runtimeBarrierObservationPGBarrierQuery(fixture)}, observed.queries)
	require.Empty(t, observed.intents)
	cancel()
	runtimeBarrierObservationPGAwait(t, ctx, cancellationSeen, "the actual held reader did not receive cancellation")
	// This timer observes only forbidden early completion. Success below requires
	// explicit callback-return and RunOnce-join channels, never elapsed time.
	guard := time.NewTimer(50 * time.Millisecond)
	select {
	case <-joined:
		guard.Stop()
		t.Fatal("observation returned while its original ACP query was still held")
	case <-guard.C:
	}
	release()
	joinContext, stop := context.WithTimeout(context.Background(), 10*time.Second)
	defer stop()
	runtimeBarrierObservationPGAwait(t, joinContext, dependencyReturned, "actual ACP reader did not settle after release")
	runtimeBarrierObservationPGAwait(t, joinContext, joined, "observation worker did not join its actual ACP reader")
	require.ErrorIs(t, <-results, context.Canceled)
	require.Empty(t, calls.snapshot().intents, "a late matching barrier is not permission to admit after cancellation")
	require.Empty(t, client.prepares)
	require.Equal(t, before, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store),
		"candidate and ACP observation reads leave every Controller table unchanged")
}

func runtimeBarrierObservationPGQuery() ports.AgentQuery {
	return ports.AgentQuery{LifecycleState: domain.AgentCreated, ActivationState: domain.ActivationEnabled, Limit: 10}
}

func runtimeBarrierObservationPGBarrierQuery(fixture runtimeBarrierAdmissionFixture) ports.RuntimeBarrierQuery {
	return ports.RuntimeBarrierQuery{OrganizationID: fixture.base.Agent.OrganizationID,
		AgentID: fixture.base.Agent.AgentID, ExpectedRuntimeRevision: fixture.base.Agent.RuntimeRevision}
}

type runtimeBarrierObservationPGAdmissionPort interface {
	Admit(context.Context, ports.RuntimeBarrierRecoveryIntent) (application.RuntimeBarrierRecoveryAdmissionResult, error)
}

func newRuntimeBarrierObservationPGWorker(t *testing.T, store *runtimeBarrierObservationPGStore, reader ports.RuntimeBarrierReader,
	admitter runtimeBarrierObservationPGAdmissionPort,
) *application.RuntimeBarrierRecoveryObservationWorker {
	t.Helper()
	worker, err := application.NewRuntimeBarrierRecoveryObservationWorker(store, reader, admitter,
		application.RuntimeBarrierRecoveryObservationSchedule{PollInterval: time.Second, RoundTimeout: 10 * time.Second, BatchSize: 10},
		slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	require.NotNil(t, worker)
	return worker
}

type runtimeBarrierObservationPGSnapshot struct {
	lists               []ports.AgentQuery
	listedAgents        []ports.AgentRecord
	bases               []string
	policyOrganizations []string
	queries             []ports.RuntimeBarrierQuery
	intents             []ports.RuntimeBarrierRecoveryIntent
	results             []application.RuntimeBarrierRecoveryAdmissionResult
	errors              []error
}

type runtimeBarrierObservationPGCalls struct {
	mu    sync.Mutex
	state runtimeBarrierObservationPGSnapshot
}

func (calls *runtimeBarrierObservationPGCalls) snapshot() runtimeBarrierObservationPGSnapshot {
	calls.mu.Lock()
	defer calls.mu.Unlock()
	return runtimeBarrierObservationPGSnapshot{lists: slices.Clone(calls.state.lists), listedAgents: slices.Clone(calls.state.listedAgents),
		bases: slices.Clone(calls.state.bases), policyOrganizations: slices.Clone(calls.state.policyOrganizations),
		queries: slices.Clone(calls.state.queries), intents: slices.Clone(calls.state.intents),
		results: slices.Clone(calls.state.results), errors: slices.Clone(calls.state.errors)}
}

type runtimeBarrierObservationPGStore struct {
	*Repository
	calls *runtimeBarrierObservationPGCalls
}

func (store *runtimeBarrierObservationPGStore) ListAgents(ctx context.Context, query ports.AgentQuery) ([]ports.AgentRecord, error) {
	rows, err := store.Repository.ListAgents(ctx, query)
	store.calls.mu.Lock()
	store.calls.state.lists = append(store.calls.state.lists, query)
	store.calls.state.listedAgents = append(store.calls.state.listedAgents, rows...)
	store.calls.mu.Unlock()
	return rows, err
}

func (store *runtimeBarrierObservationPGStore) GetAgentLifecycleBase(ctx context.Context, agentID string) (ports.AgentLifecycleBase, error) {
	base, err := store.Repository.GetAgentLifecycleBase(ctx, agentID)
	store.calls.mu.Lock()
	store.calls.state.bases = append(store.calls.state.bases, agentID)
	store.calls.mu.Unlock()
	return base, err
}

func (store *runtimeBarrierObservationPGStore) GetRuntimeBarrierRecoveryPolicy(ctx context.Context, organizationID string) (domain.RuntimeBarrierRecoveryPolicy, error) {
	policy, err := store.Repository.GetRuntimeBarrierRecoveryPolicy(ctx, organizationID)
	store.calls.mu.Lock()
	store.calls.state.policyOrganizations = append(store.calls.state.policyOrganizations, organizationID)
	store.calls.mu.Unlock()
	return policy, err
}

type runtimeBarrierObservationPGReader struct {
	calls    *runtimeBarrierObservationPGCalls
	fact     ports.RuntimeBarrierResult
	hold     func(context.Context)
	returned func()
}

func (reader *runtimeBarrierObservationPGReader) GetRuntimeBarrier(ctx context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
	if reader.returned != nil {
		defer reader.returned()
	}
	reader.calls.mu.Lock()
	reader.calls.state.queries = append(reader.calls.state.queries, query)
	reader.calls.mu.Unlock()
	if reader.hold != nil {
		reader.hold(ctx)
	}
	// Return the original matching fact even after cancellation. The worker must
	// wait for this real callback and reject its late apparent success itself.
	fact := reader.fact
	if fact.Barrier != nil {
		barrier := *fact.Barrier
		fact.Barrier = &barrier
	}
	return fact, nil
}

type runtimeBarrierObservationPGAdmitter struct {
	service *application.RuntimeBarrierRecoveryAdmissionService
	calls   *runtimeBarrierObservationPGCalls
	before  func(context.Context, ports.RuntimeBarrierRecoveryIntent) error
}

func runtimeBarrierObservationPGAdmission(store *Repository, now time.Time, client *runtimeBarrierRecoveryApplicationSkillClient,
	calls *runtimeBarrierObservationPGCalls,
) *runtimeBarrierObservationPGAdmitter {
	lifecycle := application.NewLifecycleService(store, store, nil, nil, &catalogStateClock{now: now},
		application.WithSkillPreparation(store, client))
	return &runtimeBarrierObservationPGAdmitter{service: application.NewRuntimeBarrierRecoveryAdmissionService(lifecycle, store), calls: calls}
}

func (admitter *runtimeBarrierObservationPGAdmitter) Admit(ctx context.Context, intent ports.RuntimeBarrierRecoveryIntent) (application.RuntimeBarrierRecoveryAdmissionResult, error) {
	admitter.calls.mu.Lock()
	admitter.calls.state.intents = append(admitter.calls.state.intents, intent)
	admitter.calls.mu.Unlock()
	var result application.RuntimeBarrierRecoveryAdmissionResult
	var err error
	if admitter.before != nil {
		err = admitter.before(ctx, intent)
	}
	if err == nil {
		result, err = admitter.service.Admit(ctx, intent)
	}
	admitter.calls.mu.Lock()
	admitter.calls.state.results = append(admitter.calls.state.results, result)
	admitter.calls.state.errors = append(admitter.calls.state.errors, err)
	admitter.calls.mu.Unlock()
	return result, err
}

func runtimeBarrierObservationPGAwait(t *testing.T, ctx context.Context, receipt <-chan struct{}, message string) {
	t.Helper()
	select {
	case <-receipt:
	case <-ctx.Done():
		t.Fatal(message)
	}
}
