package domain

const (
	AgentNotCreated AgentState = "not_created"
	AgentCreated    AgentState = "created"
)

type ActivationState string

const (
	ActivationEnabled  ActivationState = "enabled"
	ActivationDisabled ActivationState = "disabled"
)

type RuntimeState string

const (
	RuntimeUnknown   RuntimeState = "unknown"
	RuntimeWaiting   RuntimeState = "waiting"
	RuntimeAvailable RuntimeState = "available"
	RuntimeUnhealthy RuntimeState = "unhealthy"
	RuntimeExited    RuntimeState = "exited"
	RuntimeAbsent    RuntimeState = "absent"
)

type AgentStatus struct {
	Lifecycle  AgentState
	Activation ActivationState
	Runtime    RuntimeState
}

func (state AgentStatus) RuntimeReady() bool {
	return state.Lifecycle == AgentCreated && state.Activation == ActivationEnabled && state.Runtime == RuntimeAvailable
}

func ObservedRuntimeState(phase, health string) RuntimeState {
	switch phase {
	case "created":
		return RuntimeWaiting
	case "exited":
		return RuntimeExited
	case "absent":
		return RuntimeAbsent
	case "running":
		switch health {
		case "healthy":
			return RuntimeAvailable
		case "starting":
			return RuntimeWaiting
		case "unhealthy":
			return RuntimeUnhealthy
		}
	}
	return RuntimeUnknown
}
