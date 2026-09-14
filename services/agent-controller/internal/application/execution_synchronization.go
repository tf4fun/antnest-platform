package application

import (
	"context"
	"errors"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ExecutionSynchronizationView struct {
	OrganizationID  string                         `json:"organization_id"`
	Synchronization *ExecutionSynchronizationState `json:"synchronization"`
}

type ExecutionSynchronizationState struct {
	Revision        int64      `json:"revision"`
	AppliedRevision int64      `json:"applied_revision"`
	UpdatedAt       time.Time  `json:"updated_at"`
	AppliedAt       *time.Time `json:"applied_at"`
}

func (service *AgentConfigurationService) GetExecutionSynchronization(ctx context.Context, organizationID string) (ExecutionSynchronizationView, error) {
	if !validIdentifier(organizationID) {
		return ExecutionSynchronizationView{}, fmt.Errorf("%w: organization identity", ErrInvalidInput)
	}
	state, err := service.store.GetExecutionSynchronization(ctx, organizationID)
	if errors.Is(err, ports.ErrNotFound) {
		return ExecutionSynchronizationView{OrganizationID: organizationID}, nil
	}
	if err != nil {
		return ExecutionSynchronizationView{}, fmt.Errorf("read execution synchronization: %w", err)
	}
	if state.OrganizationID != organizationID || !validExecutionSynchronization(state) {
		return ExecutionSynchronizationView{}, fmt.Errorf("%w: execution synchronization", ErrQueryContract)
	}
	return ExecutionSynchronizationView{OrganizationID: organizationID, Synchronization: &ExecutionSynchronizationState{
		Revision: state.Revision, AppliedRevision: state.AppliedRevision, UpdatedAt: state.UpdatedAt, AppliedAt: state.AppliedAt,
	}}, nil
}

func validExecutionSynchronization(state ports.ExecutionSynchronization) bool {
	if state.Revision < 1 || state.Revision > ports.MaximumExecutionRevision ||
		state.AppliedRevision < 0 || state.AppliedRevision > state.Revision || state.UpdatedAt.IsZero() {
		return false
	}
	if state.AppliedRevision == 0 {
		return state.AppliedAt == nil
	}
	return state.AppliedAt != nil && !state.AppliedAt.IsZero()
}
