package postgres

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
)

func TestAgentOwnershipConstraintsRejectBindingDrift(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedAvailableAgentForRebuild(t, ctx, repository)

	_, err = repository.pool.Exec(ctx, `
INSERT INTO agent_controller.agent_access_bindings (
    agent_id, principal_id, access_revision, active, created_at, updated_at
)
SELECT agent_id, principal_id, access_revision, active, created_at, updated_at
FROM agent_controller.agent_access_bindings WHERE agent_id = $1`, base.Agent.AgentID)
	assertConstraint(t, err, "agent_access_bindings_pkey")

	assertDeferredOwnershipConstraint(t, ctx, repository, base.Agent.AgentID,
		"UPDATE agent_controller.agent_access_bindings SET principal_id = 'another-user' WHERE agent_id = $1",
		"access_bindings_owner_fk")
	assertDeferredOwnershipConstraint(t, ctx, repository, base.Agent.AgentID,
		"UPDATE agent_controller.agent_access_bindings SET access_revision = 'another-revision' WHERE agent_id = $1",
		"access_bindings_owner_fk")
}

func assertDeferredOwnershipConstraint(
	t *testing.T,
	ctx context.Context,
	repository *Repository,
	agentID string,
	query string,
	constraint string,
) {
	t.Helper()
	transaction, err := repository.pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin ownership drift transaction: %v", err)
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	if _, err := transaction.Exec(ctx, query, agentID); err != nil {
		t.Fatalf("stage ownership drift: %v", err)
	}
	assertConstraint(t, transaction.Commit(ctx), constraint)
}

func assertConstraint(t *testing.T, err error, constraint string) {
	t.Helper()
	var databaseError *pgconn.PgError
	if !errors.As(err, &databaseError) || databaseError.ConstraintName != constraint {
		t.Fatalf("constraint error = %v, want %s", err, constraint)
	}
}
