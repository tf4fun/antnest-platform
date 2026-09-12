package application

import (
	"context"
	"errors"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type WorkspaceStateInput struct {
	OrganizationID string
	PrincipalID    string
	AgentID        string
}

// WorkspaceAgentState is a current projection, not a replayable Run event.
type WorkspaceAgentState struct {
	AgentID         string
	Availability    WorkspaceAvailability
	AccessAllowed   bool
	AgentRevision   int64
	ActiveSessionID string
}

type WorkspaceStateEmitter func(WorkspaceAgentState) error

func (service *AgentQueryService) GetWorkspaceAgentState(ctx context.Context, input WorkspaceStateInput) (WorkspaceAgentState, error) {
	if !validIdentifier(input.OrganizationID) || !validIdentifier(input.PrincipalID) || !validIdentifier(input.AgentID) {
		return WorkspaceAgentState{}, fmt.Errorf("%w: workspace state scope", ErrInvalidInput)
	}
	rows, err := service.store.ListWorkspaceAgents(ctx, ports.WorkspaceAgentQuery{
		OrganizationID: input.OrganizationID, PrincipalID: input.PrincipalID, AgentID: input.AgentID, Limit: 2,
	})
	if err != nil {
		return WorkspaceAgentState{}, fmt.Errorf("read workspace state: %w", err)
	}
	if len(rows) == 0 {
		return WorkspaceAgentState{}, ErrAgentNotFound
	}
	if len(rows) != 1 || rows[0].AgentID != input.AgentID || rows[0].AggregateSequence < 1 {
		return WorkspaceAgentState{}, fmt.Errorf("%w: workspace state row", ErrQueryContract)
	}
	record := rows[0]
	if record.IdentityRevoked || record.DesiredState == domain.DesiredDeleted {
		return WorkspaceAgentState{}, ErrAgentNotFound
	}
	state := WorkspaceAgentState{
		AgentID: record.AgentID, Availability: workspaceAvailability(record),
		AccessAllowed: true, AgentRevision: record.AggregateSequence,
	}
	if record.AdmissionState == domain.AdmissionActive && record.AdmissionPrincipalID == input.PrincipalID {
		state.ActiveSessionID = record.SessionID
	}
	return state, nil
}

func (service *AgentQueryService) WatchWorkspaceAgentState(ctx context.Context, input WorkspaceStateInput, emit WorkspaceStateEmitter) error {
	if emit == nil {
		return fmt.Errorf("%w: workspace state emitter", ErrInvalidInput)
	}
	if service.notifications == nil {
		return fmt.Errorf("%w: workspace state notifier unavailable", ErrQueryContract)
	}
	var previous WorkspaceAgentState
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		// Subscribe before reading so a commit during the read or write causes another read.
		signal, err := service.notifications.SubscribeAgentEvents()
		if err != nil {
			return fmt.Errorf("subscribe workspace state: %w", err)
		}
		state, err := service.GetWorkspaceAgentState(ctx, input)
		if errors.Is(err, ErrAgentNotFound) && previous.AccessAllowed {
			return emit(WorkspaceAgentState{AgentID: input.AgentID, Availability: WorkspaceAgentOffline, AgentRevision: previous.AgentRevision})
		}
		if err != nil {
			return err
		}
		if state != previous {
			if err := emit(state); err != nil {
				return err
			}
			previous = state
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-signal:
		}
	}
}
