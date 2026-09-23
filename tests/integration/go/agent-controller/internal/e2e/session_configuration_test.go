package e2e

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func assertAgentConfigurationHTTP(t *testing.T, handler http.Handler, agent map[string]any, publisher *application.ExecutionPublisher, snapshot func() peerExecutionSnapshot, recorder *tracetest.SpanRecorder) {
	t.Helper()
	const traceID = "33333333333333333333333333333333"
	observed := telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil)))
	traced := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("traceparent", "00-"+traceID+"-4444444444444444-01")
		observed.ServeHTTP(w, r)
	})
	publish := func() peerExecutionSnapshot {
		t.Helper()
		_, err := publisher.Publish(t.Context(), "agent-e2e-org")
		require.NoError(t, err)
		return snapshot()
	}
	before := publish()
	require.Len(t, before.Agents, 1)
	require.Len(t, before.Models, 1)
	require.Len(t, before.Providers, 1)
	var model struct {
		SupportsAudio  bool `json:"supports_audio"`
		SupportsPDF    bool `json:"supports_pdf"`
		SupportsImages bool `json:"supports_images"`
	}
	require.NoError(t, json.Unmarshal(before.Models[0], &model))
	require.True(t, model.SupportsAudio)
	require.True(t, model.SupportsPDF)
	require.False(t, model.SupportsImages)
	defaults := before.Agents[0]
	input := map[string]any{
		"request_id": "authorization-default", "agent_id": agent["agent_id"],
		"principal_id": "agent-e2e-user", "expected_access_revision": agent["access_revision"],
		"expected_authorization_revision": defaults.AuthorizationRevision,
		"authorization":                   map[string]any{"mode": "chat", "tool_rules": []any{}},
	}
	call := func(status int) map[string]any {
		t.Helper()
		return serveJSON(t, traced, http.MethodPost, "/rpc/agent-controller/set-agent-authorization", mustJSON(t, input), status)
	}
	updated := call(http.StatusOK)
	require.Equal(t, float64(defaults.AuthorizationRevision+1), updated["authorization_revision"])
	call(http.StatusConflict)
	current := publish()
	require.Greater(t, current.Revision, before.Revision)
	require.Equal(t, domain.AuthorizationChat, current.Agents[0].DefaultAuthorization.Mode)
	require.Equal(t, defaults.AuthorizationRevision+1, current.Agents[0].AuthorizationRevision)
	require.Equal(t, defaults.Runtime, current.Agents[0].Runtime)
	require.Equal(t, before.Models, current.Models)
	input["expected_authorization_revision"] = updated["authorization_revision"]
	retried := call(http.StatusOK)
	require.Equal(t, float64(defaults.AuthorizationRevision+2), retried["authorization_revision"])
	input["principal_id"] = "another-user"
	input["expected_authorization_revision"] = retried["authorization_revision"]
	call(http.StatusForbidden)
	require.Equal(t, defaults.AuthorizationRevision+2, publish().Agents[0].AuthorizationRevision)

	provider := before.Providers[0]
	rotated := serveJSON(t, handler, http.MethodPost,
		"/internal/provider-connections/"+provider.ConnectionID+"/credentials", mustJSON(t, map[string]any{
			"request_id": "published-rotation", "organization_id": "agent-e2e-org",
			"expected_version": provider.CredentialRevision,
			"credential":       map[string]any{"method": "api_key", "api_key": "synthetic-published-key"},
		}), http.StatusCreated)
	after := publish()
	require.Equal(t, rotated["credential_version"], after.Providers[0].CredentialRevision)
	require.NotEqual(t, provider.CredentialRevision, after.Providers[0].CredentialRevision)
	require.Equal(t, "synthetic-published-key", after.Providers[0].Credential.Secret)
	require.Equal(t, before.Models, after.Models)
	require.Equal(t, defaults.Runtime, after.Agents[0].Runtime)
	require.NotContains(t, mustJSON(t, after.Agents), "synthetic-published-key")
	require.NotContains(t, mustJSON(t, after.Models), "synthetic-published-key")
	assertConfigurationTracePath(t, recorder, traceID)
}

func assertConfigurationTracePath(t *testing.T, recorder *tracetest.SpanRecorder, traceID string) {
	t.Helper()
	parents := make(map[trace.SpanID]sdktrace.ReadOnlySpan)
	for _, span := range recorder.Ended() {
		if span.SpanContext().TraceID().String() == traceID && strings.HasPrefix(span.Name(), "HTTP POST ") {
			if span.Parent().SpanID().String() != "4444444444444444" {
				t.Fatalf("lost incoming trace: %s", span.Name())
			}
			parents[span.SpanContext().SpanID()] = span
		}
	}
	for _, span := range recorder.Ended() {
		if span.Name() == "postgresql transaction" && span.SpanKind() == trace.SpanKindInternal {
			if owner, ok := parents[span.Parent().SpanID()]; ok {
				parents[span.SpanContext().SpanID()] = owner
			}
		}
	}
	seen := map[string]bool{}
	for _, span := range recorder.Ended() {
		if span.SpanContext().TraceID().String() != traceID {
			continue
		}
		if span.InstrumentationScope().Name != "github.com/exaring/otelpgx" || span.SpanKind() != trace.SpanKindClient {
			continue
		}
		parent, ok := parents[span.Parent().SpanID()]
		if !ok {
			continue // Prepare and batch query spans belong to their driver parent.
		}
		for _, operation := range []string{"set-agent-authorization"} {
			if parent.Name() == "HTTP POST /rpc/agent-controller/"+operation && hasDatabaseStatement(span) {
				seen[operation] = true
			}
		}
	}
	if len(seen) != 1 {
		t.Fatalf("missing configuration trace operations: %v", seen)
	}
}

func hasDatabaseStatement(span sdktrace.ReadOnlySpan) bool {
	for _, value := range span.Attributes() {
		if string(value.Key) == "db.query.text" && value.Value.AsString() != "" {
			return true
		}
	}
	return false
}
