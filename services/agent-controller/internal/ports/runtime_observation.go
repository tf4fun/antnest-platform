package ports

import (
	"context"
	"fmt"
	"time"
)

const (
	RuntimeObservationRestarted = "restarted"
	RuntimeObservationMissing   = "runtime_missing"
	RuntimeObservationDeleted   = "runtime_deleted"
)

type RuntimeObservation struct {
	Current            *RuntimeInspection
	Sequence           uint64
	AgentID            string
	RuntimeRevision    string
	RuntimeExecutionID string
	Kind               string
	ObservedAt         time.Time
}

type RuntimeObservationPage struct {
	Observations []RuntimeObservation
	NextSequence uint64
}

type RuntimeEnvironmentSnapshot struct {
	Phase              string
	Reason             string
	DiagnosticSummary  string
	ObservedAt         time.Time
	AgentID            string
	RuntimeRevision    string
	RuntimeExecutionID string
	LifecycleState     string
	Health             string
}

type RuntimeObservationCursor struct {
	Sequence    uint64
	Initialized bool
}

type RuntimeObservationSource interface {
	InspectRuntime(context.Context, string) (RuntimeInspection, error)
	ListRuntimeObservations(context.Context, uint64, int) (RuntimeObservationPage, error)
	ListRuntimes(context.Context) ([]RuntimeEnvironmentSnapshot, error)
}

type RuntimeObservationStore interface {
	RecordRuntimeCondition(context.Context, RecordRuntimeCondition) (int64, error)
	ListPendingRuntimeBindings(context.Context, string, int) ([]PendingRuntimeBinding, error)
	PublishRuntimeBinding(context.Context, PublishRuntimeBinding) (bool, error)
	GetRuntimeObservationCursor(context.Context) (RuntimeObservationCursor, error)
	InitializeRuntimeObservationCursor(context.Context, []RuntimeEnvironmentSnapshot) error
	ResetRuntimeObservationCursor(context.Context, []RuntimeEnvironmentSnapshot, uint64) error
	ApplyRuntimeObservation(context.Context, RuntimeObservation) error
}

type RecordRuntimeCondition struct {
	ExpectedAggregateSequence int64
	Inspection                RuntimeInspection
	TraceID                   string
}

type RuntimeObservationCursorExpiredError struct {
	ResetSequence uint64
}

func (failure *RuntimeObservationCursorExpiredError) Error() string {
	return fmt.Sprintf("Runtime observation cursor expired; reset to %d", failure.ResetSequence)
}
