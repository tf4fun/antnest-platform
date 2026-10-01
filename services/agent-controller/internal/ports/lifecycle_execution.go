package ports

import (
	"context"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

type LifecycleSettlementRequest struct {
	OrganizationID string
	AgentID        string
	OperationID    string
	Mode           string
	DeadlineAt     time.Time
}

type LifecycleExecution interface {
	CloseAndSettle(context.Context, LifecycleSettlementRequest) (AgentSettlementResult, error)
}

type ConfirmLifecycleDrain struct {
	RequestID   string
	Fingerprint string
	Kind        domain.OperationKind
	Outcome     string
	Now         time.Time
}
