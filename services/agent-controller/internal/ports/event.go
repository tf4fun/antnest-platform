package ports

import "context"

type AgentEventQuery struct {
	OrganizationID string
	AgentID        string
	AfterSequence  int64
	Limit          int
}

type AgentEventStore interface {
	ListAgentEvents(context.Context, AgentEventQuery) ([]AgentEventRecord, error)
}

type AgentEventNotifier interface {
	SubscribeAgentEvents() (<-chan struct{}, error)
}
