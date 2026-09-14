package postgres

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
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
	assertPublicationTrace(t, recorder.Ended(), parent.SpanContext(), first.parent, "synthetic-worker-first")
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
