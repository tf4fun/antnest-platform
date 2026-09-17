package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	"soft/antnest-platform/services/agent-controller/internal/acpclient"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionWorkerCommitToHTTPWithoutBlockingCatalogWrites(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{})
	connection, err := catalog.CreateProviderConnection(t.Context(), providerTestInput("worker-create", "org1"))
	require.NoError(t, err)
	observed := make(chan observedExecutionPublication, 10)
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var snapshot receivedExecutionSnapshot
		if err := json.NewDecoder(request.Body).Decode(&snapshot); err != nil {
			t.Error(err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		parent := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		observed <- observedExecutionPublication{snapshot: snapshot, parent: trace.SpanContextFromContext(parent)}
		if snapshot.Revision == 2 {
			select {
			case <-release:
			case <-request.Context().Done():
				return
			}
		}
		response.Header().Set("Content-Type", "application/json")
		if err := json.NewEncoder(response).Encode(ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision}); err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)
	client, err := acpclient.New(server.URL, 5*time.Second, server.Client())
	require.NoError(t, err)
	publisher := application.NewExecutionPublisher(repository, box, client)
	worker, err := application.NewExecutionPublicationWorker(repository, publisher, application.ExecutionPublicationSchedule{
		ResyncInterval: time.Hour, RetryInterval: time.Second, MaxRetryInterval: 4 * time.Second, RequestTimeout: 5 * time.Second,
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	WithExecutionChangeObserver(worker.Notify)(repository)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); worker.Run(ctx) }()
	t.Cleanup(func() {
		unblock()
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("publication worker did not stop")
		}
	})
	initial := awaitExecutionPublication(t, observed)
	require.EqualValues(t, 1, initial.snapshot.Revision)
	request, parent := otel.Tracer("publication-worker-test").Start(t.Context(), "credential rotation")
	rotated, err := catalog.RotateProviderCredential(request, application.RotateProviderCredentialInput{
		RequestID: "worker-rotate-1", OrganizationID: "org1", ConnectionID: connection.ConnectionID, ExpectedVersion: connection.CredentialVersion,
		Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic-worker-first"},
	})
	parent.End()
	require.NoError(t, err, "a committed rotation returns while ACP response remains blocked")
	first := awaitExecutionPublication(t, observed)
	require.EqualValues(t, 2, first.snapshot.Revision)
	require.Equal(t, parent.SpanContext().TraceID(), first.parent.TraceID())
	_, err = catalog.RotateProviderCredential(t.Context(), application.RotateProviderCredentialInput{
		RequestID: "worker-rotate-2", OrganizationID: "org1", ConnectionID: connection.ConnectionID, ExpectedVersion: rotated.CredentialVersion,
		Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic-worker-latest"},
	})
	require.NoError(t, err)
	unblock()
	latest := awaitExecutionPublication(t, observed)
	require.EqualValues(t, 3, latest.snapshot.Revision)
	require.Equal(t, "synthetic-worker-latest", latest.snapshot.Providers[0].Credential.Secret)
	require.Eventually(t, func() bool {
		state, err := repository.GetExecutionSynchronization(t.Context(), "org1")
		return err == nil && state.AppliedRevision == 3
	}, 5*time.Second, 10*time.Millisecond)
	cancel()
	<-done
	attempt := assertWorkerPublicationTrace(t, recorder.Ended(), first.parent, true)
	require.Equal(t, parent.SpanContext(), attempt.Parent())
	assertPublicationTrace(t, recorder.Ended(), attempt.SpanContext(), first.parent, "synthetic-worker-first")
}

func TestExecutionWorkerLostReplyTracesSourceAndOnlyDeliveredAcknowledgement(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{})
	_, err = catalog.CreateProviderConnection(t.Context(), providerTestInput("worker-loss", "org1"))
	require.NoError(t, err)
	observed := make(chan observedExecutionPublication, 4)
	var calls atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var snapshot receivedExecutionSnapshot
		if err := json.NewDecoder(r.Body).Decode(&snapshot); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		ctx := propagation.TraceContext{}.Extract(r.Context(), propagation.HeaderCarrier(r.Header))
		observed <- observedExecutionPublication{snapshot: snapshot, parent: trace.SpanContextFromContext(ctx)}
		if calls.Add(1) == 1 {
			conn, _, err := w.(http.Hijacker).Hijack()
			if err != nil {
				t.Error(err)
				return
			}
			_ = conn.Close()
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision})
	}))
	t.Cleanup(server.Close)
	client, err := acpclient.New(server.URL, 5*time.Second, server.Client())
	require.NoError(t, err)
	worker, err := application.NewExecutionPublicationWorker(repository, application.NewExecutionPublisher(repository, box, client), application.ExecutionPublicationSchedule{ResyncInterval: time.Hour, RetryInterval: 10 * time.Millisecond, MaxRetryInterval: 10 * time.Millisecond, RequestTimeout: 5 * time.Second}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	require.NoError(t, err)
	cause, parent := otel.Tracer("publication-worker-test").Start(t.Context(), "committed change")
	worker.Notify(cause, "org1")
	parent.End()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { defer close(done); worker.Run(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Error("worker did not stop")
		}
	})
	lost := awaitExecutionPublication(t, observed)
	delivered := awaitExecutionPublication(t, observed)
	require.Equal(t, lost.snapshot, delivered.snapshot)
	require.Eventually(t, func() bool {
		s, err := repository.GetExecutionSynchronization(t.Context(), "org1")
		return err == nil && s.AppliedRevision == 1
	}, 5*time.Second, 10*time.Millisecond)
	cancel()
	<-done
	require.EqualValues(t, 2, calls.Load())
	spans := recorder.Ended()
	first := assertWorkerPublicationTrace(t, spans, lost.parent, false)
	second := assertWorkerPublicationTrace(t, spans, delivered.parent, true)
	require.Equal(t, parent.SpanContext(), first.Parent())
	require.Equal(t, first.Parent(), second.Parent())
	require.NotEqual(t, first.SpanContext().SpanID(), second.SpanContext().SpanID())
	require.Equal(t, codes.Error, first.Status().Code)
	require.Equal(t, codes.Unset, second.Status().Code)
}

func assertWorkerPublicationTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, propagated trace.SpanContext, ack bool) sdktrace.ReadOnlySpan {
	t.Helper()
	byID := map[trace.SpanID]sdktrace.ReadOnlySpan{}
	for _, s := range spans {
		byID[s.SpanContext().SpanID()] = s
		require.NotContains(t, fmt.Sprint(s.Attributes(), s.Events(), s.Status()), "initial-secret")
		require.NotContains(t, fmt.Sprint(s.Attributes(), s.Events(), s.Status()), "synthetic-worker-latest")
	}
	http := byID[propagated.SpanID()]
	require.NotNil(t, http)
	require.Equal(t, "HTTP POST agent-acp-service", http.Name())
	require.Equal(t, trace.SpanKindClient, http.SpanKind())
	attempt := byID[http.Parent().SpanID()]
	require.NotNil(t, attempt, "missing recording publication boundary")
	require.Equal(t, "agent_controller.execution_publication", attempt.Name())
	require.Equal(t, propagated.TraceID(), attempt.SpanContext().TraceID())
	var source, commits, acknowledged int
	for _, s := range spans {
		owned := s.Parent().SpanID() == attempt.SpanContext().SpanID()
		if p := byID[s.Parent().SpanID()]; p != nil && p.Name() == "postgresql transaction" && p.Parent().SpanID() == attempt.SpanContext().SpanID() {
			owned = true
		}
		if !owned || databaseSpanAttribute(s, "db.system.name") != "postgresql" || s.SpanKind() != trace.SpanKindClient {
			continue
		}
		query := databaseSpanAttribute(s, "db.query.text")
		switch {
		case query == executionRevisionQuery:
			source++
		case query == "commit":
			commits++
			require.False(t, s.EndTime().After(http.StartTime()), "source transaction remained open during HTTP")
		case s.Name() == "UPDATE":
			acknowledged++
			require.Contains(t, query, "SET applied_revision=GREATEST")
			require.Equal(t, attempt.SpanContext().SpanID(), s.Parent().SpanID())
			require.False(t, s.StartTime().Before(http.EndTime()), "ack precedes HTTP completion")
		}
	}
	require.Equal(t, 1, source)
	require.Equal(t, 1, commits)
	if ack {
		require.Equal(t, 1, acknowledged)
	} else {
		require.Zero(t, acknowledged)
	}
	return attempt
}

func awaitExecutionPublication(t *testing.T, observed <-chan observedExecutionPublication) observedExecutionPublication {
	t.Helper()
	select {
	case publication := <-observed:
		return publication
	case <-time.After(10 * time.Second):
		t.Fatal("execution configuration was not published")
		return observedExecutionPublication{}
	}
}
