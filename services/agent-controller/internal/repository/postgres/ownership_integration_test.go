package postgres

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

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
    access_subject, agent_id, principal_id, access_revision, active,
    prompt_image, prompt_embedded_context, created_at, updated_at
)
SELECT 'duplicate-owner-subject', agent_id, principal_id, access_revision, active,
       prompt_image, prompt_embedded_context, created_at, updated_at
FROM agent_controller.agent_access_bindings WHERE agent_id = $1`, base.Agent.AgentID)
	assertConstraint(t, err, "access_bindings_agent_unique")

	assertDeferredOwnershipConstraint(t, ctx, repository, base.Agent.AgentID,
		"UPDATE agent_controller.agent_access_bindings SET principal_id = 'another-user' WHERE agent_id = $1",
		"access_bindings_owner_fk")
	assertDeferredOwnershipConstraint(t, ctx, repository, base.Agent.AgentID,
		"UPDATE agent_controller.agent_access_bindings SET access_revision = 'another-revision' WHERE agent_id = $1",
		"access_bindings_owner_fk")
}

func TestRunAdmissionRequiresExplicitEmptySkillInstructions(t *testing.T) {
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

	runtime := fmt.Sprintf(`"runtime":{"runtime_revision":%q}`, base.Agent.RuntimeRevision)
	cases := []struct {
		name     string
		snapshot string
		valid    bool
	}{
		{name: "missing execution spec", snapshot: "{" + runtime + "}"},
		{name: "null execution spec", snapshot: "{" + runtime + `,"execution_spec":null}`},
		{name: "null skill instructions", snapshot: "{" + runtime + `,"execution_spec":{"skill_instructions":null}}`},
		{name: "nonempty skill instructions", snapshot: "{" + runtime + `,"execution_spec":{"skill_instructions":["skill"]}}`},
		{name: "empty skill instructions", snapshot: "{" + runtime + `,"execution_spec":{"skill_instructions":[]}}`, valid: true},
	}
	for index, testCase := range cases {
		admissionID := fmt.Sprintf("admission-empty-skills-%d", index)
		now := time.Unix(1400+int64(index), 0).UTC()
		_, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.run_admissions (
    admission_id, request_id, request_fingerprint, agent_id, session_id,
    principal_id, access_revision, state, deadline, runtime_revision,
    snapshot, created_at, updated_at
) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10::jsonb, $11, $11)`,
			admissionID, "request-"+admissionID, strings.Repeat("f", 64), base.Agent.AgentID,
			"session-"+admissionID, base.Agent.OwnerUserID, base.Agent.AccessRevision,
			now.Add(time.Hour), base.Agent.RuntimeRevision, testCase.snapshot, now,
		)
		if !testCase.valid {
			assertConstraint(t, err, "run_admissions_empty_skills")
			continue
		}
		if err != nil {
			t.Fatalf("%s: insert valid admission: %v", testCase.name, err)
		}
		if _, err := repository.pool.Exec(ctx,
			"DELETE FROM agent_controller.run_admissions WHERE admission_id = $1", admissionID,
		); err != nil {
			t.Fatalf("%s: delete valid admission: %v", testCase.name, err)
		}
	}
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
