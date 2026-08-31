package domain

import "fmt"

type DesiredState string

const (
	DesiredEnabled  DesiredState = "enabled"
	DesiredDisabled DesiredState = "disabled"
	DesiredDeleted  DesiredState = "deleted"
)

type AgentState string

const (
	AgentProvisioning AgentState = "provisioning"
	AgentAvailable    AgentState = "available"
	AgentUnavailable  AgentState = "unavailable"
	AgentDisabled     AgentState = "disabled"
	AgentDeleting     AgentState = "deleting"
	AgentDeleted      AgentState = "deleted"
)

var agentStateTransitions = map[AgentState]map[AgentState]struct{}{
	AgentProvisioning: stateSet(AgentAvailable, AgentUnavailable, AgentDeleting),
	AgentAvailable:    stateSet(AgentDisabled, AgentUnavailable, AgentDeleting),
	AgentDisabled:     stateSet(AgentAvailable, AgentUnavailable, AgentDeleting),
	AgentUnavailable:  stateSet(AgentAvailable, AgentDeleting),
	AgentDeleting:     stateSet(AgentDeleted),
	AgentDeleted:      stateSet(),
}

func ValidateAgentStateTransition(from AgentState, to AgentState) error {
	allowed, ok := agentStateTransitions[from]
	if !ok {
		return fmt.Errorf("unknown Agent state %q", from)
	}
	if _, ok := allowed[to]; !ok {
		return fmt.Errorf("Agent state transition %s -> %s is not allowed", from, to)
	}
	return nil
}

type Agent struct {
	desiredState             DesiredState
	state                    AgentState
	activeOperationRequestID string
}

func (agent Agent) CanAcquireRun() error {
	if agent.desiredState != DesiredEnabled {
		return fmt.Errorf("Agent desired state %s does not accept Runs", agent.desiredState)
	}
	if agent.state != AgentAvailable {
		return fmt.Errorf("Agent state %s does not accept Runs", agent.state)
	}
	if agent.activeOperationRequestID != "" {
		return fmt.Errorf("Agent lifecycle operation %s is active", agent.activeOperationRequestID)
	}
	return nil
}

func stateSet(values ...AgentState) map[AgentState]struct{} {
	result := make(map[AgentState]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}
