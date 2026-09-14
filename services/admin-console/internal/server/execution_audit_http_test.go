package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/telemetry"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

type auditHTTPCall struct {
	Path   string
	Header http.Header
	Body   []byte
}

func TestExecutionAuditRealHTTPPreservesIdentityAndTraceWithoutController(t *testing.T) {
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	var unexpected atomic.Int64
	unused := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		unexpected.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer unused.Close()
	calls := make(chan auditHTTPCall, 8)
	acp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil || r.Method != http.MethodPost || r.URL.RawQuery != "" {
			t.Errorf("unexpected ACP request: method=%s query=%s error=%v", r.Method, r.URL.RawQuery, err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		calls <- auditHTTPCall{Path: r.URL.Path, Header: r.Header.Clone(), Body: body}
		w.Header().Set("Content-Type", "application/json")
		payload := `{"items":[],"next_cursor":null}`
		switch r.URL.Path {
		case "/rpc/agent-acp/get-execution-audit":
			payload = auditDetailFixture()
		case "/rpc/agent-acp/list-execution-events":
			var input struct {
				Stream string `json:"stream"`
			}
			if err := json.Unmarshal(body, &input); err != nil {
				t.Error(err)
			}
			if input.Stream == "permissions" {
				payload = `{"stream":"permissions","items":[],"next_cursor":null}`
			} else {
				payload = `{"stream":"execution","items":[],"next_cursor":null}`
			}
		}
		_, _ = io.WriteString(w, payload)
	}))
	defer acp.Close()
	client, err := upstream.NewClient(upstream.Config{IdentityURL: unused.URL, AgentControllerURL: unused.URL, AgentACPURL: acp.URL, HTTPClient: acp.Client()})
	require.NoError(t, err)
	bff := httptest.NewServer(telemetry.HTTPHandler(newTestHandler(t, client), slog.New(slog.NewTextHandler(io.Discard, nil))))
	defer bff.Close()
	for _, item := range []struct{ path, rpc, body string }{
		{"/api/admin/execution-audits?agent_id=deleted-agent", "list-execution-audits", `{"agent_id":"deleted-agent"}`},
		{"/api/admin/execution-audits/run-1", "get-execution-audit", `{"run_id":"run-1"}`},
		{"/api/admin/execution-audits/run-1/events", "list-execution-events", `{"run_id":"run-1"}`},
		{"/api/admin/execution-audits/run-1/events?stream=permissions", "list-execution-events", `{"run_id":"run-1","stream":"permissions"}`},
	} {
		t.Run(item.rpc, func(t *testing.T) {
			actor := principal.Principal{UserID: "Admin Oncall:+ops@example", OrganizationID: "org-1", MembershipID: "membership/one", SystemRole: "user", OrganizationRole: "admin"}
			request := httptest.NewRequest(http.MethodGet, bff.URL+item.path, nil)
			request.RequestURI = ""
			request.Header, err = actor.Headers()
			require.NoError(t, err)
			request.Header.Set("Cookie", "synthetic-cookie=never-forward")
			request.Header.Set("Authorization", "Bearer never-forward")
			request.Header.Set("X-Antnest-Agent-ID", "never-forward")
			request.Header.Set("X-Antnest-Principal-ID", "never-forward")
			ctx, root := provider.Tracer("audit-test").Start(t.Context(), "synthetic gateway")
			propagation.TraceContext{}.Inject(ctx, propagation.HeaderCarrier(request.Header))
			response, err := bff.Client().Do(request)
			require.NoError(t, err)
			_, err = io.Copy(io.Discard, response.Body)
			require.NoError(t, err)
			require.NoError(t, response.Body.Close())
			root.End()
			require.Equal(t, http.StatusOK, response.StatusCode)
			require.Equal(t, "no-store", response.Header.Get("Cache-Control"))
			require.Len(t, calls, 1)
			call := <-calls
			require.Equal(t, "/rpc/agent-acp/"+item.rpc, call.Path)
			require.JSONEq(t, item.body, string(call.Body))
			expectedHeaders, err := actor.Headers()
			require.NoError(t, err)
			for name, values := range expectedHeaders {
				require.Equal(t, values, call.Header.Values(name))
			}
			for _, name := range []string{"Cookie", "Authorization", "X-Antnest-Agent-ID", "X-Antnest-Principal-ID"} {
				require.Empty(t, call.Header.Get(name))
			}
			assertAuditHTTPTrace(t, recorder.Ended(), root.SpanContext(), call.Header)
		})
	}
	require.Zero(t, unexpected.Load(), "audit must not call Controller or Identity")
}

func assertAuditHTTPTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, root trace.SpanContext, header http.Header) {
	t.Helper()
	var serverSpan, clientSpan sdktrace.ReadOnlySpan
	for _, span := range spans {
		if span.SpanContext().TraceID() != root.TraceID() {
			continue
		}
		switch span.SpanKind() {
		case trace.SpanKindServer:
			require.Nil(t, serverSpan)
			serverSpan = span
		case trace.SpanKindClient:
			require.Nil(t, clientSpan)
			clientSpan = span
		}
	}
	require.NotNil(t, serverSpan)
	require.NotNil(t, clientSpan)
	require.Equal(t, root.SpanID(), serverSpan.Parent().SpanID())
	require.Equal(t, serverSpan.SpanContext().SpanID(), clientSpan.Parent().SpanID())
	propagated := propagation.TraceContext{}.Extract(t.Context(), propagation.HeaderCarrier(header))
	require.Equal(t, clientSpan.SpanContext().SpanID(), trace.SpanContextFromContext(propagated).SpanID())
	require.Equal(t, root.TraceID(), trace.SpanContextFromContext(propagated).TraceID())
}

func TestExecutionAuditHTTPDeadlineCancelsACPRequest(t *testing.T) {
	started := make(chan struct{})
	cancelled := make(chan struct{})
	acp := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(cancelled)
	}))
	defer acp.Close()
	client, err := upstream.NewClient(upstream.Config{IdentityURL: acp.URL, AgentControllerURL: acp.URL, AgentACPURL: acp.URL, HTTPClient: acp.Client()})
	require.NoError(t, err)
	handler := newTestHandler(t, client)
	actor := principal.Principal{UserID: "admin", OrganizationID: "org-1", MembershipID: "member-1", SystemRole: "admin", OrganizationRole: "member"}
	request := httptest.NewRequest(http.MethodGet, "/api/admin/execution-audits", nil)
	request.Header, err = actor.Headers()
	require.NoError(t, err)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	select {
	case <-started:
	default:
		t.Fatal("ACP request never reached the upstream")
	}
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("ACP request was not cancelled after the BFF timeout")
	}
}
