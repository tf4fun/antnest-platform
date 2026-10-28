package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

const modelPolicyLegacyOrganization = "org-integration"
const modelPolicyMissingOrganization = "migration-without-sync"

func TestModelCallPolicyMigrationUpgrades0031WithoutRewritingHistory(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	store := modelPolicyMigrationPredecessor(t, ctx)
	seedModelPolicyMigrationHistory(t, ctx, store)
	before := modelPolicyMigrationBusinessSnapshot(t, ctx, store)
	journal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 31)
	synchronization := modelPolicyMigrationSynchronizations(t, ctx, store)
	assertModelPolicyMigrationColumns(t, ctx, store, false)

	require.NoError(t, store.Migrate(ctx))
	assertModelPolicyMigrationVersion(t, ctx, store, 32)
	assertModelPolicyMigrationColumns(t, ctx, store, true)
	require.Equal(t, before, modelPolicyMigrationBusinessSnapshot(t, ctx, store))
	require.Equal(t, journal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 31))
	assertModelPolicyMigrationAdvanced(t, ctx, store, synchronization)
	var revisions, legacyNulls int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (
WHERE model_retry IS NULL AND failover IS NULL AND run_budget IS NULL)
FROM agent_controller.agent_template_revisions`).Scan(&revisions, &legacyNulls))
	require.Equal(t, 2, revisions)
	require.Equal(t, revisions, legacyNulls)

	committed := modelPolicyMigrationSynchronizationSnapshot(t, ctx, store)
	committedJournal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 32)
	require.NoError(t, store.Migrate(ctx))
	require.Equal(t, committed, modelPolicyMigrationSynchronizationSnapshot(t, ctx, store))
	require.Equal(t, committedJournal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 32))
	require.Equal(t, before, modelPolicyMigrationBusinessSnapshot(t, ctx, store))
}

func TestModelCallPolicyMigrationConcurrentMigrateAdvancesEachOrganizationOnce(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	store := modelPolicyMigrationPredecessor(t, ctx)
	seedModelPolicyMigrationHistory(t, ctx, store)
	other := openRuntimeBarrierPolicyTestRepository(t, ctx)
	before := modelPolicyMigrationBusinessSnapshot(t, ctx, store)
	synchronization := modelPolicyMigrationSynchronizations(t, ctx, store)
	start := make(chan struct{})
	results := make(chan error, 2)
	var originals sync.WaitGroup
	for _, repository := range []*Repository{store, other} {
		originals.Add(1)
		go func(repository *Repository) {
			defer originals.Done()
			<-start
			results <- repository.Migrate(ctx)
		}(repository)
	}
	close(start)
	originals.Wait()
	close(results)
	for err := range results {
		require.NoError(t, err)
	}
	assertModelPolicyMigrationVersion(t, ctx, store, 32)
	assertModelPolicyMigrationAdvanced(t, ctx, store, synchronization)
	require.Equal(t, before, modelPolicyMigrationBusinessSnapshot(t, ctx, store))
	var entries int
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT count(*) FROM agent_controller.schema_migrations WHERE version=32").Scan(&entries))
	require.Equal(t, 1, entries)
}

func TestModelCallPolicyMigrationRevisionOverflowRollsBackTheWholeUpgrade(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	store := modelPolicyMigrationPredecessor(t, ctx)
	seedModelPolicyMigrationHistory(t, ctx, store)
	_, err := store.pool.Exec(ctx, "UPDATE agent_controller.execution_configuration_sync SET revision=$2 WHERE organization_id=$1", "migration-other", ports.MaximumExecutionRevision)
	require.NoError(t, err)
	before := modelPolicyMigrationBusinessSnapshot(t, ctx, store)
	synchronization := modelPolicyMigrationSynchronizationSnapshot(t, ctx, store)
	journal := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 32)
	schema := modelPolicyMigrationSchemaSnapshot(t, ctx, store)

	require.Error(t, store.Migrate(ctx), "an exhausted organization revision cannot be skipped or wrapped")
	assertModelPolicyMigrationVersion(t, ctx, store, 31)
	assertModelPolicyMigrationColumns(t, ctx, store, false)
	require.Equal(t, schema, modelPolicyMigrationSchemaSnapshot(t, ctx, store), "DDL must share the failed migration transaction")
	require.Equal(t, journal, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 32))
	require.Equal(t, synchronization, modelPolicyMigrationSynchronizationSnapshot(t, ctx, store))
	require.Equal(t, before, modelPolicyMigrationBusinessSnapshot(t, ctx, store))

	_, err = store.pool.Exec(ctx, "UPDATE agent_controller.execution_configuration_sync SET revision=9 WHERE organization_id=$1", "migration-other")
	require.NoError(t, err)
	safe := modelPolicyMigrationSynchronizations(t, ctx, store)
	require.NoError(t, store.Migrate(ctx), "a rolled-back upgrade can be retried after the original overflow is resolved")
	assertModelPolicyMigrationVersion(t, ctx, store, 32)
	assertModelPolicyMigrationAdvanced(t, ctx, store, safe)
	require.Equal(t, before, modelPolicyMigrationBusinessSnapshot(t, ctx, store))
}

func modelPolicyMigrationPredecessor(t *testing.T, ctx context.Context) *Repository {
	t.Helper()
	store := openRuntimeBarrierPolicyTestRepository(t, ctx)
	resetCatalogSchema(t, ctx, store)
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer rollbackModelPolicyMigrationTransaction(t, tx)
	_, err = tx.Exec(ctx, migrationJournalSQL)
	require.NoError(t, err)
	var installed bool
	for _, candidate := range schemaMigrations {
		if candidate.version > 31 {
			continue
		}
		_, err = tx.Exec(ctx, candidate.sql)
		require.NoError(t, err, "install actual predecessor migration %d", candidate.version)
		_, err = tx.Exec(ctx, "INSERT INTO agent_controller.schema_migrations(version,name,checksum) VALUES($1,$2,$3)", candidate.version, candidate.name, migrationChecksum(candidate.sql))
		require.NoError(t, err)
		installed = installed || candidate.version == 31
	}
	require.True(t, installed, "the fixture must install the real 0031 predecessor")
	require.NoError(t, tx.Commit(ctx))
	assertModelPolicyMigrationVersion(t, ctx, store, 31)
	return store
}

func seedModelPolicyMigrationHistory(t *testing.T, ctx context.Context, store *Repository) {
	t.Helper()
	model := integrationModelRecord(t)
	require.Equal(t, modelPolicyLegacyOrganization, model.OrganizationID)
	first := integrationTemplateRecord(t, model.Revision)
	second := integrationRevisedTemplateRecord(t, first, model.Revision)
	createdAt := time.Date(2026, time.September, 1, 1, 2, 3, 123456000, time.UTC)
	insertQueryAgent(t, ctx, store, "model-policy-legacy-agent", model.OrganizationID, "legacy-owner", domain.DesiredEnabled, domain.AgentCreated, createdAt)
	insertQueryAgent(t, ctx, store, "model-policy-missing-sync-agent", modelPolicyMissingOrganization, "missing-owner", domain.DesiredDisabled, domain.AgentCreated, createdAt)
	modelPayload, err := json.Marshal(model.Revision.Snapshot().Model.Parameters())
	require.NoError(t, err)
	tx, err := store.pool.Begin(ctx)
	require.NoError(t, err)
	defer rollbackModelPolicyMigrationTransaction(t, tx)
	// Insert only predecessor columns: the current Template writer will require
	// the new nullable columns once the producer implementation is present.
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.provider_connections
(id,organization_id,provider_key,display_name,base_url,credential_method,current_credential_version,credential_revision,ciphertext,nonce,key_version,created_at,updated_at)
VALUES($1,$2,'deepseek','Legacy Provider',$3,'api_key','legacy-credential',1,$4,$5,'legacy-key',$6,$6)`,
		model.ProviderConnectionID, model.OrganizationID, model.Revision.Snapshot().Model.BaseURL,
		[]byte("synthetic-legacy-ciphertext"), []byte("synthetic-legacy-nonce"), createdAt)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.model_profiles
(id,organization_id,profile_key,provider_connection_id,api_model_id,display_name,configuration_id,version,model,created_at,updated_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$10)`,
		model.ModelProfileID, model.OrganizationID, model.ProfileKey, model.ProviderConnectionID,
		model.Revision.Snapshot().Model.Model, model.DisplayName, model.Revision.ID(), model.Revision.Revision(), modelPayload, createdAt)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.agent_templates
(id,organization_id,template_key,name,current_revision,enabled,created_at,updated_at)
VALUES($1,$2,$3,$4,2,true,$5,$5)`, first.TemplateID, first.OrganizationID, first.TemplateKey, first.Name, createdAt)
	require.NoError(t, err)
	for index, record := range []ports.TemplateRecord{first, second} {
		snapshot := record.Revision.Snapshot()
		runtimePayload, err := json.Marshal(snapshot.Runtime)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `INSERT INTO agent_controller.agent_template_revisions
(template_id,organization_id,revision,model_profile_id,system_prompt,max_model_requests,context_policy_version,runtime_input,created_at)
VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
			record.TemplateID, record.OrganizationID, snapshot.Revision, snapshot.ModelProfileID,
			snapshot.SystemPrompt, snapshot.MaxModelRequests, snapshot.ContextPolicyVersion, runtimePayload, createdAt)
		require.NoError(t, err)
		spec, err := domain.MaterializeAgentSpec(record.Revision, model.Revision)
		require.NoError(t, err)
		payload := legacyModelPolicySpecJSON(t, spec.Snapshot())
		digest := sha256.Sum256(payload)
		revision := int64(index + 1)
		specID := fmt.Sprintf("model-policy-spec-%d", revision)
		executionID := fmt.Sprintf("model-policy-execution-%d", revision)
		runtimeRevision := fmt.Sprintf("model-policy-runtime-%d", revision)
		_, err = tx.Exec(ctx, `INSERT INTO agent_controller.agent_spec_revisions
(id,agent_id,revision,template_id,template_revision,model_profile_revision_id,canonical_digest,snapshot,created_at)
VALUES($1,'model-policy-legacy-agent',$2,$3,$4,$5,$6,$7::jsonb,$8)`,
			specID, revision, record.TemplateID, snapshot.Revision, model.Revision.ID(), hex.EncodeToString(digest[:]), payload, createdAt)
		require.NoError(t, err)
		_, err = tx.Exec(ctx, `INSERT INTO agent_controller.execution_revisions
(id,agent_id,revision,agent_spec_revision_id,runtime_revision,runtime_execution_id,runtime_mcp_endpoint,runtime_mcp_source_digest,change_summary,published_at)
VALUES($1,'model-policy-legacy-agent',$2,$3,$4,$5,'http://legacy-runtime.invalid/mcp',$6,'["model","runtime"]'::jsonb,$7)`,
			executionID, revision, specID, runtimeRevision, executionID, hex.EncodeToString(digest[:]), createdAt)
		require.NoError(t, err)
	}
	_, err = tx.Exec(ctx, `UPDATE agent_controller.agents
SET executable_spec_revision_id='model-policy-spec-2',executable_execution_revision_id='model-policy-execution-2',
last_successful_execution_revision_id='model-policy-execution-2',runtime_revision='model-policy-runtime-2',
runtime_execution_id='model-policy-execution-2',runtime_mcp_endpoint='http://legacy-runtime.invalid/mcp'
WHERE id='model-policy-legacy-agent'`)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.agent_access_bindings
(agent_id,principal_id,access_revision,active,created_at,updated_at)
VALUES('model-policy-legacy-agent','legacy-owner','access-model-policy-legacy-agent',true,$1,$1)`, createdAt)
	require.NoError(t, err)
	_, err = tx.Exec(ctx, `INSERT INTO agent_controller.execution_configuration_sync
(organization_id,revision,applied_revision,updated_at,applied_at) VALUES
($1,7,7,$2,$2),('migration-other',9,6,$2,$2),('migration-empty',1,0,$2,NULL),
('migration-near-maximum',$3,$4,$2,$2)`, model.OrganizationID, createdAt, ports.MaximumExecutionRevision-1, ports.MaximumExecutionRevision-2)
	require.NoError(t, err)
	require.NoError(t, tx.Commit(ctx))
}

func legacyModelPolicySpecJSON(t *testing.T, snapshot domain.AgentSpecSnapshot) []byte {
	t.Helper()
	encoded, err := json.Marshal(snapshot)
	require.NoError(t, err)
	var legacy map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(encoded, &legacy))
	for _, field := range []string{"model_retry", "failover", "run_budget"} {
		delete(legacy, field)
	}
	encoded, err = json.Marshal(legacy)
	require.NoError(t, err)
	return encoded
}

func rollbackModelPolicyMigrationTransaction(t *testing.T, tx *databaseTransaction) {
	t.Helper()
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := tx.Rollback(cleanup); err != nil && !errors.Is(err, pgx.ErrTxClosed) {
		t.Errorf("join original model policy migration transaction: %v", err)
	}
}

func assertModelPolicyMigrationVersion(t *testing.T, ctx context.Context, store *Repository, expected int64) {
	t.Helper()
	var version int64
	require.NoError(t, store.pool.QueryRow(ctx, "SELECT max(version) FROM agent_controller.schema_migrations").Scan(&version))
	require.Equal(t, expected, version)
}

func assertModelPolicyMigrationColumns(t *testing.T, ctx context.Context, store *Repository, installed bool) {
	t.Helper()
	var columns, nullable int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*),count(*) FILTER (WHERE is_nullable='YES')
FROM information_schema.columns WHERE table_schema='agent_controller' AND table_name='agent_template_revisions'
AND column_name IN ('model_retry','failover','run_budget')`).Scan(&columns, &nullable))
	if installed {
		require.Equal(t, 3, columns)
		require.Equal(t, 3, nullable)
	} else {
		require.Zero(t, columns)
	}
}

func modelPolicyMigrationSynchronizations(t *testing.T, ctx context.Context, store *Repository) map[string]ports.ExecutionSynchronization {
	t.Helper()
	organizations, err := store.ListExecutionOrganizations(ctx, "", 200)
	require.NoError(t, err)
	states := make(map[string]ports.ExecutionSynchronization, len(organizations))
	for _, organization := range organizations {
		state, err := store.GetExecutionSynchronization(ctx, organization)
		require.NoError(t, err)
		states[organization] = state
	}
	return states
}

func assertModelPolicyMigrationAdvanced(t *testing.T, ctx context.Context, store *Repository, before map[string]ports.ExecutionSynchronization) {
	t.Helper()
	after := modelPolicyMigrationSynchronizations(t, ctx, store)
	require.NotEmpty(t, before)
	require.NotContains(t, before, modelPolicyMissingOrganization)
	require.Len(t, after, len(before)+1)
	for organization, original := range before {
		current, ok := after[organization]
		require.True(t, ok, "existing organization %s disappeared", organization)
		require.Equal(t, original.Revision+1, current.Revision, organization)
		require.Equal(t, original.AppliedRevision, current.AppliedRevision, organization)
		require.Equal(t, original.AppliedAt, current.AppliedAt, organization)
	}
	missing, ok := after[modelPolicyMissingOrganization]
	require.True(t, ok)
	require.EqualValues(t, 1, missing.Revision)
	require.Zero(t, missing.AppliedRevision)
	require.Nil(t, missing.AppliedAt)
}

func modelPolicyMigrationBusinessSnapshot(t *testing.T, ctx context.Context, store *Repository) string {
	t.Helper()
	var snapshot string
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT jsonb_build_object(
'providers',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY id),'[]'::jsonb) FROM agent_controller.provider_connections p),
'models',(SELECT COALESCE(jsonb_agg(to_jsonb(m) ORDER BY id),'[]'::jsonb) FROM agent_controller.model_profiles m),
'templates',(SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) FROM agent_controller.agent_templates t),
'template_revisions',(SELECT COALESCE(jsonb_agg(to_jsonb(r)-'model_retry'-'failover'-'run_budget' ORDER BY template_id,revision),'[]'::jsonb) FROM agent_controller.agent_template_revisions r),
'agents',(SELECT COALESCE(jsonb_agg(to_jsonb(a) ORDER BY id),'[]'::jsonb) FROM agent_controller.agents a),
'agent_specs',(SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY id),'[]'::jsonb) FROM agent_controller.agent_spec_revisions s),
'executions',(SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY id),'[]'::jsonb) FROM agent_controller.execution_revisions e),
'access',(SELECT COALESCE(jsonb_agg(to_jsonb(b) ORDER BY agent_id),'[]'::jsonb) FROM agent_controller.agent_access_bindings b)
)::text`).Scan(&snapshot))
	return snapshot
}

func modelPolicyMigrationSynchronizationSnapshot(t *testing.T, ctx context.Context, store *Repository) string {
	t.Helper()
	var snapshot string
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT COALESCE(jsonb_agg(to_jsonb(s) ORDER BY organization_id),'[]'::jsonb)::text
FROM agent_controller.execution_configuration_sync s`).Scan(&snapshot))
	return snapshot
}

func modelPolicyMigrationSchemaSnapshot(t *testing.T, ctx context.Context, store *Repository) string {
	t.Helper()
	var snapshot string
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT jsonb_build_object(
'tables',(SELECT jsonb_agg(table_name ORDER BY table_name) FROM information_schema.tables WHERE table_schema='agent_controller'),
'columns',(SELECT jsonb_agg(jsonb_build_array(table_name,column_name,data_type,is_nullable,column_default) ORDER BY table_name,ordinal_position)
 FROM information_schema.columns WHERE table_schema='agent_controller')
)::text`).Scan(&snapshot))
	return snapshot
}
