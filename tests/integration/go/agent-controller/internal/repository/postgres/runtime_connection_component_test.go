package postgres

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/runtimeclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/serviceauth"
)

func componentPrivateToken(t *testing.T) string {
	t.Helper()
	raw := make([]byte, 32)
	_, err := rand.Read(raw)
	require.NoError(t, err)
	return base64.RawURLEncoding.EncodeToString(raw)
}

func TestRuntimePrivateConnectionPostgresHTTPPublicationAndRecovery(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	base, _ := seedAvailableAgentForRebuild(t, t.Context(), repository)
	runtimeToken, rcToken, acpToken := componentPrivateToken(t), componentPrivateToken(t), componentPrivateToken(t)
	var fault, resolves, applies atomic.Int32
	observed := make(chan trace.SpanContext, 2)
	rc := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Zero(t, repository.pool.Stat().AcquiredConns(), "HTTP resolution retained the source transaction")
		require.Equal(t, "Bearer "+rcToken, r.Header.Get(serviceauth.Header))
		require.Empty(t, r.Header.Get("Antnest-Caller-Context"))
		require.Empty(t, r.Header.Get("Authorization"))
		require.Empty(t, r.Header.Get("Idempotency-Key"))
		require.Equal(t, "/internal/runtimes/"+base.Agent.AgentID+"/connection", r.URL.Path)
		var input struct {
			Revision  string `json:"runtime_revision"`
			Execution string `json:"expected_execution_id"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&input))
		require.Equal(t, base.Agent.RuntimeRevision, input.Revision)
		require.Equal(t, base.Agent.RuntimeExecutionID, input.Execution)
		resolves.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if fault.Load() == 2 {
			w.WriteHeader(503)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": "runtime_connection_unavailable", "message": runtimeToken, "retryable": true})
			return
		}
		connection := ports.RuntimeConnection{AgentID: base.Agent.AgentID, RuntimeRevision: base.Agent.RuntimeRevision, RuntimeExecutionID: base.Agent.RuntimeExecutionID,
			MCPEndpoint: base.Agent.RuntimeMCPEndpoint, ConnectionID: "rci_11111111111111111111111111111111",
			Credential: ports.RuntimeCredential{Caller: "agent-acp-service", Token: runtimeToken}}
		if fault.Load() == 1 {
			connection.MCPEndpoint = "http://wrong-runtime:8093/mcp"
		}
		_ = json.NewEncoder(w).Encode(connection)
	}))
	defer rc.Close()
	acp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Zero(t, repository.pool.Stat().AcquiredConns(), "private relay retained a database connection")
		require.Equal(t, "Bearer "+acpToken, r.Header.Get(serviceauth.Header))
		require.Empty(t, r.Header.Get("Antnest-Caller-Context"))
		require.Equal(t, "/rpc/agent-acp/apply-execution-snapshot", r.URL.Path)
		// The receiver fixture reads its private handoff explicitly. Controller's
		// output-only ExecutionModel embeds ModelParameters' request decoder.
		var snapshot struct {
			OrganizationID string                 `json:"organization_id"`
			Revision       int64                  `json:"revision"`
			Agents         []ports.ExecutionAgent `json:"agents"`
		}
		require.NoError(t, json.NewDecoder(r.Body).Decode(&snapshot))
		require.Len(t, snapshot.Agents, 1)
		require.True(t, snapshot.Agents[0].AcceptingRuns)
		require.NotNil(t, snapshot.Agents[0].Runtime)
		require.NotNil(t, snapshot.Agents[0].Runtime.Credential)
		require.Equal(t, runtimeToken, snapshot.Agents[0].Runtime.Credential.Token)
		context := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		observed <- trace.SpanContextFromContext(context)
		applies.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision})
	}))
	defer acp.Close()
	directory := t.TempDir()
	for name, token := range map[string]string{"runtime-controller": rcToken, "agent-acp-service": acpToken, "callers.json": "{}"} {
		require.NoError(t, os.WriteFile(filepath.Join(directory, name), []byte(token), 0600))
	}
	env := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true",
		"ANTNEST_SERVICE_AUTH_TOKEN_DIR": directory, "ANTNEST_SERVICE_AUTH_CALLERS_FILE": filepath.Join(directory, "callers.json")}
	clients, err := serviceauth.LoadOutbound(func(key string) (string, bool) { v, ok := env[key]; return v, ok }, map[string]string{"runtime-controller": rc.URL, "agent-acp-service": acp.URL})
	require.NoError(t, err)
	defer clients.CloseIdleConnections()
	resolver, err := runtimeclient.New(rc.URL, time.Second, clients.HTTPClient())
	require.NoError(t, err)
	execution, err := acpclient.New(acp.URL, time.Second, clients.HTTPClient())
	require.NoError(t, err)
	publisher := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, execution, application.WithRuntimeConnectionResolver(resolver))
	ctx, parent := otel.Tracer("private-runtime-component").Start(t.Context(), "runtime configuration publication")
	ctx = callercontext.WithToken(ctx, "must-not-be-replayed-user-context")
	ack, err := publisher.Publish(ctx, base.Agent.OrganizationID)
	parent.End()
	require.NoError(t, err)
	require.EqualValues(t, 1, resolves.Load())
	require.EqualValues(t, 1, applies.Load())
	propagated := <-observed
	for _, secret := range []string{runtimeToken, rcToken, acpToken, "must-not-be-replayed-user-context"} {
		assertPublicationTrace(t, recorder.Ended(), parent.SpanContext(), propagated, secret)
	}
	for _, value := range []int32{1, 2} {
		_, err := repository.pool.Exec(t.Context(), `UPDATE agent_controller.execution_configuration_sync SET revision=revision+1 WHERE organization_id=$1`, base.Agent.OrganizationID)
		require.NoError(t, err)
		fault.Store(value)
		result, err := publisher.Publish(t.Context(), base.Agent.OrganizationID)
		require.Error(t, err)
		require.Empty(t, result)
		require.NotContains(t, err.Error(), runtimeToken)
		state, err := repository.GetExecutionSynchronization(t.Context(), base.Agent.OrganizationID)
		require.NoError(t, err)
		require.Equal(t, ack.AppliedRevision, state.AppliedRevision)
		require.Greater(t, state.Revision, state.AppliedRevision)
		require.EqualValues(t, 1, applies.Load(), "mismatched/unavailable authority reached ACP")
	}
	fault.Store(0)
	// A new publisher after process-local state loss re-resolves; the store holds
	// no bearer from which to reconstruct authority.
	restarted := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, execution, application.WithRuntimeConnectionResolver(resolver))
	_, err = restarted.Publish(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.EqualValues(t, 4, resolves.Load())
	require.EqualValues(t, 2, applies.Load())
	for _, table := range []string{"agents", "execution_revisions", "agent_lifecycle_operations", "execution_configuration_sync"} {
		var stored string
		err := repository.pool.QueryRow(t.Context(), `SELECT coalesce(json_agg(t)::text, '[]') FROM agent_controller.`+table+` t`).Scan(&stored)
		require.NoError(t, err)
		require.NotContains(t, stored, runtimeToken)
		require.NotContains(t, stored, rcToken)
		require.NotContains(t, stored, acpToken)
	}
	// Closing still applies when the RC-owned peer is unavailable.
	before := resolves.Load()
	fault.Store(2)
	_, err = repository.pool.Exec(t.Context(), `WITH closed AS (
		UPDATE agent_controller.agents SET runtime_state='unhealthy' WHERE id=$1 RETURNING organization_id
	) UPDATE agent_controller.execution_configuration_sync SET revision=revision+1
	WHERE organization_id IN (SELECT organization_id FROM closed)`, base.Agent.AgentID)
	require.NoError(t, err)
	closed := application.NewExecutionPublisher(repository, mutationCredentialOpener{}, &lifecycleACPStub{}, application.WithRuntimeConnectionResolver(resolver))
	_, err = closed.Publish(t.Context(), base.Agent.OrganizationID)
	require.NoError(t, err)
	require.Equal(t, before, resolves.Load())
	require.Zero(t, repository.pool.Stat().AcquiredConns())
	for _, secret := range []string{runtimeToken, rcToken, acpToken, "must-not-be-replayed-user-context"} {
		assertPublicationTrace(t, recorder.Ended(), parent.SpanContext(), propagated, secret)
	}
	unavailableClassified := false
	for _, span := range recorder.Ended() {
		for _, attribute := range span.Attributes() {
			if string(attribute.Key) == "antnest.error.code" && attribute.Value.AsString() == "runtime_connection_unavailable" {
				unavailableClassified = true
			}
		}
	}
	require.True(t, unavailableClassified, "Trace must classify resolver outages without recording the remote message")
}
