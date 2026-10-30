package ports

import (
	"context"
	"time"
)

// FailedCreateGCCandidate identifies an Agent whose single failed create
// operation qualifies for garbage collection through the normal delete
// lifecycle. It is a point-in-time snapshot; admission rechecks every field
// under the transaction lock before scheduling the durable delete.
type FailedCreateGCCandidate struct {
	AgentID           string
	OrganizationID    string
	CreateRequestID   string
	AggregateSequence int64
}

// FailedCreateGCStore lists failed-create candidates for the GC sweep. The
// delete itself is admitted through the normal BeginAgentDelete path.
type FailedCreateGCStore interface {
	ListFailedCreateGCCandidates(ctx context.Context, cutoff time.Time, limit int) ([]FailedCreateGCCandidate, error)
}
