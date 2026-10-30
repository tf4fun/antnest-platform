package postgres

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

func TestRuntimeBarrierRecoveryAdmissionMigrationUpgrades0027WithoutRewritingHistory(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	store := openRuntimeBarrierPolicyTestRepository(t, ctx)
	resetCatalogSchema(t, ctx, store)
	applyRuntimeBarrierPolicyLegacyMigrations(t, ctx, store)
	// Install the actual policy predecessor, without invoking the latest Migrate.
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback(ctx) }()
	var installed bool
	for _, candidate := range schemaMigrations {
		if candidate.version != 27 {
			continue
		}
		_, err = tx.Exec(ctx, candidate.sql)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, "INSERT INTO agent_controller.schema_migrations(version,name,checksum) VALUES($1,$2,$3)", candidate.version, candidate.name, migrationChecksum(candidate.sql))
		require.NoError(t, err)
		installed = true
	}
	require.True(t, installed)
	require.NoError(t, tx.Commit(ctx))
	insertQueryAgent(t, ctx, store, "migration-agent", "migration-org", "migration-owner",
		domain.DesiredDisabled, domain.AgentCreated, time.Unix(100, 0).UTC())
	_, err = store.pool.Exec(ctx, `INSERT INTO agent_controller.execution_configuration_sync
(organization_id,revision,applied_revision,updated_at,applied_at)
VALUES('migration-org',7,6,'2026-10-22T00:00:00Z','2026-10-21T23:59:00Z')`)
	require.NoError(t, err)
	policy, err := store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput("migration-org", "predecessor-policy", 0, "auto", 60000))
	require.NoError(t, err)
	beforeData := runtimeBarrierPolicyLegacySnapshot(t, ctx, store)
	beforeJournal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 27)
	var beforePolicy string
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT row_to_json(r)::text FROM agent_controller.runtime_barrier_recovery_policy_requests r WHERE request_id='predecessor-policy'").Scan(&beforePolicy))
	var version int64
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT max(version) FROM agent_controller.schema_migrations").Scan(&version))
	require.EqualValues(t, 27, version)
	var newTables int
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='agent_controller' AND table_name IN ('runtime_barrier_recovery_receipts','runtime_barrier_recovery_cooldowns','runtime_barrier_recovery_starts')").Scan(&newTables))
	require.Zero(t, newTables)
	require.NoError(t, store.Migrate(ctx))
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT max(version) FROM agent_controller.schema_migrations").Scan(&version))
	require.EqualValues(t, 35, version)
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT count(*) FROM information_schema.tables WHERE table_schema='agent_controller' AND table_name IN ('runtime_barrier_recovery_receipts','runtime_barrier_recovery_cooldowns','runtime_barrier_recovery_starts')").Scan(&newTables))
	require.Equal(t, 3, newTables)
	expectedData := runtimeBarrierPolicyAfterModelPolicyMigration(t, ctx, store, beforeData)
	require.Equal(t, expectedData, runtimeBarrierPolicyLegacySnapshot(t, ctx, store))
	assertModelPolicyLegacyColumnsNull(t, ctx, store)
	require.Equal(t, beforeJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 27))
	current, err := store.GetRuntimeBarrierRecoveryPolicy(ctx, "migration-org")
	require.NoError(t, err)
	require.Equal(t, policy, current)
	var afterPolicy string
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT row_to_json(r)::text FROM agent_controller.runtime_barrier_recovery_policy_requests r WHERE request_id='predecessor-policy'").Scan(&afterPolicy))
	require.Equal(t, beforePolicy, afterPolicy)
	journal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 32)
	require.NoError(t, store.Migrate(ctx))
	require.Equal(t, journal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 32))
	require.Equal(t, expectedData, runtimeBarrierPolicyLegacySnapshot(t, ctx, store))
	assertModelPolicyLegacyColumnsNull(t, ctx, store)
}
