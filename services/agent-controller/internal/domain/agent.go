package domain

type DesiredState string

const (
	DesiredEnabled  DesiredState = "enabled"
	DesiredDisabled DesiredState = "disabled"
	DesiredDeleted  DesiredState = "deleted"
)

type AgentState string

const AgentDeleted AgentState = "deleted"
