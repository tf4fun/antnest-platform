package postgres

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func modelPolicyLegacyMigrationAppliedAt(t *testing.T, ctx context.Context, store *Repository) time.Time {
	t.Helper()
	var appliedAt time.Time
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT applied_at
FROM agent_controller.schema_migrations WHERE version=32`).Scan(&appliedAt))
	return appliedAt
}

func runtimeBarrierPolicyAfterModelPolicyMigration(t *testing.T, ctx context.Context, store *Repository, before string) string {
	t.Helper()
	var expected string
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT jsonb_set(
jsonb_set($1::jsonb, '{synchronization,revision}',
    to_jsonb(($1::jsonb #>> '{synchronization,revision}')::bigint + 1), false),
'{synchronization,updated_at}', to_jsonb($2::timestamptz), false)::text`,
		before, modelPolicyLegacyMigrationAppliedAt(t, ctx, store)).Scan(&expected))
	return expected
}

func runtimeBarrierAdmissionAfterModelPolicyMigration(t *testing.T, ctx context.Context, store *Repository, before map[string]string) map[string]string {
	t.Helper()
	expected := make(map[string]string, len(before))
	for table, snapshot := range before {
		expected[table] = snapshot
	}
	synchronization, found := before["execution_configuration_sync"]
	require.True(t, found)
	var updated string
	require.NoError(t, store.pool.QueryRow(ctx, `WITH updated AS (
    SELECT jsonb_set(jsonb_set(resource, '{revision}',
        to_jsonb((resource->>'revision')::bigint + 1), false),
        '{updated_at}', to_jsonb($2::timestamptz), false) AS resource
    FROM jsonb_array_elements($1::jsonb) AS original(resource)
)
SELECT COALESCE(jsonb_agg(resource ORDER BY resource::text), '[]'::jsonb)::text
FROM updated`, synchronization, modelPolicyLegacyMigrationAppliedAt(t, ctx, store)).Scan(&updated))
	expected["execution_configuration_sync"] = updated
	return expected
}

func assertModelPolicyLegacyColumnsNull(t *testing.T, ctx context.Context, store *Repository) {
	t.Helper()
	var nullableColumns int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
WHERE table_schema='agent_controller' AND table_name='agent_template_revisions'
  AND column_name IN ('model_retry','failover','run_budget') AND is_nullable='YES'`).Scan(&nullableColumns))
	require.Equal(t, 3, nullableColumns)
	var revisions, legacyNulls int64
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (
WHERE model_retry IS NULL AND failover IS NULL AND run_budget IS NULL)
FROM agent_controller.agent_template_revisions`).Scan(&revisions, &legacyNulls))
	require.Equal(t, revisions, legacyNulls)
}
