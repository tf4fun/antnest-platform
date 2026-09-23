package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"soft/antnest-platform/services/agent-controller/internal/acpclient"
	"soft/antnest-platform/services/agent-controller/internal/application"
	"soft/antnest-platform/services/agent-controller/internal/credentials"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type publicationCredentialOpener struct {
	repository *Repository
	box        *credentials.SecretBox
}

func (opener publicationCredentialOpener) Open(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret) (string, error) {
	if opener.repository.pool.Stat().AcquiredConns() != 0 {
		return "", errors.New("credential opening must follow database transaction closure")
	}
	return opener.box.Open(ctx, identity, sealed)
}

type observedExecutionPublication struct {
	snapshot receivedExecutionSnapshot
	parent   trace.SpanContext
}

// The HTTP peer decodes the wire contract, not Controller's outbound domain DTOs.
type receivedExecutionSnapshot struct {
	OrganizationID string                    `json:"organization_id"`
	Revision       int64                     `json:"revision"`
	Providers      []ports.ExecutionProvider `json:"providers"`
	Models         []json.RawMessage         `json:"models"`
	Agents         []json.RawMessage         `json:"agents"`
}

func TestExecutionPublisherPostgresAndHTTPResendCurrentCredentials(t *testing.T) {
	t.Setenv("ANTNEST_TELEMETRY_CAPTURE_RPC_CONTENT", "true")
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{})
	input := providerTestInput("create-publication", "org1")
	input.Credential.APIKey = "synthetic-publication-secret-first"
	connection, err := catalog.CreateProviderConnection(t.Context(), input)
	require.NoError(t, err)
	observed := make(chan observedExecutionPublication, 3)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		var snapshot receivedExecutionSnapshot
		if request.URL.Path != "/rpc/agent-acp/apply-execution-snapshot" || request.Method != http.MethodPost {
			t.Errorf("unexpected publication route %s %s", request.Method, request.URL.Path)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		if err := json.NewDecoder(request.Body).Decode(&snapshot); err != nil {
			t.Errorf("decode execution publication: %v", err)
			response.WriteHeader(http.StatusBadRequest)
			return
		}
		if repository.pool.Stat().AcquiredConns() != 0 {
			t.Error("publication retained a database connection during HTTP dispatch")
			response.WriteHeader(http.StatusInternalServerError)
			return
		}
		parent := propagation.TraceContext{}.Extract(request.Context(), propagation.HeaderCarrier(request.Header))
		observed <- observedExecutionPublication{snapshot: snapshot, parent: trace.SpanContextFromContext(parent)}
		if calls.Add(1) == 1 {
			// ACP may have applied the request before its connection disappears.
			panic(http.ErrAbortHandler)
		}
		response.Header().Set("Content-Type", "application/json")
		err := json.NewEncoder(response).Encode(ports.ExecutionAcknowledgement{OrganizationID: snapshot.OrganizationID, AppliedRevision: snapshot.Revision})
		if err != nil {
			t.Error(err)
		}
	}))
	t.Cleanup(server.Close)
	client, err := acpclient.New(server.URL, time.Second, server.Client())
	require.NoError(t, err)
	publisher := application.NewExecutionPublisher(repository, publicationCredentialOpener{repository: repository, box: box}, client)
	ctx, parent := otel.Tracer("publication-component-test").Start(t.Context(), "configuration change")
	result, err := publisher.Publish(ctx, "org1")
	parent.End()
	require.Error(t, err)
	require.Empty(t, result)
	require.EqualValues(t, 1, calls.Load(), "publication must send once before the response is lost; error=%v", err)
	first := <-observed
	require.Equal(t, input.Credential.APIKey, first.snapshot.Providers[0].Credential.Secret)
	require.Len(t, first.snapshot.Models, 2)
	assertExecutionSourceTrace(t, recorder.Ended(), parent.SpanContext())
	assertPublicationTrace(t, recorder.Ended(), parent.SpanContext(), first.parent, input.Credential.APIKey)
	state, err := repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.Zero(t, state.AppliedRevision)
	require.Nil(t, state.AppliedAt)
	rotated, err := catalog.RotateProviderCredential(t.Context(), application.RotateProviderCredentialInput{
		RequestID: "rotate-publication", OrganizationID: "org1", ConnectionID: connection.ConnectionID, ExpectedVersion: connection.CredentialVersion,
		Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic-publication-secret-current"},
	})
	require.NoError(t, err)
	for range 2 {
		acknowledgement, err := publisher.Publish(t.Context(), "org1")
		require.NoError(t, err)
		current := <-observed
		require.EqualValues(t, 2, current.snapshot.Revision)
		require.Equal(t, rotated.CredentialVersion, current.snapshot.Providers[0].CredentialRevision)
		require.Equal(t, "synthetic-publication-secret-current", current.snapshot.Providers[0].Credential.Secret)
		require.Equal(t, current.snapshot.Revision, acknowledgement.AppliedRevision)
	}
	state, err = repository.GetExecutionSynchronization(t.Context(), "org1")
	require.NoError(t, err)
	require.EqualValues(t, 2, state.AppliedRevision)
	require.Equal(t, state.Revision, state.AppliedRevision)
	require.NotNil(t, state.AppliedAt)
	require.Zero(t, repository.pool.Stat().AcquiredConns())
}

func assertPublicationTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, root, propagated trace.SpanContext, secret string) {
	t.Helper()
	require.True(t, propagated.IsValid())
	require.Equal(t, root.TraceID(), propagated.TraceID())
	found := false
	for _, span := range spans {
		if span.SpanContext().SpanID() == propagated.SpanID() {
			found = true
			require.Equal(t, trace.SpanKindClient, span.SpanKind())
			require.Equal(t, root.SpanID(), span.Parent().SpanID())
		}
		encoded, err := json.Marshal(struct {
			Attributes any
			Events     any
		}{span.Attributes(), span.Events()})
		require.NoError(t, err)
		require.NotContains(t, string(encoded), secret)
	}
	require.True(t, found, "outbound HTTP span must be the propagated request parent")
}
