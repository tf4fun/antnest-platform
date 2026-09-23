package postgres

import (
	"context"
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/stretchr/testify/require"
	"go.opentelemetry.io/otel/trace"
)

type commitFailureTransaction struct{ pgx.Tx }

func (commitFailureTransaction) Commit(context.Context) error {
	return errors.New("synthetic commit failure")
}

func TestFailedCommitNeverInvokesCompletionCallbacks(t *testing.T) {
	called := false
	tx := &databaseTransaction{inner: commitFailureTransaction{}, span: trace.SpanFromContext(context.Background()),
		afterCommit: []func(){func() { called = true }}}
	require.Error(t, tx.Commit(t.Context()))
	require.False(t, called)
	require.Empty(t, tx.afterCommit, "failed completion must release captured metadata")
}
