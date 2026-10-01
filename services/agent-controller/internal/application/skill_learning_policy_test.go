package application

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type learningPolicyStoreStub struct {
	agent    ports.AgentRecord
	policy   domain.SkillLearningPolicy
	write    ports.SetSkillLearningPolicy
	writeErr error
}

func (stub *learningPolicyStoreStub) GetAgent(context.Context, string) (ports.AgentRecord, error) {
	return stub.agent, nil
}
func (stub *learningPolicyStoreStub) GetSkillLearningPolicy(_ context.Context, scope ports.SkillLearningPolicyScope) (domain.SkillLearningPolicy, error) {
	if scope.OwnerPrincipalID != stub.agent.OwnerUserID {
		return domain.SkillLearningPolicy{}, ports.ErrAgentAccessDenied
	}
	return stub.policy, nil
}
func (stub *learningPolicyStoreStub) SetSkillLearningPolicy(_ context.Context, input ports.SetSkillLearningPolicy) (domain.SkillLearningPolicy, error) {
	stub.write = input
	return input.Policy, stub.writeErr
}

func TestSkillLearningPolicyServiceScopesReadAndMutationToCurrentOwner(t *testing.T) {
	store := &learningPolicyStoreStub{agent: agentConfigurationAgent(), policy: domain.DefaultSkillLearningPolicy("org-1", "agent-1", "user-1", time.Unix(1, 0))}
	service := NewSkillLearningPolicyService(store, agentConfigurationIdentity())
	read, err := service.Get(t.Context(), "org-1", "agent-1", "user-1")
	require.NoError(t, err)
	require.Equal(t, store.policy, read)
	result, err := service.Set(t.Context(), SetSkillLearningPolicyInput{
		RequestID: "change-1", OrganizationID: "org-1", AgentID: "agent-1", ActorPrincipalID: "user-1",
		ExpectedRevision: read.Revision, Mode: domain.LearningOff, Scope: read.Scope,
		PinnedPaths: []string{}, Limits: read.Limits,
	})
	require.NoError(t, err)
	require.Equal(t, domain.LearningOff, result.Mode)
	require.Equal(t, int64(2), store.write.Scope.OwnerRevocationSequence)
	require.Equal(t, "access-1", store.write.Scope.AccessRevision)
	require.Equal(t, read.Revision, store.write.ExpectedRevision)
	require.Equal(t, "change-1", store.write.RequestID)
	_, err = service.Get(t.Context(), "org-1", "agent-1", "other-user")
	require.ErrorIs(t, err, ErrAccessDenied)
	_, err = service.Get(t.Context(), "foreign-org", "agent-1", "user-1")
	require.ErrorIs(t, err, ErrAccessDenied)
}

func TestSkillLearningPolicyServiceRejectsUnsafeInputBeforeWrite(t *testing.T) {
	store := &learningPolicyStoreStub{agent: agentConfigurationAgent()}
	service := NewSkillLearningPolicyService(store, agentConfigurationIdentity())
	base := domain.DefaultSkillLearningPolicy("org-1", "agent-1", "user-1", time.Unix(1, 0))
	for _, test := range []struct {
		name string
		edit func(*SetSkillLearningPolicyInput)
	}{
		{"missing request id", func(i *SetSkillLearningPolicyInput) { i.RequestID = "" }},
		{"stale revision syntax", func(i *SetSkillLearningPolicyInput) { i.ExpectedRevision = "stale" }},
		{"invalid path", func(i *SetSkillLearningPolicyInput) { i.Scope.AdoptedPaths = []string{"../escape"} }},
		{"excess budget", func(i *SetSkillLearningPolicyInput) { i.Limits.DailyReviews = 21 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			input := SetSkillLearningPolicyInput{RequestID: "change-1", OrganizationID: "org-1", AgentID: "agent-1", ActorPrincipalID: "user-1", ExpectedRevision: base.Revision, Mode: base.Mode, Scope: base.Scope, PinnedPaths: []string{}, Limits: base.Limits}
			test.edit(&input)
			_, err := service.Set(t.Context(), input)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Empty(t, store.write.RequestID)
		})
	}
}

func TestSkillLearningPolicyServiceDoesNotAdmitUnknownManagedPaths(t *testing.T) {
	store := &learningPolicyStoreStub{agent: agentConfigurationAgent()}
	service := NewSkillLearningPolicyService(store, agentConfigurationIdentity())
	base := domain.DefaultSkillLearningPolicy("org-1", "agent-1", "user-1", time.Unix(1, 0))
	input := SetSkillLearningPolicyInput{RequestID: "adopt-1", OrganizationID: "org-1", AgentID: "agent-1", ActorPrincipalID: "user-1",
		ExpectedRevision: base.Revision, Mode: base.Mode, Scope: base.Scope, PinnedPaths: []string{}, Limits: base.Limits}
	input.Scope.AdoptedPaths = []string{".antnest/skills/known"}
	_, err := service.Set(t.Context(), input)
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Empty(t, store.write.RequestID)
}

func TestSkillLearningPolicyServiceAllowsOwnerToPinWithoutGrantingMaintenance(t *testing.T) {
	store := &learningPolicyStoreStub{agent: agentConfigurationAgent()}
	service := NewSkillLearningPolicyService(store, agentConfigurationIdentity())
	base := domain.DefaultSkillLearningPolicy("org-1", "agent-1", "user-1", time.Unix(1, 0))
	input := SetSkillLearningPolicyInput{RequestID: "pin-1", OrganizationID: "org-1", AgentID: "agent-1", ActorPrincipalID: "user-1",
		ExpectedRevision: base.Revision, Mode: base.Mode, Scope: base.Scope,
		PinnedPaths: []string{".antnest/skills/known"}, Limits: base.Limits}
	result, err := service.Set(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, []string{".antnest/skills/known"}, result.PinnedPaths)
	require.Empty(t, result.Scope.AdoptedPaths)
	require.Equal(t, "pin-1", store.write.RequestID)
}
