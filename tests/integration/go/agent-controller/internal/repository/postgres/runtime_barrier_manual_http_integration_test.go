package postgres

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/server"
)

func TestRuntimeBarrierManualHTTPAcceptsOriginalRecoveryAcrossPolicies(t *testing.T) {
	for _, mode := range []string{"manual", "notify", "auto"} {
		t.Run(mode, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "manual-http-\x00-original-"+mode+"-🧪", "original-protected-execution-🧪")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, mode)
			fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
			before := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)
			beforeSkills := runtimeBarrierRecoveryApplicationSkillCount(t, ctx, fixture.store)
			reader := &runtimeBarrierManualHTTPReader{fact: fixture.begin.Recovery.Fact}
			client := &runtimeBarrierRecoveryApplicationSkillClient{}
			auth := newRuntimeBarrierPolicyHTTPAuthentication(t)
			endpoint := newRuntimeBarrierManualHTTPServer(t, fixture, auth.security, reader, client)
			input := runtimeBarrierManualHTTPInput(fixture)

			response := runtimeBarrierManualHTTPPost(t, ctx, endpoint, input,
				runtimeBarrierManualHTTPBody(t, input), auth.tokens["admin-console"], runtimeBarrierManualHTTPCCT(t, auth, input, nil))

			operation := decodeRuntimeBarrierManualHTTPSuccess(t, response)
			assertOneRuntimeBarrierAdmission(t, ctx, fixture, before)
			receipt := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
			state, found, err := fixture.store.ReplayAgentRebuild(ctx, receipt.Command.RequestID, receipt.RequestFingerprint)
			require.NoError(t, err)
			require.True(t, found)
			assertRuntimeBarrierAdmissionReceipt(t, fixture, state, receipt)
			require.True(t, receipt.Manual, "the HTTP recovery extension must not fall through to ordinary Rebuild")
			require.Equal(t, "admin-1", receipt.Command.ActorPrincipalID)
			require.Equal(t, mode, receipt.Policy.Mode)
			require.Equal(t, domain.OperationRebuild, operation.Kind)
			require.Equal(t, domain.OperationRunning, operation.State)
			require.Equal(t, domain.PhaseDrain, operation.Phase)
			assertRuntimeBarrierManualHTTPOperation(t, state.Operation, operation)
			assertRuntimeBarrierManualTestRow(t, ctx, fixture.store, receipt.Command.RequestID, true)
			assertRuntimeBarrierManualHTTPCooldown(t, ctx, fixture.store, receipt)
			assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, receipt)
			assertRuntimeBarrierRecoveryApplicationSkillIntent(t, ctx, fixture, state, client, beforeSkills)
			require.Equal(t, []ports.RuntimeBarrierQuery{{
				OrganizationID: input.Command.OrganizationID, AgentID: input.Command.AgentID,
				ExpectedRuntimeRevision: input.ExpectedRuntimeRevision,
			}}, reader.querySnapshot())
		})
	}
}

func TestRuntimeBarrierManualHTTPReopenReplaysOriginalWithCurrentAuthorization(t *testing.T) {
	ctx := runtimeBarrierPolicyTestContext(t)
	fixture := runtimeBarrierAdmissionSeed(t, ctx, "manual-http-durable-original", "original-protected-execution")
	fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "manual")
	fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
	reader := &runtimeBarrierManualHTTPReader{fact: fixture.begin.Recovery.Fact}
	client := &runtimeBarrierRecoveryApplicationSkillClient{}
	auth := newRuntimeBarrierPolicyHTTPAuthentication(t)
	endpoint := newRuntimeBarrierManualHTTPServer(t, fixture, auth.security, reader, client)
	input := runtimeBarrierManualHTTPInput(fixture)
	body := runtimeBarrierManualHTTPBody(t, input)
	originalCCT := runtimeBarrierManualHTTPCCT(t, auth, input, nil)
	originalOperation := decodeRuntimeBarrierManualHTTPSuccess(t,
		runtimeBarrierManualHTTPPost(t, ctx, endpoint, input, body, auth.tokens["admin-console"], originalCCT))
	original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
	require.True(t, original.Manual)
	assertRuntimeBarrierManualHTTPCooldown(t, ctx, fixture.store, original)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, fixture.store, original)
	require.Len(t, reader.querySnapshot(), 1)
	require.Len(t, client.prepares, 1)

	changedPolicy, err := fixture.store.SetRuntimeBarrierRecoveryPolicy(ctx, runtimeBarrierPolicyTestInput(
		fixture.base.Agent.OrganizationID, "manual-http-new-policy", fixture.policy.Revision, "auto", 60000,
	))
	require.NoError(t, err)
	beforeReplay := runtimeBarrierRecoveryApplicationSnapshot(t, ctx, fixture.store)
	endpoint.close()
	fixture.store.Close()
	reopened := openRuntimeBarrierPolicyTestRepository(t, ctx)
	restartedFixture := fixture
	restartedFixture.store = reopened
	reader.setFailure(errors.New("ACP must not be queried for the original durable tuple"))
	restartedClient := &runtimeBarrierRecoveryApplicationSkillClient{err: errors.New("RC preparation must not run for original replay")}
	restarted := newRuntimeBarrierManualHTTPServer(t, restartedFixture, auth.security, reader, restartedClient)

	replayed := decodeRuntimeBarrierManualHTTPSuccess(t,
		runtimeBarrierManualHTTPPost(t, ctx, restarted, input, body, auth.tokens["admin-console"], originalCCT))
	require.Equal(t, originalOperation, replayed)
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
	require.Equal(t, beforeReplay, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened))
	require.Len(t, reader.querySnapshot(), 1, "reopening must not lose the original-receipt fast path")
	require.Empty(t, restartedClient.prepares)
	assertRuntimeBarrierManualHTTPCooldown(t, ctx, reopened, original)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, reopened, original)
	currentPolicy, err := reopened.GetRuntimeBarrierRecoveryPolicy(ctx, input.Command.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, changedPolicy, currentPolicy, "replay returns the original operation without restoring its frozen policy")

	for _, scenario := range []struct {
		name   string
		token  string
		cct    string
		status int
		code   string
	}{
		{"administrator-role-removed", auth.tokens["admin-console"], runtimeBarrierManualHTTPCCT(t, auth, input, map[string]any{"sys_role": "user", "org_role": "member"}), 403, "forbidden"},
		{"cross-organization", auth.tokens["admin-console"], runtimeBarrierManualHTTPCCT(t, auth, input, map[string]any{"org": "other-organization"}), 403, "organization_mismatch"},
		{"missing-CCT", auth.tokens["admin-console"], "", 401, "caller_context_required"},
		{"foreign-workload", auth.tokens["agent-ui"], originalCCT, 403, "caller_not_allowed"},
		{"missing-workload", "", originalCCT, 401, "service_unauthenticated"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			// Every denial repeats the exact bytes that already have a durable
			// recovery receipt. A receipt never replaces current authorization.
			response := runtimeBarrierManualHTTPPost(t, ctx, restarted, input, body, scenario.token, scenario.cct)
			assertRuntimeBarrierPolicyHTTPError(t, response, scenario.status, scenario.code)
			require.Equal(t, beforeReplay, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened))
			require.Len(t, reader.querySnapshot(), 1)
			require.Empty(t, restartedClient.prepares)
		})
	}
	freshCCT := runtimeBarrierManualHTTPCCT(t, auth, input, map[string]any{"jti": "manual-http-current-authorization"})
	replayed = decodeRuntimeBarrierManualHTTPSuccess(t,
		runtimeBarrierManualHTTPPost(t, ctx, restarted, input, body, auth.tokens["admin-console"], freshCCT))
	require.Equal(t, originalOperation, replayed)
	require.Equal(t, original, runtimeBarrierAdmissionReceipt(t, ctx, reopened, fixture.begin))
	require.Equal(t, beforeReplay, runtimeBarrierRecoveryApplicationSnapshot(t, ctx, reopened))
	require.Len(t, reader.querySnapshot(), 1)
	require.Empty(t, restartedClient.prepares)
	assertRuntimeBarrierManualHTTPCooldown(t, ctx, reopened, original)
	assertRuntimeBarrierRecoveryApplicationPending(t, ctx, reopened, original)
}

func TestRuntimeBarrierManualHTTPRejectsBindingTargetAndActiveCooldown(t *testing.T) {
	for _, scenario := range []string{"inactive-owner-binding", "other-configured-target", "active-cooldown"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := runtimeBarrierPolicyTestContext(t)
			fixture := runtimeBarrierAdmissionSeed(t, ctx, "manual-http-conflict-original", "original-protected-execution")
			fixture = runtimeBarrierManualTestPolicy(t, ctx, fixture, "manual")
			fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
			reader := &runtimeBarrierManualHTTPReader{fact: fixture.begin.Recovery.Fact}
			client := &runtimeBarrierRecoveryApplicationSkillClient{}
			auth := newRuntimeBarrierPolicyHTTPAuthentication(t)
			endpoint := newRuntimeBarrierManualHTTPServer(t, fixture, auth.security, reader, client)
			input := runtimeBarrierManualHTTPInput(fixture)
			switch scenario {
			case "inactive-owner-binding":
				// The repository has no standalone binding-deactivation API. Change
				// exactly its current row, leaving the Agent CAS/source unchanged.
				result, err := fixture.store.pool.Exec(ctx, `UPDATE agent_controller.agent_access_bindings
SET active=false,updated_at=clock_timestamp()
WHERE agent_id=$1 AND principal_id=$2 AND access_revision=$3 AND active`,
					fixture.base.Agent.AgentID, fixture.base.Agent.OwnerUserID, fixture.base.Agent.AccessRevision)
				require.NoError(t, err)
				require.EqualValues(t, 1, result.RowsAffected())
				current, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
				require.NoError(t, err)
				expected := fixture.base.Agent
				require.NotNil(t, expected.Readiness)
				readiness := *expected.Readiness
				readiness.Access.Active = false
				expected.Readiness = &readiness
				require.Equal(t, expected, current.Agent)
				require.Equal(t, "unavailable", current.Agent.CurrentReadiness())
			case "other-configured-target":
				other := runtimeBarrierManualHTTPOtherTemplate(t, ctx, fixture)
				input.Command.TemplateID = other.TemplateID
				input.Command.TemplateRevision = other.Revision.Revision()
				require.NotEqual(t, fixture.base.ConfiguredSpec.Snapshot.TemplateID, input.Command.TemplateID)
			case "active-cooldown":
				decodeRuntimeBarrierManualHTTPSuccess(t, runtimeBarrierManualHTTPPost(t, ctx, endpoint, input,
					runtimeBarrierManualHTTPBody(t, input), auth.tokens["admin-console"], runtimeBarrierManualHTTPCCT(t, auth, input, nil)))
				original := runtimeBarrierAdmissionReceipt(t, ctx, fixture.store, fixture.begin)
				state, found, err := fixture.store.ReplayAgentRebuild(ctx, original.Command.RequestID, original.RequestFingerprint)
				require.NoError(t, err)
				require.True(t, found)
				finishRecoveryAdmissionBeforeRuntimeChange(t, ctx, fixture.store, state)
				base, err := fixture.store.GetAgentLifecycleBase(ctx, fixture.base.Agent.AgentID)
				require.NoError(t, err)
				require.Empty(t, base.Agent.ActiveOperationRequestID, "the next conflict must reach cooldown after the old operation has ended")
				fixture = runtimeBarrierAdmissionForAgent(t, fixture.store, base, fixture.seed, fixture.policy,
					"manual-http-second-cooldown-barrier", "second-protected-execution")
				fixture = runtimeBarrierManualTestSource(t, fixture, true, "admin-1")
				input = runtimeBarrierManualHTTPInput(fixture)
				reader.setFact(fixture.begin.Recovery.Fact)
				var active bool
				require.NoError(t, fixture.store.pool.QueryRow(ctx, `SELECT clock_timestamp()<cooldown_until
FROM agent_controller.runtime_barrier_recovery_cooldowns WHERE agent_id=$1 AND request_id=$2`,
					base.Agent.AgentID, original.Command.RequestID).Scan(&active))
				require.True(t, active)
			}
			require.NoError(t, input.Validate(), "each conflict must use a fully valid manual request, not an invalid-input fallback")
			before := runtimeBarrierAdmissionStateSnapshot(t, ctx, fixture.store)
			counts := readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID)

			response := runtimeBarrierManualHTTPPost(t, ctx, endpoint, input,
				runtimeBarrierManualHTTPBody(t, input), auth.tokens["admin-console"], runtimeBarrierManualHTTPCCT(t, auth, input, nil))

			assertRuntimeBarrierPolicyHTTPError(t, response, http.StatusConflict, "lifecycle_conflict")
			require.Empty(t, response.header.Get("Retry-After"))
			require.Equal(t, counts, readRuntimeBarrierAdmissionCounts(t, ctx, fixture.store, fixture.base.Agent.AgentID))
			require.Equal(t, before, runtimeBarrierAdmissionStateSnapshot(t, ctx, fixture.store),
				"the rejection cannot add a lifecycle operation, recovery receipt, event, target, start or cooldown")
			_, found, err := fixture.store.ReplayRuntimeBarrierRecovery(ctx, input.Command.OrganizationID,
				input.Command.AgentID, input.BarrierID)
			require.NoError(t, err)
			require.False(t, found, "a rejected request must not acquire a durable recovery receipt")
		})
	}
}

// Only ACP's factual read and RC's Skill-ready response are controlled here.
// HTTP authentication, application preparation and every recovery/lifecycle
// mutation use their real implementations. No Temporal or Runtime is started.
func newRuntimeBarrierManualHTTPServer(t *testing.T, fixture runtimeBarrierAdmissionFixture, security server.Security,
	reader ports.RuntimeBarrierReader, client *runtimeBarrierRecoveryApplicationSkillClient,
) *runtimeBarrierPolicyHTTPServer {
	t.Helper()
	clock := &catalogStateClock{now: fixture.begin.Now}
	lifecycle := application.NewLifecycleService(fixture.store, fixture.store, nil, nil, clock,
		application.WithSkillPreparation(fixture.store, client),
		application.WithRuntimeBarrierManualRecovery(fixture.store, reader))
	unused := &unusedCatalogDependencies{}
	boundary, err := server.NewHandler(fixtureCatalogService(fixture.store, nil, clock), lifecycle,
		unused, unused, unused, unused, func(context.Context) error { return nil }, security)
	require.NoError(t, err)
	endpoint := &runtimeBarrierPolicyHTTPServer{
		server: httptest.NewServer(boundary), transport: &http.Transport{Proxy: nil},
	}
	endpoint.client = &http.Client{
		Transport: endpoint.transport, Timeout: 10 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	t.Cleanup(endpoint.close)
	return endpoint
}

func runtimeBarrierManualHTTPInput(fixture runtimeBarrierAdmissionFixture) application.RuntimeBarrierManualRecoveryInput {
	return application.RuntimeBarrierManualRecoveryInput{
		Command:                 application.RebuildAgentInput(fixture.begin.Recovery.Command),
		BarrierID:               fixture.begin.Recovery.Fact.Barrier.BarrierID,
		ExpectedRuntimeRevision: fixture.begin.Recovery.Fact.RuntimeRevision,
	}
}

func runtimeBarrierManualHTTPBody(t *testing.T, input application.RuntimeBarrierManualRecoveryInput) []byte {
	t.Helper()
	require.NoError(t, input.Validate())
	command := input.Command
	body, err := json.Marshal(map[string]any{
		"request_id": command.RequestID, "organization_id": command.OrganizationID,
		"actor_principal_id": command.ActorPrincipalID, "template_id": command.TemplateID,
		"template_revision": command.TemplateRevision,
		"recovery": map[string]string{
			"barrier_id": input.BarrierID, "expected_runtime_revision": input.ExpectedRuntimeRevision,
		},
	})
	require.NoError(t, err)
	return body
}

func runtimeBarrierManualHTTPCCT(t *testing.T, auth *runtimeBarrierPolicyHTTPAuthentication,
	input application.RuntimeBarrierManualRecoveryInput, overrides map[string]any,
) string {
	t.Helper()
	claims := map[string]any{
		"sub": input.Command.ActorPrincipalID, "org": input.Command.OrganizationID, "agt": input.Command.AgentID,
	}
	for key, value := range overrides {
		claims[key] = value
	}
	return auth.sign(t, claims)
}

func runtimeBarrierManualHTTPPost(t *testing.T, ctx context.Context, endpoint *runtimeBarrierPolicyHTTPServer,
	input application.RuntimeBarrierManualRecoveryInput, body []byte, token, cct string,
) runtimeBarrierPolicyHTTPResponse {
	t.Helper()
	requestContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	path := "/internal/agents/" + url.PathEscape(input.Command.AgentID) + "/rebuild"
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpoint.server.URL+path, bytes.NewReader(body))
	require.NoError(t, err)
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.Header.Set(serviceauth.Header, "Bearer "+token)
	}
	if cct != "" {
		request.Header.Set(callercontext.Header, cct)
	}
	response, err := endpoint.client.Do(request)
	require.NoError(t, err)
	raw, readErr := io.ReadAll(response.Body)
	closeErr := response.Body.Close()
	require.NoError(t, readErr)
	require.NoError(t, closeErr)
	return runtimeBarrierPolicyHTTPResponse{status: response.StatusCode, header: response.Header.Clone(), body: raw}
}

type runtimeBarrierManualHTTPOperation struct {
	RequestID   string                `json:"request_id"`
	AgentID     string                `json:"agent_id"`
	Kind        domain.OperationKind  `json:"kind"`
	Phase       domain.OperationPhase `json:"phase"`
	State       domain.OperationState `json:"state"`
	ErrorCode   string                `json:"error_code,omitempty"`
	ErrorDetail string                `json:"error_detail,omitempty"`
	CreatedAt   time.Time             `json:"created_at"`
	UpdatedAt   time.Time             `json:"updated_at"`
}

func decodeRuntimeBarrierManualHTTPSuccess(t *testing.T, response runtimeBarrierPolicyHTTPResponse) runtimeBarrierManualHTTPOperation {
	t.Helper()
	require.Equal(t, http.StatusAccepted, response.status)
	require.Equal(t, "application/json", response.header.Get("Content-Type"))
	var operation runtimeBarrierManualHTTPOperation
	decoder := json.NewDecoder(bytes.NewReader(response.body))
	decoder.DisallowUnknownFields()
	require.NoError(t, decoder.Decode(&operation))
	var trailing any
	require.ErrorIs(t, decoder.Decode(&trailing), io.EOF)
	require.NotEmpty(t, operation.RequestID)
	return operation
}

func assertRuntimeBarrierManualHTTPOperation(t *testing.T, expected ports.LifecycleOperationRecord, actual runtimeBarrierManualHTTPOperation) {
	t.Helper()
	require.Equal(t, expected.RequestID, actual.RequestID)
	require.Equal(t, expected.AgentID, actual.AgentID)
	require.Equal(t, expected.Kind, actual.Kind)
	require.Equal(t, expected.Phase, actual.Phase)
	require.Equal(t, expected.State, actual.State)
	require.Equal(t, expected.ErrorCode, actual.ErrorCode)
	require.Equal(t, expected.ErrorDetail, actual.ErrorDetail)
	require.True(t, expected.CreatedAt.Equal(actual.CreatedAt))
	require.True(t, expected.UpdatedAt.Equal(actual.UpdatedAt))
}

func assertRuntimeBarrierManualHTTPCooldown(t *testing.T, ctx context.Context, store *Repository, original ports.RuntimeBarrierRecoveryReceipt) {
	t.Helper()
	var requestID string
	var acceptedAt, cooldownUntil time.Time
	require.NoError(t, store.pool.QueryRow(ctx, `SELECT request_id,accepted_at,cooldown_until
FROM agent_controller.runtime_barrier_recovery_cooldowns WHERE organization_id=$1 AND agent_id=$2`,
		original.Command.OrganizationID, original.Command.AgentID).Scan(&requestID, &acceptedAt, &cooldownUntil))
	require.Equal(t, original.Command.RequestID, requestID)
	require.True(t, original.AcceptedAt.Equal(acceptedAt))
	require.True(t, original.CooldownUntil.Equal(cooldownUntil))
	require.True(t, original.AcceptedAt.Add(time.Duration(original.Policy.CooldownMS)*time.Millisecond).Equal(cooldownUntil))
}

type runtimeBarrierManualHTTPReader struct {
	mu      sync.Mutex
	fact    ports.RuntimeBarrierResult
	err     error
	queries []ports.RuntimeBarrierQuery
}

func (reader *runtimeBarrierManualHTTPReader) GetRuntimeBarrier(_ context.Context, query ports.RuntimeBarrierQuery) (ports.RuntimeBarrierResult, error) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	reader.queries = append(reader.queries, query)
	fact := reader.fact
	if fact.Barrier != nil {
		barrier := *fact.Barrier
		fact.Barrier = &barrier
	}
	return fact, reader.err
}

func (reader *runtimeBarrierManualHTTPReader) querySnapshot() []ports.RuntimeBarrierQuery {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	return append([]ports.RuntimeBarrierQuery(nil), reader.queries...)
}

func (reader *runtimeBarrierManualHTTPReader) setFailure(err error) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	reader.err = err
}

func (reader *runtimeBarrierManualHTTPReader) setFact(fact ports.RuntimeBarrierResult) {
	reader.mu.Lock()
	defer reader.mu.Unlock()
	reader.fact = fact
}

func runtimeBarrierManualHTTPOtherTemplate(t *testing.T, ctx context.Context, fixture runtimeBarrierAdmissionFixture) ports.TemplateRecord {
	t.Helper()
	configured := fixture.seed.Revision.Snapshot()
	const templateID = "manual_http_other_template"
	revision, err := domain.NewTemplateRevision(domain.TemplateRevisionInput{
		TemplateID: templateID, OrganizationID: configured.OrganizationID, Revision: 1,
		ModelProfileID: configured.ModelProfileID, FallbackModelProfileIDs: configured.FallbackModelProfileIDs,
		SystemPrompt: configured.SystemPrompt, MaxModelRequests: configured.MaxModelRequests,
		Runtime: configured.Runtime, ContextPolicyVersion: configured.ContextPolicyVersion,
		SkillRefs: configured.SkillRefs, SkillSetDigest: configured.SkillSetDigest,
	})
	require.NoError(t, err)
	now := time.Now().UTC().Truncate(time.Microsecond)
	other, err := fixture.store.PutTemplate(ctx, ports.TemplateRecord{
		RequestID: "manual-http-create-other-template", RequestFingerprint: strings.Repeat("d", 64),
		TemplateID: templateID, OrganizationID: configured.OrganizationID, TemplateKey: "manual-http-other-template",
		Name: "Other manual HTTP target", Revision: revision, Enabled: true, CreatedAt: now, UpdatedAt: now,
	})
	require.NoError(t, err)
	require.True(t, other.Enabled)
	return other
}
