package application

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionSynchronizationReadReportsStoredConfirmationOnly(t *testing.T) {
	t.Parallel()
	now := time.Unix(100, 0).UTC()
	for _, test := range []struct {
		name      string
		applied   int64
		appliedAt *time.Time
	}{
		{"never confirmed", 0, nil},
		{"older confirmation", 7, &now},
		{"current confirmation", 8, &now},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &agentConfigurationStoreStub{synchronization: ports.ExecutionSynchronization{
				OrganizationID: "org-1", Revision: 8, AppliedRevision: test.applied, UpdatedAt: now.Add(-time.Minute), AppliedAt: test.appliedAt,
			}}
			service := NewAgentConfigurationService(store, nil, nil)
			view, err := service.GetExecutionSynchronization(t.Context(), "org-1")
			require.NoError(t, err)
			require.Equal(t, "org-1", view.OrganizationID)
			require.Equal(t, "org-1", store.synchronizationOrganization)
			require.Equal(t, 1, store.synchronizationReads)
			require.NotNil(t, view.Synchronization)
			require.Equal(t, int64(8), view.Synchronization.Revision)
			require.Equal(t, test.applied, view.Synchronization.AppliedRevision)
			require.Equal(t, test.appliedAt, view.Synchronization.AppliedAt)
			require.Equal(t, store.synchronization.UpdatedAt, view.Synchronization.UpdatedAt)
			require.Empty(t, store.write)
		})
	}
}

func TestExecutionSynchronizationMissingIsNotAnAcknowledgement(t *testing.T) {
	t.Parallel()
	store := &agentConfigurationStoreStub{synchronizationErr: ports.ErrNotFound}
	view, err := NewAgentConfigurationService(store, nil, nil).GetExecutionSynchronization(t.Context(), "org-1")
	require.NoError(t, err)
	require.Equal(t, "org-1", view.OrganizationID)
	require.Nil(t, view.Synchronization)
	require.Equal(t, 1, store.synchronizationReads)
}

func TestExecutionSynchronizationRejectsInvalidScopeBeforeReading(t *testing.T) {
	t.Parallel()
	for _, organizationID := range []string{"", " org-1", "org-1 ", "org-1,org-2", "org\n1", strings.Repeat("a", 201)} {
		t.Run(organizationID, func(t *testing.T) {
			store := &agentConfigurationStoreStub{}
			_, err := NewAgentConfigurationService(store, nil, nil).GetExecutionSynchronization(t.Context(), organizationID)
			require.ErrorIs(t, err, ErrInvalidInput)
			require.Zero(t, store.synchronizationReads)
		})
	}
}

func TestExecutionSynchronizationReadFailureIsNotAnEmptyView(t *testing.T) {
	t.Parallel()
	for _, cause := range []error{errors.New("database unavailable"), context.DeadlineExceeded, context.Canceled} {
		t.Run(cause.Error(), func(t *testing.T) {
			store := &agentConfigurationStoreStub{synchronizationErr: cause}
			view, err := NewAgentConfigurationService(store, nil, nil).GetExecutionSynchronization(t.Context(), "org-1")
			require.ErrorIs(t, err, cause)
			require.Empty(t, view)
		})
	}
}

func TestExecutionSynchronizationRejectsInconsistentStoredRecord(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name   string
		change func(*ports.ExecutionSynchronization)
	}{
		{"another organization", func(state *ports.ExecutionSynchronization) { state.OrganizationID = "org-2" }},
		{"zero revision", func(state *ports.ExecutionSynchronization) { state.Revision = 0 }},
		{"unsafe revision", func(state *ports.ExecutionSynchronization) { state.Revision = ports.MaximumExecutionRevision + 1 }},
		{"negative confirmation", func(state *ports.ExecutionSynchronization) { state.AppliedRevision = -1 }},
		{"future confirmation", func(state *ports.ExecutionSynchronization) { state.AppliedRevision = 9 }},
		{"missing update time", func(state *ports.ExecutionSynchronization) { state.UpdatedAt = time.Time{} }},
		{"missing confirmation time", func(state *ports.ExecutionSynchronization) { state.AppliedAt = nil }},
		{"zero confirmation time", func(state *ports.ExecutionSynchronization) { state.AppliedAt = new(time.Time) }},
		{"unconfirmed timestamp", func(state *ports.ExecutionSynchronization) { state.AppliedRevision = 0 }},
	} {
		t.Run(test.name, func(t *testing.T) {
			now := time.Unix(100, 0).UTC()
			state := ports.ExecutionSynchronization{OrganizationID: "org-1", Revision: 8, AppliedRevision: 7, UpdatedAt: now, AppliedAt: &now}
			test.change(&state)
			view, err := NewAgentConfigurationService(&agentConfigurationStoreStub{synchronization: state}, nil, nil).GetExecutionSynchronization(t.Context(), "org-1")
			require.ErrorIs(t, err, ErrQueryContract)
			require.Empty(t, view)
		})
	}
}
