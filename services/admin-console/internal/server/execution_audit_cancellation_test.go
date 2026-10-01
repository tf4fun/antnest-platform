package server

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/telemetry"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestExecutionAuditBrowserDisconnectCancelsRequestAndBodyRead(t *testing.T) {
	for _, partialBody := range []bool{false, true} {
		name := "before_headers"
		if partialBody {
			name = "during_body"
		}
		t.Run(name, func(t *testing.T) { auditBrowserCancellation(t, partialBody) })
	}
}

func auditBrowserCancellation(t *testing.T, partialBody bool) {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	provider := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder))
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(provider)
	t.Cleanup(func() {
		otel.SetTracerProvider(previous)
		require.NoError(t, provider.Shutdown(context.Background()))
	})
	started, cancelled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	acp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		if partialBody {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"items":[`)
			if err := http.NewResponseController(w).Flush(); err != nil {
				t.Error(err)
			}
		}
		close(started)
		select {
		case <-r.Context().Done():
			close(cancelled)
		case <-release:
		}
	}))
	t.Cleanup(acp.Close)
	t.Cleanup(func() { close(release) })
	client, err := upstream.NewClient(upstream.Config{IdentityURL: acp.URL, AgentControllerURL: acp.URL, AgentACPURL: acp.URL, HTTPClient: acp.Client()})
	require.NoError(t, err)
	handler := telemetry.HTTPHandler(newTestHandler(t, client), slog.New(slog.NewTextHandler(io.Discard, nil)))
	finished := make(chan struct{})
	bff := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		handler.ServeHTTP(w, r)
		close(finished)
	}))
	t.Cleanup(bff.Close)
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, bff.URL+"/api/admin/execution-audits", nil)
	require.NoError(t, err)
	actor := principal.Principal{UserID: "admin", OrganizationID: "org", MembershipID: "membership", SystemRole: "admin", OrganizationRole: "member"}
	request.Header, err = actor.Headers()
	require.NoError(t, err)
	result := make(chan error, 1)
	go func() {
		response, callErr := bff.Client().Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		result <- callErr
	}()
	awaitAuditSignal(t, started)
	cancel()
	select {
	case err := <-result:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(2 * time.Second):
		t.Fatal("browser request did not exit")
	}
	awaitAuditSignal(t, cancelled)
	awaitAuditSignal(t, finished)
	require.Len(t, recorder.Started(), 2)
	require.Len(t, recorder.Ended(), 2, "both transport spans must end after disconnect")
}

func awaitAuditSignal(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("audit HTTP request did not reach its expected boundary")
	}
}

func TestExecutionAuditHTTPPreservesACPFailures(t *testing.T) {
	for _, item := range []struct {
		status int
		body   string
	}{
		{503, `{"code":"execution_audit_unavailable","message":"Execution audit is unavailable","retryable":true}`},
		{404, `{"code":"audit_not_found","message":"Execution was not found","retryable":false}`},
		{403, `{"code":"access_denied","message":"Access denied","retryable":false}`},
		{400, `{"code":"invalid_cursor","message":"Invalid audit cursor","retryable":false}`},
	} {
		t.Run(http.StatusText(item.status), func(t *testing.T) {
			acp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(item.status)
				_, _ = io.WriteString(w, item.body)
			}))
			defer acp.Close()
			client, err := upstream.NewClient(upstream.Config{IdentityURL: acp.URL, AgentControllerURL: acp.URL, AgentACPURL: acp.URL, HTTPClient: acp.Client()})
			require.NoError(t, err)
			response := requestAdmin(t, newTestHandler(t, client), http.MethodGet, "/api/admin/execution-audits", "")
			require.Equal(t, item.status, response.Code)
			require.JSONEq(t, item.body, response.Body.String())
			require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
		})
	}
}
