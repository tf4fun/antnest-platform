package postgres

import (
	"errors"
	"os"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestSkillLearningPolicyDefaultCASAndIdempotencySurviveRepositoryRestart(t *testing.T) {
	store := providerTestRepository(t)
	ctx := t.Context()
	createdAt := time.Now().UTC().Add(-24 * time.Hour).Truncate(time.Microsecond)
	insertQueryAgent(t, ctx, store, "learning-agent", "learning-org", "learning-owner", domain.DesiredDisabled, domain.AgentCreated, createdAt)
	_, err := store.pool.Exec(ctx, `INSERT INTO agent_controller.agent_access_bindings
 (agent_id, principal_id, access_revision, active, created_at, updated_at)
 VALUES ('learning-agent','learning-owner','access-learning-agent',true,NOW(),NOW())`)
	require.NoError(t, err)
	scope := ports.SkillLearningPolicyScope{OrganizationID: "learning-org", AgentID: "learning-agent",
		OwnerPrincipalID: "learning-owner", AccessRevision: "access-learning-agent"}
	initial, err := store.GetSkillLearningPolicy(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, domain.LearningAutomatic, initial.Mode)
	require.NotEmpty(t, initial.Revision)
	require.True(t, initial.ActivationCutAt.Equal(createdAt), "lazy default read must retain Agent creation cut")
	input := ports.SetSkillLearningPolicy{Scope: scope, RequestID: "learning-change-1", ExpectedRevision: initial.Revision, Policy: initial}
	input.Policy.Mode = domain.LearningOff
	input.Policy.PinnedPaths = []string{".antnest/skills/keep-user-owned"}
	updated, err := store.SetSkillLearningPolicy(ctx, input)
	require.NoError(t, err)
	require.Equal(t, domain.LearningOff, updated.Mode)
	require.Equal(t, input.Policy.PinnedPaths, updated.PinnedPaths)
	require.True(t, updated.ActivationCutAt.Equal(initial.ActivationCutAt))
	require.NotEqual(t, initial.Revision, updated.Revision)
	var aggregateSequence int64
	err = store.pool.QueryRow(ctx, `SELECT aggregate_sequence FROM agent_controller.agents WHERE id=$1`, scope.AgentID).Scan(&aggregateSequence)
	require.NoError(t, err)
	require.EqualValues(t, 1, aggregateSequence, "policy changes must not revise the Agent lifecycle or Spec")
	loaded, err := store.GetSkillLearningPolicy(ctx, scope)
	require.NoError(t, err)
	require.Equal(t, updated, loaded)
	restarted, err := Open(ctx, os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL"))
	require.NoError(t, err)
	t.Cleanup(restarted.Close)
	// The same request replays its committed receipt after a repository restart,
	// even with a now-stale base.
	replayed, err := restarted.SetSkillLearningPolicy(ctx, input)
	require.NoError(t, err)
	require.Equal(t, updated, replayed)
	reenabledInput := ports.SetSkillLearningPolicy{Scope: scope, RequestID: "learning-change-3",
		ExpectedRevision: updated.Revision, Policy: updated}
	reenabledInput.Policy.Mode = domain.LearningAutomatic
	reenabled, err := restarted.SetSkillLearningPolicy(ctx, reenabledInput)
	require.NoError(t, err)
	require.True(t, reenabled.ActivationCutAt.After(initial.ActivationCutAt),
		"re-enabling after off must not backscan Runs from the disabled interval")
	reenabledReplay, err := restarted.SetSkillLearningPolicy(ctx, reenabledInput)
	require.NoError(t, err)
	require.Equal(t, reenabled, reenabledReplay)
	changed := input
	changed.Policy.Mode = domain.LearningAutomatic
	_, err = store.SetSkillLearningPolicy(ctx, changed)
	require.ErrorIs(t, err, ports.ErrRequestConflict)
	stale := input
	stale.RequestID = "learning-change-2"
	_, err = store.SetSkillLearningPolicy(ctx, stale)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	foreign := scope
	foreign.OwnerPrincipalID = "other-owner"
	_, err = store.GetSkillLearningPolicy(ctx, foreign)
	require.True(t, errors.Is(err, ports.ErrAgentAccessDenied) || errors.Is(err, ports.ErrNotFound))
}
