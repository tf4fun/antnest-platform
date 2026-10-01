package postgres

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type executionReadPause struct {
	base    pgx.QueryTracer
	reached chan struct{}
	resume  chan struct{}
	once    sync.Once
}

type executionReadPauseKey struct{}

func (pause *executionReadPause) TraceQueryStart(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	ctx = pause.base.TraceQueryStart(ctx, connection, data)
	if data.SQL == executionRevisionQuery {
		return context.WithValue(ctx, executionReadPauseKey{}, true)
	}
	return ctx
}

func (pause *executionReadPause) TraceQueryEnd(ctx context.Context, connection *pgx.Conn, data pgx.TraceQueryEndData) {
	pause.base.TraceQueryEnd(ctx, connection, data)
	if ctx.Value(executionReadPauseKey{}) == true {
		pause.once.Do(func() {
			close(pause.reached)
			select {
			case <-pause.resume:
			case <-ctx.Done():
			}
		})
	}
}

func TestExecutionPublicationReadIsOneMVCCSnapshot(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	provider := executionProvider(model.OrganizationID, model.ProviderConnectionID)
	provider.BaseURL = model.Revision.Snapshot().Model.BaseURL
	_, err := repository.PutProviderConnection(t.Context(), provider, []ports.ModelProfileRecord{model})
	require.NoError(t, err)
	configuration := repository.pool.Config()
	pause := &executionReadPause{base: configuration.ConnConfig.Tracer, reached: make(chan struct{}), resume: make(chan struct{})}
	configuration.ConnConfig.Tracer = pause
	pool, err := pgxpool.NewWithConfig(t.Context(), configuration)
	require.NoError(t, err)
	reader := &Repository{pool: &databasePool{pool}}
	t.Cleanup(reader.Close)
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var snapshot ports.ExecutionSource
	var readErr error
	done := make(chan struct{})
	go func() { defer close(done); snapshot, readErr = reader.ReadExecutionSource(ctx, model.OrganizationID) }()
	defer func() { cancel(); <-done }()
	select {
	case <-pause.reached:
	case <-ctx.Done():
		t.Fatal("source read did not reach its revision", ctx.Err())
	}
	provider.RequestID, provider.CredentialVersion, provider.CredentialRevision = "rotate", "credential-2", 2
	provider.SealedCredential.Ciphertext = []byte("synthetic-rotated-ciphertext")
	_, err = repository.RotateProviderCredential(ctx, "credential-1", provider)
	require.NoError(t, err)
	priced := reviseProfilePricing(t, repository, model, 2, 8)
	close(pause.resume)
	<-done
	require.NoError(t, readErr)
	require.EqualValues(t, 1, snapshot.Revision)
	require.Equal(t, "credential-1", snapshot.Providers[0].CredentialVersion)
	require.Equal(t, "synthetic-ciphertext", string(snapshot.Providers[0].SealedCredential.Ciphertext))
	current, err := repository.ReadExecutionSource(ctx, model.OrganizationID)
	require.NoError(t, err)
	require.EqualValues(t, 3, current.Revision)
	require.Equal(t, "credential-2", current.Providers[0].CredentialVersion)
	require.Equal(t, model.Revision.Snapshot(), snapshot.Models[0].Revision.Snapshot(), "one publication cannot mix a previous revision with new Model parameters")
	require.Equal(t, priced.Revision.Snapshot(), current.Models[0].Revision.Snapshot())
}

func TestExecutionPublicationReadsWholeCatalogWithOneTransactionTrace(t *testing.T) {
	recorder := installDatabaseSpanRecorder(t)
	repository := providerTestRepository(t)
	base := integrationModelRecord(t)
	provider := executionProvider(base.OrganizationID, base.ProviderConnectionID)
	models := make([]ports.ModelProfileRecord, 205)
	for i := range models {
		model := base
		model.ModelProfileID = fmt.Sprintf("model-%03d", i)
		model.ProfileKey = model.ModelProfileID
		input := domain.ModelProfileRevisionInput(base.Revision.Snapshot())
		input.ModelProfileID, input.ID = model.ModelProfileID, "config-"+model.ModelProfileID
		input.Model.Model = model.ModelProfileID
		var err error
		model.Revision, err = domain.NewModelProfileRevision(input)
		require.NoError(t, err)
		models[i] = model
	}
	_, err := repository.PutProviderConnection(t.Context(), provider, models)
	require.NoError(t, err)
	page, cursor, err := repository.ListModelProfiles(t.Context(), provider.OrganizationID, "", 200)
	require.NoError(t, err)
	require.Len(t, page, 200)
	require.NotEmpty(t, cursor)
	ctx, parent := otel.Tracer("execution-source-test").Start(t.Context(), "publish configuration")
	source, err := repository.ReadExecutionSource(ctx, provider.OrganizationID)
	parent.End()
	require.NoError(t, err)
	require.Len(t, source.Models, len(models))
	require.Equal(t, models[204].ModelProfileID, source.Models[204].ModelProfileID)
	assertExecutionSourceTrace(t, recorder.Ended(), parent.SpanContext())
}

func assertExecutionSourceTrace(t *testing.T, spans []sdktrace.ReadOnlySpan, parent trace.SpanContext) {
	t.Helper()
	var transaction trace.SpanContext
	for _, span := range spans {
		if span.Name() == "postgresql transaction" {
			require.False(t, transaction.IsValid(), "multiple source transactions")
			transaction = span.SpanContext()
			require.Equal(t, parent.SpanID(), span.Parent().SpanID())
		}
	}
	require.True(t, transaction.IsValid())
	selects := 0
	for _, span := range spans {
		if span.Name() == "SELECT" {
			selects++
			require.Equal(t, transaction.SpanID(), span.Parent().SpanID())
		}
	}
	require.Equal(t, 4, selects, "source queries must not grow with the catalog or Agent count")
}

func TestExecutionPublicationOrganizationListingAndEmptySnapshot(t *testing.T) {
	repository := providerTestRepository(t)
	for _, org := range []string{"org-c", "org-a", "org-b"} {
		_, err := repository.PutProviderConnection(t.Context(), executionProvider(org, "provider-"+org), nil)
		require.NoError(t, err)
	}
	first, err := repository.ListExecutionOrganizations(t.Context(), "", 2)
	require.NoError(t, err)
	require.Equal(t, []string{"org-a", "org-b"}, first)
	last, err := repository.ListExecutionOrganizations(t.Context(), first[1], 2)
	require.NoError(t, err)
	require.Equal(t, []string{"org-c"}, last)
	_, err = repository.ListExecutionOrganizations(t.Context(), "", 0)
	require.Error(t, err)
	_, err = repository.pool.Exec(t.Context(), `DELETE FROM agent_controller.provider_connections WHERE organization_id='org-c'`)
	require.NoError(t, err)
	empty, err := repository.ReadExecutionSource(t.Context(), "org-c")
	require.NoError(t, err)
	require.Equal(t, "org-c", empty.OrganizationID)
	require.NotNil(t, empty.Providers)
	require.NotNil(t, empty.Models)
	require.NotNil(t, empty.Agents)
	require.Empty(t, empty.Providers)
	require.EqualValues(t, 1, empty.Revision)
}
