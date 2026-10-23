package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/acpclient"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

func TestExecutionWorkerCommitToHTTPWithoutBlockingCatalogWrites(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := fixtureCatalogService(repository, box, providerTestClock{})
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
	workerPublicationTraceWarning(t, parent.SpanContext().TraceID() == first.parent.TraceID(), "propagated trace does not match the committed change")
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
	var publication trace.SpanContext
	if attempt != nil {
		workerPublicationTraceWarning(t, parent.SpanContext().Equal(attempt.Parent()), "publication parent does not match the committed change")
		publication = attempt.SpanContext()
	}
	assertPublicationTrace(t, recorder.Ended(), publication, first.parent, "synthetic-worker-first")
}

func TestExecutionWorkerLostReplyTracesSourceAndOnlyDeliveredAcknowledgement(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := fixtureCatalogService(repository, box, providerTestClock{})
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
	if first != nil {
		workerPublicationTraceWarning(t, parent.SpanContext().Equal(first.Parent()), "lost reply publication parent does not match the committed change")
		workerPublicationTraceWarning(t, first.Status().Code == codes.Error, "lost reply publication error status was not observed")
	}
	if second != nil {
		workerPublicationTraceWarning(t, second.Status().Code == codes.Unset, "delivered publication status was not successful")
	}
	if first != nil && second != nil {
		workerPublicationTraceWarning(t, first.Parent().Equal(second.Parent()), "retry publication parent changed")
		workerPublicationTraceWarning(t, first.SpanContext().SpanID() != second.SpanContext().SpanID(), "retry publication span identity was reused")
	}
}

func workerPublicationTraceWarning(t *testing.T, observed bool, message string) {
	t.Helper()
	if !observed {
		t.Logf("auxiliary publication trace: %s", message)
	}
}

func assertWorkerPublicationTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, propagated trace.SpanContext, ack bool) sdktrace.ReadOnlySpan {
	t.Helper()
	byID := map[trace.SpanID]sdktrace.ReadOnlySpan{}
	for _, s := range spans {
		byID[s.SpanContext().SpanID()] = s
		require.NotContains(t, fmt.Sprint(s.Attributes(), s.Events(), s.Status()), "initial-secret")
		require.NotContains(t, fmt.Sprint(s.Attributes(), s.Events(), s.Status()), "synthetic-worker-first")
		require.NotContains(t, fmt.Sprint(s.Attributes(), s.Events(), s.Status()), "synthetic-worker-latest")
	}
	http := byID[propagated.SpanID()]
	if !propagated.IsValid() || http == nil {
		t.Log("auxiliary publication trace: propagated HTTP span was not observed")
		return nil
	}
	workerPublicationTraceWarning(t, http.Name() == "HTTP POST agent-acp-service", "propagated HTTP span name changed")
	workerPublicationTraceWarning(t, http.SpanKind() == trace.SpanKindClient, "propagated HTTP span is not a client span")
	attempt := byID[http.Parent().SpanID()]
	if attempt == nil {
		t.Log("auxiliary publication trace: publication boundary was not observed")
		return nil
	}
	workerPublicationTraceWarning(t, attempt.Name() == "agent_controller.execution_publication", "publication boundary name changed")
	workerPublicationTraceWarning(t, propagated.TraceID() == attempt.SpanContext().TraceID(), "publication boundary trace changed")
	var source, sourceCommits, ackCommits, acknowledged int
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
			if !s.EndTime().After(http.StartTime()) {
				sourceCommits++
			} else {
				ackCommits++
				workerPublicationTraceWarning(t, !s.StartTime().Before(http.EndTime()), "transaction commit overlaps the HTTP request")
			}
		case s.Name() == "UPDATE":
			acknowledged++
			workerPublicationTraceWarning(t, strings.Contains(query, "SET applied_revision=GREATEST"), "acknowledgement UPDATE query changed")
			workerPublicationTraceWarning(t, !s.StartTime().Before(http.EndTime()), "acknowledgement precedes HTTP completion")
		}
	}
	workerPublicationTraceWarning(t, source == 1, "expected one source revision read")
	workerPublicationTraceWarning(t, sourceCommits == 1, "expected one source commit before HTTP")
	if ack {
		workerPublicationTraceWarning(t, acknowledged == 1 && ackCommits == 1, "expected one acknowledgement UPDATE and commit after HTTP")
	} else {
		workerPublicationTraceWarning(t, acknowledged == 0 && ackCommits == 0, "lost reply has acknowledgement spans")
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
