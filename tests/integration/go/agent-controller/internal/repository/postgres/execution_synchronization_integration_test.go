package postgres

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/codes"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/authfixture"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/telemetry"
)

func synchronizationBoundary(t *testing.T, repository *Repository) http.Handler {
	t.Helper()
	unused := &unusedCatalogDependencies{}
	boundary, err := authfixture.NewHandler(t, nilCatalog{}, unused, application.NewAgentConfigurationService(repository, nil, nil),
		unused, unused, unused, repository.Ping)
	require.NoError(t, err)
	return telemetry.HTTPHandler(boundary, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func readSynchronizationHTTP(t *testing.T, boundary http.Handler, organizationID string) application.ExecutionSynchronizationView {
	t.Helper()
	response := httptest.NewRecorder()
	boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/execution-synchronization?organization_id="+organizationID, nil))
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	require.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	var view application.ExecutionSynchronizationView
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &view))
	require.Equal(t, organizationID, view.OrganizationID)
	return view
}

func TestExecutionSynchronizationHTTPReadsPersistedProgressWithoutPublication(t *testing.T) {
	repository := providerTestRepository(t)
	boundary := synchronizationBoundary(t, repository)
	require.Nil(t, readSynchronizationHTTP(t, boundary, "org1").Synchronization)
	_, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.ErrorIs(t, err, ports.ErrNotFound, "reading must not insert an initial revision")
	provider := executionProvider("org1", "provider1")
	_, err = repository.PutProviderConnection(t.Context(), provider, nil)
	require.NoError(t, err)
	first := readSynchronizationHTTP(t, boundary, "org1")
	require.NotNil(t, first.Synchronization)
	require.Equal(t, int64(1), first.Synchronization.Revision)
	require.Zero(t, first.Synchronization.AppliedRevision)
	require.Nil(t, first.Synchronization.AppliedAt)
	require.NoError(t, repository.RecordExecutionApplied(t.Context(), ports.ExecutionAcknowledgement{OrganizationID: "org1", AppliedRevision: 1}))
	confirmed := readSynchronizationHTTP(t, boundary, "org1")
	require.Equal(t, int64(1), confirmed.Synchronization.AppliedRevision)
	require.NotNil(t, confirmed.Synchronization.AppliedAt)
	provider.RequestID = "rotate-provider1"
	provider.CredentialVersion = "credential-2"
	provider.CredentialRevision = 2
	_, err = repository.RotateProviderCredential(t.Context(), "credential-1", provider)
	require.NoError(t, err)
	before, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	hints := 0
	WithExecutionChangeObserver(func(context.Context, string) { hints++ })(repository)
	for range 2 {
		pending := readSynchronizationHTTP(t, boundary, "org1")
		require.Equal(t, int64(2), pending.Synchronization.Revision)
		require.Equal(t, int64(1), pending.Synchronization.AppliedRevision)
		require.Equal(t, confirmed.Synchronization.AppliedAt, pending.Synchronization.AppliedAt)
	}
	require.Nil(t, readSynchronizationHTTP(t, boundary, "org2").Synchronization)
	after, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.Equal(t, before, after, "reads must not acknowledge or republish a configuration")
	require.Zero(t, hints)
}

func TestExecutionSynchronizationHTTPUsesOneObservedDatabaseRead(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	_, err := repository.PutProviderConnection(t.Context(), executionProvider("org1", "provider1"), nil)
	require.NoError(t, err)
	boundary := synchronizationBoundary(t, repository)
	request := httptest.NewRequest(http.MethodGet, "/internal/execution-synchronization?organization_id=org1", nil)
	request.Header.Set("traceparent", "00-11111111111111111111111111111111-2222222222222222-01")
	response := httptest.NewRecorder()
	setupSpans := len(recorder.Ended())
	boundary.ServeHTTP(response, request)
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	spans := recorder.Ended()[setupSpans:]
	require.Len(t, spans, 2, "only the HTTP boundary and its single SQL read are expected")
	var boundarySpan, databaseSpan sdktrace.ReadOnlySpan
	for _, span := range spans {
		switch span.SpanKind() {
		case trace.SpanKindServer:
			boundarySpan = span
		case trace.SpanKindClient:
			databaseSpan = span
		default:
			t.Fatalf("unexpected span: %s", span.Name())
		}
	}
	require.NotNil(t, boundarySpan)
	require.NotNil(t, databaseSpan)
	require.Equal(t, "11111111111111111111111111111111", boundarySpan.SpanContext().TraceID().String())
	require.Equal(t, "2222222222222222", boundarySpan.Parent().SpanID().String())
	require.Equal(t, "GET /internal/execution-synchronization", databaseSpanAttribute(boundarySpan, "rpc.method"))
	require.Equal(t, "SELECT", databaseSpan.Name())
	require.Equal(t, boundarySpan.SpanContext().SpanID(), databaseSpan.Parent().SpanID())
	require.Equal(t, boundarySpan.SpanContext().TraceID(), databaseSpan.SpanContext().TraceID())
	require.Contains(t, databaseSpanAttribute(databaseSpan, "db.query.text"), "execution_configuration_sync WHERE organization_id=$1")
	require.Equal(t, codes.Unset, databaseSpan.Status().Code)
}

func TestExecutionSynchronizationHTTPRealApplicationRejectsMissingScopeAndCancellation(t *testing.T) {
	repository := providerTestRepository(t)
	boundary := synchronizationBoundary(t, repository)
	for _, query := range []string{"", "organization_id=%20org1", "organization_id=org1%20"} {
		response := httptest.NewRecorder()
		boundary.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/execution-synchronization?"+query, nil))
		require.Equal(t, http.StatusBadRequest, response.Code, response.Body.String())
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/execution-synchronization?organization_id=org1", nil).WithContext(ctx)
	boundary.ServeHTTP(response, request)
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	require.NotContains(t, response.Body.String(), "synchronization")
}

func TestExecutionSynchronizationHTTPCancelsBlockedDatabaseRead(t *testing.T) {
	repository := providerTestRepository(t)
	boundary := synchronizationBoundary(t, repository)
	blocker, err := repository.pool.Begin(t.Context())
	require.NoError(t, err)
	defer func() { _ = blocker.Rollback(context.Background()) }()
	_, err = blocker.Exec(t.Context(), "LOCK TABLE agent_controller.execution_configuration_sync IN ACCESS EXCLUSIVE MODE")
	require.NoError(t, err)
	var blockerPID int
	require.NoError(t, blocker.QueryRow(t.Context(), "SELECT pg_backend_pid()").Scan(&blockerPID))
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	done := make(chan struct{})
	defer func() { cancel(); <-done }()
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/internal/execution-synchronization?organization_id=org1", nil).WithContext(ctx)
	go func() {
		defer close(done)
		boundary.ServeHTTP(response, request)
	}()
	require.Eventually(t, func() bool {
		var waiting int
		err := repository.pool.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid))`, blockerPID).Scan(&waiting)
		return err == nil && waiting == 1
	}, 2*time.Second, 10*time.Millisecond)
	cancel()
	<-done
	require.Equal(t, http.StatusServiceUnavailable, response.Code, response.Body.String())
	require.NotContains(t, response.Body.String(), "synchronization")
}
