package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/authfixture"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestControllerContractHygieneMigrationKeepsGlobalReplayKey(t *testing.T) {
	store := providerTestRepository(t)
	ctx := context.Background()

	var replayIndex *string
	require.NoError(t, store.pool.QueryRow(ctx,
		`SELECT to_regclass('agent_controller.agent_events_global_replay_idx')`).Scan(&replayIndex))
	require.Nil(t, replayIndex, "the redundant global replay index must be dropped")
	var primaryKey bool
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT EXISTS(
SELECT 1 FROM pg_constraint WHERE conname='agent_events_pkey' AND contype='p'
AND conrelid='agent_controller.agent_events'::regclass)`).Scan(&primaryKey))
	require.True(t, primaryKey, "agent_events global_sequence primary key must remain")

	var receipts int
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.schema_migrations
WHERE version=37 AND name='drop_redundant_event_replay_index'`).Scan(&receipts))
	require.Equal(t, 1, receipts)
	require.NoError(t, store.Migrate(ctx))
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT count(*) FROM agent_controller.schema_migrations
WHERE version=37`).Scan(&receipts))
	require.Equal(t, 1, receipts, "re-migrating must not record a second journal receipt")

	insertQueryAgent(t, ctx, store, "upgrade-agent", "upgrade-org", "upgrade-owner",
		domain.DesiredEnabled, domain.AgentCreated, time.Unix(100, 0).UTC())
	insertTestAgentEvent(t, ctx, store, testRepositoryEvent("upgrade-event-1", "upgrade-agent", 1, time.Unix(1000, 0).UTC()))
	journalBefore := runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 36)
	beforeEvents, err := store.ListAgentEvents(ctx, ports.AgentEventQuery{AgentID: "upgrade-agent", Limit: 5})
	require.NoError(t, err)
	require.Len(t, beforeEvents, 1)
	_, err = store.pool.Exec(ctx, `CREATE INDEX agent_events_global_replay_idx ON agent_controller.agent_events (global_sequence);
DELETE FROM agent_controller.schema_migrations WHERE version=37`)
	require.NoError(t, err)
	require.NoError(t, store.Migrate(ctx))
	var version int64
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT max(version) FROM agent_controller.schema_migrations`).Scan(&version))
	require.EqualValues(t, 37, version)
	require.NoError(t, store.pool.QueryRow(ctx,
		`SELECT to_regclass('agent_controller.agent_events_global_replay_idx')`).Scan(&replayIndex))
	require.Nil(t, replayIndex, "upgrading from the 36 prefix must drop the redundant index")
	require.Equal(t, journalBefore, runtimeBarrierPolicyMigrationSnapshot(t, ctx, store, 36),
		"journal through 36 must be unchanged by the upgrade")
	afterEvents, err := store.ListAgentEvents(ctx, ports.AgentEventQuery{AgentID: "upgrade-agent", Limit: 5})
	require.NoError(t, err)
	require.Equal(t, beforeEvents, afterEvents, "preserved events keep payload and sequence")
}

func TestControllerContractHygieneReplayPlannerUsesPrimaryKey(t *testing.T) {
	store := providerTestRepository(t)
	ctx := context.Background()
	now := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC)
	insertQueryAgent(t, ctx, store, "replay-agent", "replay-org", "replay-owner",
		domain.DesiredEnabled, domain.AgentCreated, now)
	for i := int64(1); i <= 2000; i++ {
		insertTestAgentEvent(t, ctx, store, testRepositoryEvent(
			fmt.Sprintf("replay-event-%d", i), "replay-agent", i, now.Add(time.Second*time.Duration(i))))
	}
	for _, table := range []string{"agent_events", "agents"} {
		_, err := store.pool.Exec(ctx, `ANALYZE agent_controller.`+table)
		require.NoError(t, err)
	}

	var rawPlan []byte
	require.NoError(t, store.pool.QueryRow(ctx,
		`EXPLAIN (FORMAT JSON, COSTS OFF) `+agentEventSelect+` WHERE event.global_sequence > $1 ORDER BY event.global_sequence LIMIT $2`,
		int64(1000), 10).Scan(&rawPlan))
	t.Logf("global replay plan: %s", rawPlan)
	var plan any
	require.NoError(t, json.Unmarshal(rawPlan, &plan))
	require.True(t, replayPlanUsesIndex(plan, "agent_events_pkey"),
		"global replay must scan agent_events_pkey: %s", rawPlan)

	events, err := store.ListAgentEvents(ctx, ports.AgentEventQuery{AfterSequence: 1000, Limit: 10})
	require.NoError(t, err)
	require.Len(t, events, 10)
	for i, event := range events {
		require.EqualValues(t, 1001+int64(i), event.GlobalSequence)
	}
}

func replayPlanUsesIndex(node any, index string) bool {
	switch value := node.(type) {
	case map[string]any:
		if name, ok := value["Index Name"].(string); ok && name == index {
			return true
		}
		for _, child := range value {
			if replayPlanUsesIndex(child, index) {
				return true
			}
		}
	case []any:
		for _, child := range value {
			if replayPlanUsesIndex(child, index) {
				return true
			}
		}
	}
	return false
}

const controllerHygieneErrorURI = "https://schemas.antnest.dev/agent-controller/control-api.schema.json#/$defs/error"
const controllerHygienePolicyURI = "https://schemas.antnest.dev/skill-learning/learning-api.schema.json#/$defs/policy"

func controllerHygieneSchemaCompiler(t *testing.T) *jsonschema.Compiler {
	t.Helper()
	compiler := jsonschema.NewCompiler()
	for _, resource := range []string{
		"common/error.schema.json",
		"agent-controller/control-api.schema.json",
		"skill-learning/learning-api.schema.json",
	} {
		payload, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "..", "contracts", resource))
		require.NoError(t, err)
		document, err := jsonschema.UnmarshalJSON(bytes.NewReader(payload))
		require.NoError(t, err)
		require.NoError(t, compiler.AddResource("https://schemas.antnest.dev/"+resource, document))
	}
	return compiler
}

func TestControllerContractHygieneSchemasResolveWithoutDatabase(t *testing.T) {
	compiler := controllerHygieneSchemaCompiler(t)
	for _, uri := range []string{controllerHygieneErrorURI, controllerHygienePolicyURI} {
		definition, err := compiler.Compile(uri)
		require.NoError(t, err, uri)
		require.NotNil(t, definition, uri)
	}
}

func TestControllerContractHygienePolicyHTTPPersistsDistinctConflicts(t *testing.T) {
	repository, base := identityTestRepository(t)
	identity := &offboardingIdentity{principal: ports.IdentityPrincipal{UserID: base.Agent.OwnerUserID,
		OrganizationID: base.Agent.OrganizationID, MembershipID: "member", Active: true}}
	unused := &unusedCatalogDependencies{}
	boundary, err := authfixture.NewHandler(t, nilCatalog{}, unused, unused, unused, unused, unused,
		repository.Ping, application.NewSkillLearningPolicyService(repository, identity))
	require.NoError(t, err)

	compiler := controllerHygieneSchemaCompiler(t)
	validate := func(uri string, body []byte) {
		t.Helper()
		definition, err := compiler.Compile(uri)
		require.NoError(t, err)
		instance, err := jsonschema.UnmarshalJSON(bytes.NewReader(body))
		require.NoError(t, err)
		require.NoError(t, definition.Validate(instance), "%s", body)
	}
	const errorURI = controllerHygieneErrorURI
	const policyURI = controllerHygienePolicyURI

	readPolicy := func() map[string]any {
		t.Helper()
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet,
			"/internal/agents/"+base.Agent.AgentID+"/skill-learning-policy?organization_id="+
				base.Agent.OrganizationID+"&principal_id="+base.Agent.OwnerUserID, nil))
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		validate(policyURI, response.Body.Bytes())
		var policy map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &policy))
		return policy
	}
	mutate := func(requestID, versionKey, revision, mode string) *httptest.ResponseRecorder {
		t.Helper()
		body := fmt.Sprintf(`{"request_id":%q,"organization_id":%q,"actor_principal_id":%q,%q:%q,"mode":%q,`+
			`"scope":{"auto_generated_personal":true,"adopted_paths":[]},"pinned_paths":[],`+
			`"limits":{"daily_reviews":20,"daily_model_input_tokens":320000,"daily_model_output_tokens":80000}}`,
			requestID, base.Agent.OrganizationID, base.Agent.OwnerUserID, versionKey, revision, mode)
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, httptest.NewRequest(http.MethodPut,
			"/internal/agents/"+base.Agent.AgentID+"/skill-learning-policy", strings.NewReader(body)))
		return response
	}
	assertConflict := func(response *httptest.ResponseRecorder, code string) {
		t.Helper()
		require.Equal(t, http.StatusConflict, response.Code, response.Body.String())
		require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
		validate(errorURI, response.Body.Bytes())
		var envelope map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &envelope))
		require.Equal(t, code, envelope["code"], "%s", response.Body.String())
		require.Equal(t, "conflict", envelope["category"], "%s", response.Body.String())
		require.Equal(t, false, envelope["retryable"], "%s", response.Body.String())
		require.NotEmpty(t, envelope["message"], "%s", response.Body.String())
		require.NotEmpty(t, envelope["request_id"], "%s", response.Body.String())
		require.Equal(t, response.Header().Get("X-Request-ID"), envelope["request_id"],
			"%s", response.Body.String())
	}
	decodePolicy := func(response *httptest.ResponseRecorder) map[string]any {
		t.Helper()
		validate(policyURI, response.Body.Bytes())
		var policy map[string]any
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &policy))
		return policy
	}

	current := readPolicy()
	updated := mutate("conflict-1", "expected_version", current["revision"].(string), "off")
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	applied := decodePolicy(updated)

	replayed := mutate("conflict-1", "expected_version", current["revision"].(string), "off")
	require.Equal(t, http.StatusOK, replayed.Code, replayed.Body.String())
	require.Equal(t, applied, decodePolicy(replayed), "exact replay returns the same policy without a new revision")

	changed := mutate("conflict-1", "expected_version", current["revision"].(string), "automatic")
	assertConflict(changed, "request_id_conflict")

	stale := mutate("conflict-2", "expected_version", current["revision"].(string), "off")
	assertConflict(stale, "policy_revision_conflict")

	legacy := mutate("conflict-1", "expected_revision", current["revision"].(string), "off")
	require.Equal(t, http.StatusOK, legacy.Code, legacy.Body.String())
	require.Equal(t, applied, decodePolicy(legacy), "the deprecated alias replays the same receipt")

	require.Equal(t, applied, readPolicy(), "both rejections must leave the persisted policy unchanged")
}
