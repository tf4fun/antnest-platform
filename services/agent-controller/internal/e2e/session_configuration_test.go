package e2e

import (
	"io"
	"log/slog"
	"net/http"
	"strings"
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/telemetry"
)

func assertSessionConfigurationHTTP(t *testing.T, handler http.Handler, agent map[string]any, accessSubject string, recorder *tracetest.SpanRecorder) {
	t.Helper()
	const traceID = "33333333333333333333333333333333"
	observed := telemetry.HTTPHandler(handler, slog.New(slog.NewTextHandler(io.Discard, nil)))
	traced := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Header.Set("traceparent", "00-"+traceID+"-4444444444444444-01")
		observed.ServeHTTP(w, r)
	})
	identity := map[string]any{"request_id": "session-options", "agent_id": agent["agent_id"],
		"principal_id": "agent-e2e-user", "expected_access_revision": agent["access_revision"]}
	call := func(path string, input map[string]any, status int) map[string]any {
		t.Helper()
		return serveJSON(t, traced, http.MethodPost, "/rpc/agent-controller/"+path, mustJSON(t, input), status)
	}
	access := call("resolve-agent-access", map[string]any{"request_id": "native-access", "agent_access_subject": accessSubject}, http.StatusOK)
	capabilities := access["prompt_capabilities"].(map[string]any)
	if capabilities["audio"] != true || capabilities["embedded_context"] != true || capabilities["image"] != false {
		t.Fatalf("production capability declaration=%v", capabilities)
	}
	options := call("get-session-configuration", identity, http.StatusOK)
	for _, forbidden := range []string{"credential_ref", "credential_version", "base_url", "secret"} {
		if strings.Contains(mustJSON(t, options), forbidden) {
			t.Fatalf("options leak %s", forbidden)
		}
	}
	model := options["models"].([]any)[0].(map[string]any)
	identity["request_id"] = "authorization-default"
	identity["expected_authorization_revision"] = options["authorization_revision"]
	identity["authorization"] = map[string]any{"mode": "chat", "tool_rules": []any{}}
	updated := call("set-agent-authorization", identity, http.StatusOK)
	if updated["authorization_revision"] != float64(2) {
		t.Fatalf("CAS response=%v", updated)
	}
	call("set-agent-authorization", identity, http.StatusConflict)
	identity["expected_authorization_revision"] = updated["authorization_revision"]
	retried := call("set-agent-authorization", identity, http.StatusOK)
	if retried["authorization_revision"] != float64(3) {
		t.Fatal("CAS reload retry failed")
	}
	delete(identity, "expected_authorization_revision")
	delete(identity, "authorization")
	identity["request_id"], identity["session_id"] = "session-config-run", "session-config"
	identity["session_configuration"] = map[string]any{"model_profile_id": model["model_profile_id"], "authorization_mode": "approve"}
	admitted := call("acquire-run", identity, http.StatusOK)
	execution := admitted["execution_spec"].(map[string]any)
	nativeModel := execution["model"].(map[string]any)
	if nativeModel["supports_audio"] != true || nativeModel["supports_pdf"] != true {
		t.Fatalf("native flags missing from Run: %v", nativeModel)
	}
	configuration := execution["configuration"].(map[string]any)
	if configuration["authorization"].(map[string]any)["mode"] != "approve" || configuration["model_profile_revision_id"] != model["revision_id"] {
		t.Fatalf("admission configuration=%v", configuration)
	}
	replay := call("acquire-run", identity, http.StatusOK)
	if mustJSON(t, replay) != mustJSON(t, admitted) {
		t.Fatalf("admission replay drifted: first=%s replay=%s", mustJSON(t, admitted), mustJSON(t, replay))
	}
	identity["session_configuration"] = map[string]any{"authorization_mode": "chat"}
	conflict := call("acquire-run", identity, http.StatusBadRequest)
	if conflict["code"] != "invalid_request" {
		t.Fatalf("request conflict=%v", conflict)
	}
	credential := call("resolve-credential", map[string]any{"request_id": "session-credential", "admission_id": admitted["admission_id"], "provider_connection_id": execution["provider"].(map[string]any)["connection_id"]}, http.StatusOK)
	if credential["credential_version"] == "" || credential["provider"].(map[string]any)["connection_id"] != execution["provider"].(map[string]any)["connection_id"] {
		t.Fatal("credential version drifted")
	}
	assertCredentialRotationDuringRun(t, handler, admitted, credential)
	identity["session_configuration"] = map[string]any{"model_profile_id": model["model_profile_id"], "authorization_mode": "approve"}
	rotatedReplay := call("acquire-run", identity, http.StatusOK)
	if mustJSON(t, rotatedReplay) != mustJSON(t, admitted) {
		t.Fatal("credential rotation changed admitted configuration")
	}
	call("finish-run", map[string]any{"request_id": "session-config-finish", "admission_id": admitted["admission_id"],
		"terminal_class": "completed", "tool_effect_state": "none", "unknown_effect_source": nil,
		"stop_reason": "end_turn", "error_class": nil}, http.StatusOK)
	call("resolve-credential", map[string]any{"request_id": "finished-credential", "admission_id": admitted["admission_id"], "provider_connection_id": execution["provider"].(map[string]any)["connection_id"]}, http.StatusForbidden)
	delete(identity, "session_id")
	delete(identity, "session_configuration")
	identity["request_id"] = "session-config-after"
	after := call("get-session-configuration", identity, http.StatusOK)
	if after["default_authorization"].(map[string]any)["mode"] != "chat" {
		t.Fatal("Session override mutated Agent default")
	}
	identity["principal_id"] = "another-user"
	call("get-session-configuration", identity, http.StatusForbidden)
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
		for _, operation := range []string{"get-session-configuration", "set-agent-authorization", "acquire-run", "resolve-agent-access"} {
			if parent.Name() == "HTTP POST /rpc/agent-controller/"+operation && hasDatabaseStatement(span) {
				seen[operation] = true
			}
		}
	}
	if len(seen) != 4 {
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
