package ports

import (
	"context"
	"time"
)

type ExecutionSynchronization struct {
	OrganizationID  string
	Revision        int64
	AppliedRevision int64
	UpdatedAt       time.Time
	AppliedAt       *time.Time
}

type ExecutionPublicationStore interface {
	WithExecutionPublication(context.Context, string, func(context.Context) error) error
	ReadExecutionSource(context.Context, string) (ExecutionSource, error)
	ListExecutionOrganizations(context.Context, string, int) ([]string, error)
	GetExecutionSynchronization(context.Context, string) (ExecutionSynchronization, error)
	RecordExecutionApplied(context.Context, ExecutionAcknowledgement) error
}
