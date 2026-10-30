package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestRuntimeBarrierRecoveryPolicyAbsentReadDoesNotPersistDefaults(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 0, 0)
	for range 2 {
		policy, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, "policy-org")
		require.NoError(t, err)
		require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
			OrganizationID: "policy-org", Revision: 0, Mode: "manual", CooldownMS: 300000,
		}, policy)
		assertRuntimeBarrierPolicyRows(t, ctx, store, 0, 0)
	}
}

func TestRuntimeBarrierRecoveryPolicyOriginalReceiptSurvivesLaterWritesAndReopen(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	firstInput := runtimeBarrierPolicyTestInput("policy-org", "policy-first", 0, "auto", 60000)
	first, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, firstInput)
	require.NoError(t, err)
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: firstInput.OrganizationID, Revision: 1, Mode: "auto", CooldownMS: 60000,
	}, first)
	secondInput := runtimeBarrierPolicyTestInput("policy-org", "policy-second", 1, "notify", 86400000)
	second, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, secondInput)
	require.NoError(t, err)
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: secondInput.OrganizationID, Revision: 2, Mode: "notify", CooldownMS: 86400000,
	}, second)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 2)

	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	replayed, err := reopened.SetRuntimeBarrierRecoveryPolicy(ctx, firstInput)
	require.NoError(t, err)
	require.Equal(t, first, replayed, "a stale original request returns its original receipt")
	current, err := reopened.GetRuntimeBarrierRecoveryPolicy(ctx, firstInput.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, second, current, "replaying revision one must not overwrite revision two")

	for _, field := range []string{"mode", "cooldown", "actor", "expected-revision"} {
		changed := firstInput
		switch field {
		case "mode":
			changed.Mode = "manual"
		case "cooldown":
			changed.CooldownMS = 300000
		case "actor":
			changed.ActorPrincipalID = "another-admin"
		case "expected-revision":
			changed.ExpectedRevision = 1
		}
		_, err = reopened.SetRuntimeBarrierRecoveryPolicy(ctx, changed)
		require.ErrorIs(t, err, ports.ErrRequestConflict, "changed original request must be checked before its stale CAS: %s", field)
	}
	stale := firstInput
	stale.RequestID = "policy-new-stale"
	_, err = reopened.SetRuntimeBarrierRecoveryPolicy(ctx, stale)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	current, err = reopened.GetRuntimeBarrierRecoveryPolicy(ctx, firstInput.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, second, current)
	assertRuntimeBarrierPolicyRows(t, ctx, reopened, 1, 2)

	var receipt domain.RuntimeBarrierRecoveryPolicy
	var fingerprint string
	err = reopened.pool.QueryRow(ctx, `SELECT organization_id, result_revision, result_mode,
result_cooldown_ms, request_fingerprint
FROM agent_controller.runtime_barrier_recovery_policy_requests
WHERE organization_id=$1 AND request_id=$2`, firstInput.OrganizationID, firstInput.RequestID).Scan(
		&receipt.OrganizationID, &receipt.Revision, &receipt.Mode, &receipt.CooldownMS, &fingerprint,
	)
	require.NoError(t, err)
	require.Equal(t, first, receipt)
	require.Regexp(t, `^[0-9a-f]{64}$`, fingerprint)
}

func TestRuntimeBarrierRecoveryPolicySameRequestIDIsIndependentAcrossOrganizations(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	for _, input := range []ports.SetRuntimeBarrierRecoveryPolicy{
		runtimeBarrierPolicyTestInput("policy-org-a", "shared-request", 0, "auto", 60000),
		runtimeBarrierPolicyTestInput("policy-org-b", "shared-request", 0, "manual", 300000),
	} {
		written, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, input)
		require.NoError(t, err)
		require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
			OrganizationID: input.OrganizationID, Revision: 1, Mode: input.Mode, CooldownMS: input.CooldownMS,
		}, written)
		replayed, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, input)
		require.NoError(t, err)
		require.Equal(t, written, replayed)
		current, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, input.OrganizationID)
		require.NoError(t, err)
		require.Equal(t, written, current)
	}
	assertRuntimeBarrierPolicyRows(t, ctx, store, 2, 2)
}

func TestRuntimeBarrierRecoveryPolicyConcurrentFirstCASAcceptsOneRequest(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	inputs := []ports.SetRuntimeBarrierRecoveryPolicy{
		runtimeBarrierPolicyTestInput("policy-org", "concurrent-first-a", 0, "auto", 60000),
		runtimeBarrierPolicyTestInput("policy-org", "concurrent-first-b", 0, "notify", 86400000),
	}
	results := runRuntimeBarrierPolicyTestRequests(ctx, []*Repository{store, other}, inputs)
	var winner domain.RuntimeBarrierRecoveryPolicy
	accepted, conflicts := 0, 0
	for index, result := range results {
		if result.err == nil {
			accepted++
			winner = result.policy
			require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
				OrganizationID: inputs[index].OrganizationID, Revision: 1,
				Mode: inputs[index].Mode, CooldownMS: inputs[index].CooldownMS,
			}, result.policy)
		} else {
			require.ErrorIs(t, result.err, ports.ErrConcurrentChange)
			conflicts++
		}
	}
	require.Equal(t, 1, accepted)
	require.Equal(t, 1, conflicts)
	current, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, "policy-org")
	require.NoError(t, err)
	require.Equal(t, winner, current)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 1)
}

func TestRuntimeBarrierRecoveryPolicyConcurrentIdenticalRequestsCommitOneReceipt(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	input := runtimeBarrierPolicyTestInput("policy-org", "concurrent-same", 0, "auto", 300000)
	results := runRuntimeBarrierPolicyTestRequests(ctx,
		[]*Repository{store, other},
		[]ports.SetRuntimeBarrierRecoveryPolicy{input, input, input, input},
	)
	expected := domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: input.OrganizationID, Revision: 1, Mode: input.Mode, CooldownMS: input.CooldownMS,
	}
	for _, result := range results {
		require.NoError(t, result.err)
		require.Equal(t, expected, result.policy)
	}
	current, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, input.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, expected, current)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 1)
}

func TestRuntimeBarrierRecoveryPolicyReceiptFailureRollsBackPolicy(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "first-policy"
		if existing {
			name = "existing-policy"
		}
		t.Run(name, func(t *testing.T) {
			store := providerTestRepository(t)
			ctx := runtimeBarrierPolicyTestContext(t)
			before := domain.RuntimeBarrierRecoveryPolicy{
				OrganizationID: "policy-org", Revision: 0, Mode: "manual", CooldownMS: 300000,
			}
			var policies, receipts int64
			if existing {
				var err error
				before, err = store.SetRuntimeBarrierRecoveryPolicy(ctx,
					runtimeBarrierPolicyTestInput("policy-org", "before-receipt-fault", 0, "auto", 60000))
				require.NoError(t, err)
				policies, receipts = 1, 1
			}
			restore := installRuntimeBarrierPolicyReceiptFailure(t, ctx, store)
			input := runtimeBarrierPolicyTestInput("policy-org", "faulted-receipt", before.Revision, "notify", 86400000)
			_, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, input)
			var databaseError *pgconn.PgError
			require.ErrorAs(t, err, &databaseError, "the actual receipt INSERT must reach the injected PostgreSQL failure")
			require.Equal(t, "P0001", databaseError.Code)
			current, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, input.OrganizationID)
			require.NoError(t, err)
			require.Equal(t, before, current)
			assertRuntimeBarrierPolicyRows(t, ctx, store, policies, receipts)

			require.NoError(t, restore())
			written, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, input)
			require.NoError(t, err, "the same request succeeds after the fault is removed")
			require.Equal(t, before.Revision+1, written.Revision)
			require.Equal(t, input.Mode, written.Mode)
			assertRuntimeBarrierPolicyRows(t, ctx, store, 1, receipts+1)
		})
	}
}

func TestRuntimeBarrierRecoveryPolicyStorageFailureNeverReturnsAnAbsentDefault(t *testing.T) {
	t.Run("actual-query-error", func(t *testing.T) {
		store := providerTestRepository(t)
		ctx := runtimeBarrierPolicyTestContext(t)
		_, err := store.pool.Exec(ctx, `ALTER TABLE agent_controller.runtime_barrier_recovery_policies
RENAME TO runtime_barrier_recovery_policies_test_unavailable`)
		require.NoError(t, err)
		restore := func() error {
			cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_, failure := store.pool.Exec(cleanup, `ALTER TABLE IF EXISTS agent_controller.runtime_barrier_recovery_policies_test_unavailable
RENAME TO runtime_barrier_recovery_policies`)
			return failure
		}
		t.Cleanup(func() { require.NoError(t, restore(), "restore the owned policy table") })
		policy, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, "policy-org")
		var databaseError *pgconn.PgError
		require.ErrorAs(t, err, &databaseError)
		require.Equal(t, "42P01", databaseError.Code)
		require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{}, policy)
		require.NoError(t, restore())
		policy, err = store.GetRuntimeBarrierRecoveryPolicy(ctx, "policy-org")
		require.NoError(t, err)
		require.EqualValues(t, 0, policy.Revision)
		require.Equal(t, "manual", policy.Mode)
		assertRuntimeBarrierPolicyRows(t, ctx, store, 0, 0)
	})
	t.Run("closed-owned-pool", func(t *testing.T) {
		store := providerTestRepository(t)
		ctx := runtimeBarrierPolicyTestContext(t)
		store.Close()
		policy, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, "policy-org")
		require.Error(t, err)
		require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{}, policy)
	})
}

func TestRuntimeBarrierRecoveryPolicyMigrationUpgrades0026AndPreservesExistingData(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	store := openRuntimeBarrierPolicyTestRepository(t, ctx)
	resetCatalogSchema(t, ctx, store)
	applyRuntimeBarrierPolicyLegacyMigrations(t, ctx, store)
	var version int64
	err := store.pool.QueryRow(ctx, `SELECT max(version) FROM agent_controller.schema_migrations`).Scan(&version)
	require.NoError(t, err)
	require.EqualValues(t, 26, version)
	var policyTables int
	err = store.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.tables
WHERE table_schema='agent_controller' AND table_name IN
('runtime_barrier_recovery_policies','runtime_barrier_recovery_policy_requests')`).Scan(&policyTables)
	require.NoError(t, err)
	require.Zero(t, policyTables)
	insertQueryAgent(t, ctx, store, "migration-agent", "migration-org", "migration-owner",
		domain.DesiredDisabled, domain.AgentCreated, time.Unix(100, 0).UTC())
	_, err = store.pool.Exec(ctx, `INSERT INTO agent_controller.execution_configuration_sync
(organization_id, revision, applied_revision, updated_at, applied_at)
VALUES ('migration-org',7,6,'2026-10-22T00:00:00Z','2026-10-21T23:59:00Z')`)
	require.NoError(t, err)
	legacyData := runtimeBarrierPolicyLegacySnapshot(t, ctx, store)
	legacyJournal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 26)

	require.NoError(t, store.Migrate(ctx))
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT max(version) FROM agent_controller.schema_migrations`).Scan(&version))
	require.EqualValues(t, 35, version)
	expectedData := runtimeBarrierPolicyAfterModelPolicyMigration(t, ctx, store, legacyData)
	require.Equal(t, expectedData, runtimeBarrierPolicyLegacySnapshot(t, ctx, store))
	assertModelPolicyLegacyColumnsNull(t, ctx, store)
	require.Equal(t, legacyJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 26))
	var applied int
	err = store.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.schema_migrations WHERE version=27`).Scan(&applied)
	require.NoError(t, err)
	require.Equal(t, 1, applied)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 0, 0)
	journal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 9007199254740991)
	require.NoError(t, store.Migrate(ctx))
	require.Equal(t, journal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 9007199254740991))
	require.Equal(t, expectedData, runtimeBarrierPolicyLegacySnapshot(t, ctx, store))
	assertModelPolicyLegacyColumnsNull(t, ctx, store)
	policy, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, "migration-org")
	require.NoError(t, err)
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: "migration-org", Revision: 0, Mode: "manual", CooldownMS: 300000,
	}, policy)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 0, 0)
}

func TestRuntimeBarrierRecoveryPolicyTablesRejectInvalidTypedValues(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	_, err := store.SetRuntimeBarrierRecoveryPolicy(ctx,
		runtimeBarrierPolicyTestInput("constraint-org", "constraint-parent", 0, "manual", 300000))
	require.NoError(t, err)
	for _, scenario := range []struct {
		name     string
		revision int64
		mode     string
		cooldown int64
	}{
		{"zero-revision", 0, "manual", 300000},
		{"negative-revision", -1, "manual", 300000},
		{"unsafe-revision", 9007199254740992, "manual", 300000},
		{"unknown-mode", 1, "automatic", 300000},
		{"short-cooldown", 1, "manual", 59999},
		{"long-cooldown", 1, "manual", 86400001},
	} {
		t.Run("policy/"+scenario.name, func(t *testing.T) {
			_, failure := store.pool.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_policies
(organization_id,revision,mode,cooldown_ms) VALUES ($1,$2,$3,$4)`,
				"invalid-policy-"+scenario.name, scenario.revision, scenario.mode, scenario.cooldown)
			var databaseError *pgconn.PgError
			require.ErrorAs(t, failure, &databaseError)
			require.Equal(t, "23514", databaseError.Code, "must fail a value constraint, not another database operation")
		})
		t.Run("receipt/"+scenario.name, func(t *testing.T) {
			_, failure := store.pool.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_policy_requests
(organization_id,request_id,request_fingerprint,result_revision,result_mode,result_cooldown_ms)
VALUES ($1,$2,$3,$4,$5,$6)`, "constraint-org", "invalid-receipt-"+scenario.name,
				strings.Repeat("a", 64), scenario.revision, scenario.mode, scenario.cooldown)
			var databaseError *pgconn.PgError
			require.ErrorAs(t, failure, &databaseError)
			require.Equal(t, "23514", databaseError.Code, "must fail a value constraint, not a key conflict")
		})
	}
	t.Run("receipt/invalid-fingerprint", func(t *testing.T) {
		_, failure := store.pool.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_policy_requests
(organization_id,request_id,request_fingerprint,result_revision,result_mode,result_cooldown_ms)
VALUES ('constraint-org','invalid-fingerprint',$1,1,'manual',300000)`, strings.Repeat("g", 64))
		var databaseError *pgconn.PgError
		require.ErrorAs(t, failure, &databaseError)
		require.Equal(t, "23514", databaseError.Code)
	})
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 1)
}

func runtimeBarrierPolicyTestContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func runtimeBarrierPolicyTestInput(org, request string, revision int64, mode string, cooldown int64) ports.SetRuntimeBarrierRecoveryPolicy {
	return ports.SetRuntimeBarrierRecoveryPolicy{
		RequestID: request, OrganizationID: org, ActorPrincipalID: "policy-admin",
		ExpectedRevision: revision, Mode: mode, CooldownMS: cooldown,
	}
}

func openRuntimeBarrierPolicyTestRepository(t *testing.T, ctx context.Context) *Repository {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	store, err := Open(ctx, databaseURL)
	require.NoError(t, err)
	t.Cleanup(store.Close)
	return store
}

func assertRuntimeBarrierPolicyRows(t *testing.T, ctx context.Context, store *Repository, policies, receipts int64) {
	t.Helper()
	var policyCount, receiptCount int64
	err := store.pool.QueryRow(ctx, `SELECT
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_policies),
(SELECT count(*) FROM agent_controller.runtime_barrier_recovery_policy_requests)`).Scan(&policyCount, &receiptCount)
	require.NoError(t, err)
	require.Equal(t, policies, policyCount)
	require.Equal(t, receipts, receiptCount)
}

type runtimeBarrierPolicyTestResult struct {
	policy domain.RuntimeBarrierRecoveryPolicy
	err    error
}

func runRuntimeBarrierPolicyTestRequests(ctx context.Context, stores []*Repository, inputs []ports.SetRuntimeBarrierRecoveryPolicy) []runtimeBarrierPolicyTestResult {
	results := make([]runtimeBarrierPolicyTestResult, len(inputs))
	start := make(chan struct{})
	var ready, joined sync.WaitGroup
	ready.Add(len(inputs))
	joined.Add(len(inputs))
	for index, input := range inputs {
		go func(index int, input ports.SetRuntimeBarrierRecoveryPolicy) {
			defer joined.Done()
			ready.Done()
			<-start
			results[index].policy, results[index].err = stores[index%len(stores)].SetRuntimeBarrierRecoveryPolicy(ctx, input)
		}(index, input)
	}
	ready.Wait()
	close(start)
	joined.Wait()
	return results
}

func installRuntimeBarrierPolicyReceiptFailure(t *testing.T, ctx context.Context, store *Repository) func() error {
	t.Helper()
	_, err := store.pool.Exec(ctx, `CREATE FUNCTION agent_controller.runtime_barrier_policy_test_fail_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION USING ERRCODE='P0001', MESSAGE='injected policy receipt failure';
END;
$$`)
	require.NoError(t, err)
	restore := func() error {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, triggerError := store.pool.Exec(cleanup, `DROP TRIGGER IF EXISTS runtime_barrier_policy_test_fail_receipt
ON agent_controller.runtime_barrier_recovery_policy_requests`)
		_, functionError := store.pool.Exec(cleanup, `DROP FUNCTION IF EXISTS agent_controller.runtime_barrier_policy_test_fail_receipt()`)
		return errors.Join(triggerError, functionError)
	}
	t.Cleanup(func() { require.NoError(t, restore(), "remove the owned PostgreSQL receipt fault") })
	_, err = store.pool.Exec(ctx, `CREATE TRIGGER runtime_barrier_policy_test_fail_receipt
BEFORE INSERT ON agent_controller.runtime_barrier_recovery_policy_requests
FOR EACH ROW EXECUTE FUNCTION agent_controller.runtime_barrier_policy_test_fail_receipt()`)
	require.NoError(t, err)
	return restore
}

func applyRuntimeBarrierPolicyLegacyMigrations(t *testing.T, ctx context.Context, store *Repository) {
	t.Helper()
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if failure := tx.Rollback(cleanup); failure != nil && !errors.Is(failure, pgx.ErrTxClosed) {
			t.Errorf("release owned historical migration transaction: %v", failure)
		}
	}()
	_, err = tx.Exec(ctx, migrationJournalSQL)
	require.NoError(t, err)
	for _, candidate := range schemaMigrations {
		if candidate.version > 26 {
			continue
		}
		_, err = tx.Exec(ctx, candidate.sql)
		require.NoError(t, err, "apply actual historical migration %d", candidate.version)
		_, err = tx.Exec(ctx, `INSERT INTO agent_controller.schema_migrations (version,name,checksum)
VALUES ($1,$2,$3)`, candidate.version, candidate.name, migrationChecksum(candidate.sql))
		require.NoError(t, err)
	}
	require.NoError(t, tx.Commit(ctx))
}

func runtimeBarrierPolicyLegacySnapshot(t *testing.T, ctx context.Context, store *Repository) string {
	t.Helper()
	var snapshot string
	err := store.pool.QueryRow(ctx, `SELECT jsonb_build_object('agent',to_jsonb(a),'synchronization',to_jsonb(s))::text
FROM agent_controller.agents a JOIN agent_controller.execution_configuration_sync s
ON s.organization_id=a.organization_id WHERE a.id='migration-agent'`).Scan(&snapshot)
	require.NoError(t, err)
	return snapshot
}

func runtimeBarrierPolicyMigrationSnapshot(t *testing.T, ctx context.Context, store *Repository, through int64) string {
	t.Helper()
	var snapshot string
	err := store.pool.QueryRow(ctx, `SELECT jsonb_agg(jsonb_build_array(version,name,checksum) ORDER BY version)::text
FROM agent_controller.schema_migrations WHERE version <= $1`, through).Scan(&snapshot)
	require.NoError(t, err)
	return snapshot
}

func TestRuntimeBarrierRecoveryPolicyMaximumSafeRevisionCommitsOnceAndReplays(t *testing.T) {
	store := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	const organization = "policy-maximum-safe"
	_, err := store.pool.Exec(ctx, `INSERT INTO agent_controller.runtime_barrier_recovery_policies
(organization_id,revision,mode,cooldown_ms) VALUES ($1,$2,'manual',300000)`,
		organization, domain.RuntimeBarrierRecoveryMaxRevision-1)
	require.NoError(t, err)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 0)

	input := runtimeBarrierPolicyTestInput(organization, "last-safe-policy-request",
		domain.RuntimeBarrierRecoveryMaxRevision-1, "auto", 60000)
	written, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, input)
	require.NoError(t, err)
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: organization, Revision: domain.RuntimeBarrierRecoveryMaxRevision,
		Mode: "auto", CooldownMS: 60000,
	}, written)
	assertRuntimeBarrierPolicyRows(t, ctx, store, 1, 1)

	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	next := runtimeBarrierPolicyTestInput(organization, "exhausted-policy-request",
		domain.RuntimeBarrierRecoveryMaxRevision, "notify", 86400000)
	_, err = reopened.SetRuntimeBarrierRecoveryPolicy(ctx, next)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	assertRuntimeBarrierPolicyRows(t, ctx, reopened, 1, 1)
	current, err := reopened.GetRuntimeBarrierRecoveryPolicy(ctx, organization)
	require.NoError(t, err)
	require.Equal(t, written, current)

	replayed, err := reopened.SetRuntimeBarrierRecoveryPolicy(ctx, input)
	require.NoError(t, err, "the original receipt must precede the exhausted current CAS")
	require.Equal(t, written, replayed)
	current, err = reopened.GetRuntimeBarrierRecoveryPolicy(ctx, organization)
	require.NoError(t, err)
	require.Equal(t, written, current)
	assertRuntimeBarrierPolicyRows(t, ctx, reopened, 1, 1)
}

func TestRuntimeBarrierRecoveryPolicyCancellationJoinsAnObservedOrganizationLockWait(t *testing.T) {
	observer := providerTestRepository(t)
	ctx := runtimeBarrierPolicyTestContext(t)
	worker := runtimeBarrierPolicySingleConnectionTestRepository(t, ctx)
	holder := openRuntimeBarrierPolicyTestRepository(t, ctx)
	const organization = "policy-cancelled-lock"
	const applicationName = "antnest-runtime-barrier-policy-cancel-test"
	var workerPID int32
	require.NoError(t, worker.pool.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&workerPID))
	require.Positive(t, workerPID)
	require.Zero(t, worker.pool.Stat().AcquiredConns())

	lock, err := holder.pool.Begin(ctx)
	require.NoError(t, err)
	mutationContext, cancelMutation := context.WithTimeout(ctx, 5*time.Second)
	returned := make(chan struct{})
	results := make(chan runtimeBarrierPolicyTestResult, 1)
	started, released := false, false
	releaseHolder := func() error {
		if released {
			return nil
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		failure := lock.Rollback(cleanup)
		if failure == nil || errors.Is(failure, pgx.ErrTxClosed) {
			released = true
			return nil
		}
		return failure
	}
	waitReturned := func(budget time.Duration) bool {
		timer := time.NewTimer(budget)
		defer timer.Stop()
		select {
		case <-returned:
			return true
		case <-timer.C:
			return false
		}
	}
	t.Cleanup(func() {
		cancelMutation()
		if failure := releaseHolder(); failure != nil {
			t.Errorf("release the owned policy advisory-lock transaction: %v", failure)
		}
		if !started || waitReturned(3*time.Second) {
			return
		}
		t.Error("the actual policy mutation did not join after cancellation and holder release")
		// Only the dedicated, previously identified fixture backend is eligible
		// for this failure-path fallback. Normal assertions run before it.
		cleanup, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		var terminated bool
		failure := observer.pool.QueryRow(cleanup, `SELECT pg_terminate_backend(pid)
FROM pg_stat_activity WHERE pid=$1 AND datname=current_database() AND application_name=$2`,
			workerPID, applicationName).Scan(&terminated)
		cancel()
		if failure != nil && !errors.Is(failure, pgx.ErrNoRows) {
			t.Errorf("terminate the owned policy fixture backend: %v", failure)
		} else if failure == nil && !terminated {
			t.Error("the owned policy fixture backend could not be terminated")
		}
		if !waitReturned(5 * time.Second) {
			t.Error("the actual policy mutation did not join after terminating its owned backend")
		}
	})
	_, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock($1,hashtext($2))`,
		runtimeBarrierPolicyOrganizationLockNamespace, organization)
	require.NoError(t, err)
	var holderPID int32
	require.NoError(t, lock.QueryRow(ctx, "SELECT pg_backend_pid()").Scan(&holderPID))
	require.NotEqual(t, workerPID, holderPID)
	input := runtimeBarrierPolicyTestInput(organization, "cancelled-policy-request", 0, "auto", 60000)
	started = true
	go func() {
		defer close(returned)
		policy, failure := worker.SetRuntimeBarrierRecoveryPolicy(mutationContext, input)
		results <- runtimeBarrierPolicyTestResult{policy: policy, err: failure}
	}()

	waitContext, stopWaiting := context.WithTimeout(ctx, 3*time.Second)
	defer stopWaiting()
	awaitRuntimeBarrierPolicyDatabaseCondition(t, waitContext, "actual Set never waited on the owned organization advisory lock", func(queryContext context.Context) (bool, error) {
		select {
		case <-returned:
			return false, errors.New("the actual mutation returned before an observed advisory-lock wait")
		default:
		}
		var waiting bool
		failure := observer.pool.QueryRow(queryContext, `SELECT EXISTS (
 SELECT 1 FROM pg_stat_activity activity JOIN pg_locks waiting_lock ON waiting_lock.pid=activity.pid
 WHERE activity.pid=$1 AND activity.datname=current_database()
   AND activity.application_name=$2 AND activity.state='active'
   AND activity.xact_start IS NOT NULL AND activity.wait_event_type='Lock'
   AND waiting_lock.locktype='advisory' AND NOT waiting_lock.granted
   AND waiting_lock.classid::bigint=$3
   AND waiting_lock.objid::bigint=(hashtext($4)::bigint & 4294967295)
   AND waiting_lock.objsubid=2 AND $5=ANY(pg_blocking_pids(activity.pid))
   AND EXISTS (SELECT 1 FROM pg_locks request_lock WHERE request_lock.pid=activity.pid
     AND request_lock.locktype='advisory' AND request_lock.granted
     AND request_lock.classid::bigint=$6)
)`, workerPID, applicationName, runtimeBarrierPolicyOrganizationLockNamespace,
			organization, holderPID, runtimeBarrierPolicyRequestLockNamespace).Scan(&waiting)
		return waiting, failure
	})
	cancelMutation()
	require.True(t, waitReturned(5*time.Second), "the actual Set must join while the test holder still owns its lock")
	result := <-results
	require.ErrorIs(t, result.err, context.Canceled)
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{}, result.policy)
	// pgxpool releases a cancelled connection to asynchronous destruction.
	// Admission requires actual release, not a same-stack pool-stat snapshot.
	awaitRuntimeBarrierPolicyDatabaseCondition(t, ctx, "cancelled Set retained a backend transaction or advisory lock", func(queryContext context.Context) (bool, error) {
		var transactions, advisoryLocks int
		failure := observer.pool.QueryRow(queryContext, `SELECT
 (SELECT count(*) FROM pg_stat_activity WHERE pid=$1 AND xact_start IS NOT NULL),
 (SELECT count(*) FROM pg_locks WHERE pid=$1 AND locktype='advisory')`, workerPID).Scan(&transactions, &advisoryLocks)
		return transactions == 0 && advisoryLocks == 0 && worker.pool.Stat().AcquiredConns() == 0, failure
	})
	assertRuntimeBarrierPolicyRows(t, ctx, observer, 0, 0)
	require.NoError(t, releaseHolder())

	// A different Repository/pool must be able to admit an independent request.
	next := runtimeBarrierPolicyTestInput(organization, "after-cancelled-policy-request", 0, "notify", 86400000)
	written, err := observer.SetRuntimeBarrierRecoveryPolicy(ctx, next)
	require.NoError(t, err)
	require.Equal(t, domain.RuntimeBarrierRecoveryPolicy{
		OrganizationID: organization, Revision: 1, Mode: "notify", CooldownMS: 86400000,
	}, written)
	var cancelledReceipts int
	require.NoError(t, observer.pool.QueryRow(ctx, `SELECT count(*)
FROM agent_controller.runtime_barrier_recovery_policy_requests WHERE organization_id=$1 AND request_id=$2`,
		organization, input.RequestID).Scan(&cancelledReceipts))
	require.Zero(t, cancelledReceipts)
	assertRuntimeBarrierPolicyRows(t, ctx, observer, 1, 1)
	for _, repository := range []*Repository{worker, holder, observer} {
		require.Zero(t, repository.pool.Stat().AcquiredConns())
	}
}

func runtimeBarrierPolicySingleConnectionTestRepository(t *testing.T, ctx context.Context) *Repository {
	t.Helper()
	configuration, err := pgxpool.ParseConfig(os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL"))
	require.NoError(t, err)
	configuration.MaxConns, configuration.MinConns = 1, 0
	configuration.ConnConfig.Tracer = newDatabaseTracer()
	configuration.ConnConfig.RuntimeParams["search_path"] = "agent_controller,public"
	configuration.ConnConfig.RuntimeParams["application_name"] = "antnest-runtime-barrier-policy-cancel-test"
	configuration.ConnConfig.RuntimeParams["statement_timeout"] = "10000"
	pool, err := pgxpool.NewWithConfig(ctx, configuration)
	require.NoError(t, err)
	repository := &Repository{pool: &databasePool{pool}}
	t.Cleanup(repository.Close)
	require.NoError(t, repository.Ping(ctx))
	return repository
}

func awaitRuntimeBarrierPolicyDatabaseCondition(t *testing.T, ctx context.Context, message string, condition func(context.Context) (bool, error)) {
	t.Helper()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		ready, err := condition(ctx)
		require.NoError(t, err, message)
		if ready {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal(message, ctx.Err())
		}
	}
}
