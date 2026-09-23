package postgres

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/trace"
)

func TestExecutionCommitHintRequiresSuccessfulCommit(t *testing.T) {
	repository := providerTestRepository(t)
	var hints []string
	var parents []trace.SpanContext
	WithExecutionChangeObserver(func(ctx context.Context, organization string) {
		require.NoError(t, ctx.Err())
		hints = append(hints, organization)
		parents = append(parents, trace.SpanContextFromContext(ctx))
	})(repository)
	parent := trace.NewSpanContext(trace.SpanContextConfig{TraceID: trace.TraceID{1}, SpanID: trace.SpanID{2}})
	request, cancel := context.WithCancel(trace.ContextWithSpanContext(t.Context(), parent))
	tx, err := repository.pool.Begin(request)
	require.NoError(t, err)
	t.Cleanup(func() { _ = tx.Rollback(context.Background()) })
	require.NoError(t, repository.advanceExecutionRevision(request, tx, "org-1"))
	require.Empty(t, hints)
	cancel()
	require.NoError(t, tx.Commit(t.Context()))
	require.Equal(t, []string{"org-1"}, hints)
	require.Equal(t, parent, parents[0], "valid non-recording trace context must survive the transaction")
	state, err := repository.GetExecutionSynchronization(t.Context(), "org-1")
	require.NoError(t, err)
	require.EqualValues(t, 1, state.Revision)
	tx, err = repository.pool.Begin(t.Context())
	require.NoError(t, err)
	require.NoError(t, repository.advanceExecutionRevision(t.Context(), tx, "org-1"))
	require.NoError(t, tx.Rollback(t.Context()))
	require.Len(t, hints, 1)
}

func TestExecutionCommitHintIgnoresReplayedCatalogRequest(t *testing.T) {
	repository := providerTestRepository(t)
	hints := 0
	WithExecutionChangeObserver(func(context.Context, string) { hints++ })(repository)
	record := integrationModelRecord(t)
	seedProviderForModel(t, repository, record)
	_, err := repository.PutModelProfile(t.Context(), record)
	require.NoError(t, err)
	require.Equal(t, 2, hints, "Provider and Model each change execution configuration")
	_, err = repository.PutModelProfile(t.Context(), record)
	require.NoError(t, err)
	require.Equal(t, 2, hints)
}
