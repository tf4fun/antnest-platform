package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type agentConfigurationStoreStub struct {
	agent                       ports.AgentRecord
	readErr                     error
	writeErr                    error
	write                       ports.SetAgentAuthorization
	synchronization             ports.ExecutionSynchronization
	synchronizationErr          error
	synchronizationOrganization string
	synchronizationReads        int
}

func (store *agentConfigurationStoreStub) GetExecutionSynchronization(_ context.Context, organizationID string) (ports.ExecutionSynchronization, error) {
	store.synchronizationOrganization = organizationID
	store.synchronizationReads++
	return store.synchronization, store.synchronizationErr
}

func (store *agentConfigurationStoreStub) GetAgent(context.Context, string) (ports.AgentRecord, error) {
	return store.agent, store.readErr
}

func (store *agentConfigurationStoreStub) SetAgentAuthorization(_ context.Context, input ports.SetAgentAuthorization) (int64, error) {
	store.write = input
	return input.ExpectedRevision + 1, store.writeErr
}

func agentConfigurationInput() SetAgentAuthorizationInput {
	return SetAgentAuthorizationInput{RequestID: "set-default", AgentID: "agent-1", PrincipalID: "user-1",
		ExpectedAccessRevision: "access-1", ExpectedAuthorizationRevision: 3,
		Authorization: domain.Authorization{Mode: domain.AuthorizationApprove, ToolRules: []domain.ToolRule{}}}
}

func agentConfigurationAgent() ports.AgentRecord {
	return ports.AgentRecord{AgentID: "agent-1", OrganizationID: "org-1", OwnerUserID: "user-1",
		AccessRevision: "access-1", DesiredState: domain.DesiredDisabled, OwnerAuthorizationSequence: 2}
}

func agentConfigurationIdentity() *identityDirectoryStub {
	identity := activeIdentityDirectory()
	identity.principal.LastRevocationSequence = 2
	return identity
}

func TestAgentConfigurationUpdatesDefaultWithoutExecutionDependencies(t *testing.T) {
	t.Parallel()
	store := &agentConfigurationStoreStub{agent: agentConfigurationAgent()}
	identities := agentConfigurationIdentity()
	identities.principal.LastRevocationSequence = 2
	now := time.Unix(1, 0).UTC()
	service := NewAgentConfigurationService(store, identities, fixedClock{now: now})
	input := agentConfigurationInput()
	revision, err := service.SetAgentAuthorization(t.Context(), input)
	require.NoError(t, err)
	require.Equal(t, int64(4), revision)
	require.Equal(t, int64(3), store.write.ExpectedRevision)
	require.Equal(t, int64(2), store.write.OwnerRevocationSequence)
	require.Equal(t, ports.AgentOwnerScope{AgentID: input.AgentID, PrincipalID: input.PrincipalID, ExpectedAccessRevision: input.ExpectedAccessRevision}, store.write.Query)
	require.Equal(t, input.Authorization, store.write.Authorization)
	require.Equal(t, now, store.write.Now)
	firstEvent := store.write.EventID
	require.NotEmpty(t, firstEvent)
	input.ExpectedAuthorizationRevision++
	_, err = service.SetAgentAuthorization(t.Context(), input)
	require.NoError(t, err)
	require.NotEqual(t, firstEvent, store.write.EventID)
}

func TestAgentConfigurationRejectsInvalidInputBeforeReadingOwner(t *testing.T) {
	t.Parallel()
	for name, mutate := range map[string]func(*SetAgentAuthorizationInput){
		"request":                func(i *SetAgentAuthorizationInput) { i.RequestID = "" },
		"agent":                  func(i *SetAgentAuthorizationInput) { i.AgentID = "" },
		"principal":              func(i *SetAgentAuthorizationInput) { i.PrincipalID = "" },
		"access revision":        func(i *SetAgentAuthorizationInput) { i.ExpectedAccessRevision = "" },
		"authorization revision": func(i *SetAgentAuthorizationInput) { i.ExpectedAuthorizationRevision = 0 },
		"mode":                   func(i *SetAgentAuthorizationInput) { i.Authorization.Mode = "unknown" },
	} {
		t.Run(name, func(t *testing.T) {
			input := agentConfigurationInput()
			mutate(&input)
			_, err := NewAgentConfigurationService(nil, nil, fixedClock{}).SetAgentAuthorization(t.Context(), input)
			require.ErrorIs(t, err, ErrInvalidInput)
		})
	}
}

func TestAgentConfigurationRequiresCurrentActiveOwner(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		mutate func(*ports.AgentRecord, *identityDirectoryStub)
		want   error
	}{
		{"foreign owner", func(a *ports.AgentRecord, _ *identityDirectoryStub) { a.OwnerUserID = "another" }, ErrAccessDenied},
		{"stale access", func(a *ports.AgentRecord, _ *identityDirectoryStub) { a.AccessRevision = "changed" }, ErrAccessDenied},
		{"deleted", func(a *ports.AgentRecord, _ *identityDirectoryStub) { a.DesiredState = domain.DesiredDeleted }, ErrAccessDenied},
		{"revoked", func(a *ports.AgentRecord, _ *identityDirectoryStub) { a.IdentityRevocationSequence = 3 }, ErrAccessDenied},
		{"inactive", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.Active = false }, ErrAccessDenied},
		{"foreign membership", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.OrganizationID = "other-org" }, ErrAccessDenied},
		{"missing membership", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.MembershipID = " " }, ErrAccessDenied},
		{"unobserved revocation", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.LastRevocationSequence = 3 }, ErrAccessDenied},
		{"stale identity proof", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.LastRevocationSequence = 1 }, ErrAccessDenied},
		{"negative identity proof", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.LastRevocationSequence = -1 }, ErrAccessDenied},
		{"foreign identity", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.principal.UserID = "foreign-user" }, ErrAccessDenied},
		{"identity unavailable", func(_ *ports.AgentRecord, i *identityDirectoryStub) { i.err = errors.New("offline") }, ErrDependencyUnavailable},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &agentConfigurationStoreStub{agent: agentConfigurationAgent()}
			identities := agentConfigurationIdentity()
			test.mutate(&store.agent, identities)
			_, err := NewAgentConfigurationService(store, identities, fixedClock{}).SetAgentAuthorization(t.Context(), agentConfigurationInput())
			require.ErrorIs(t, err, test.want)
			require.Empty(t, store.write.EventID)
		})
	}
}

func TestAgentConfigurationMapsPersistenceFailures(t *testing.T) {
	t.Parallel()
	for _, test := range []struct{ cause, want error }{
		{ports.ErrNotFound, ErrAgentNotFound},
		{ports.ErrAgentAccessDenied, ErrAccessDenied},
		{ports.ErrConcurrentChange, ports.ErrConcurrentChange},
	} {
		store := &agentConfigurationStoreStub{agent: agentConfigurationAgent(), writeErr: test.cause}
		_, err := NewAgentConfigurationService(store, agentConfigurationIdentity(), fixedClock{}).SetAgentAuthorization(t.Context(), agentConfigurationInput())
		require.ErrorIs(t, err, test.want)
	}
	store := &agentConfigurationStoreStub{agent: agentConfigurationAgent()}
	_, err := NewAgentConfigurationService(store, nil, fixedClock{}).SetAgentAuthorization(t.Context(), agentConfigurationInput())
	require.ErrorIs(t, err, ErrDependencyUnavailable)
	require.Empty(t, store.write.EventID)
}
