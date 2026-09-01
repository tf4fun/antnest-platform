package ports

import "context"

type AgentEventQuery struct {
	AgentID       string
	AfterSequence int64
	Limit         int
}

type AgentEventStore interface {
	ListAgentEvents(context.Context, AgentEventQuery) ([]AgentEventRecord, error)
	WaitForAgentEvents(context.Context, string, int64) error
}
