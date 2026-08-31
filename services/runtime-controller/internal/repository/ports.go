package repository

import (
	"context"
	"errors"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

var (
	ErrNotFound            = errors.New("repository record not found")
	ErrIdempotencyConflict = errors.New("repository idempotency identity conflict")
	ErrOperationFinalized  = errors.New("repository operation is finalized")
	ErrLockLost            = errors.New("repository coordination lock was lost")
	ErrConcurrentMutation  = errors.New("repository Agent mutation is already active")
	ErrTransitionConflict  = errors.New("repository lifecycle transition conflict")
	ErrRevisionConflict    = errors.New("repository revision conflict")
	ErrInvariantConflict   = errors.New("repository invariant conflict")
)

type GenerationClaim struct {
	RuntimeRevision deployment.RuntimeRevision
	SpecDigest      string
}

// Store is the complete persistence contract required by Runtime Controller
// use cases. It contains no PostgreSQL-specific type or query concern.
type Store interface {
	BeginTransition(context.Context, deployment.Operation) (deployment.Operation, bool, error)
	CompleteOperation(
		context.Context, deployment.Operation, *deployment.Observation,
	) (*deployment.Observation, error)
	GetOperation(context.Context, string) (deployment.Operation, error)
	GetEnvironment(context.Context, string) (deployment.Environment, error)
	ListEnvironments(context.Context) ([]deployment.Environment, error)
	GenerationClaim(context.Context, deployment.Key) (GenerationClaim, error)
	AppendObservation(context.Context, deployment.Observation) (deployment.Observation, error)
	ListObservations(context.Context, uint64, int) (deployment.ObservationWindow, error)
	Ready(context.Context) error
}

type MutationLocker interface {
	WithAgentLock(context.Context, string, func(context.Context) error) error
}

type Leadership interface {
	Done() <-chan struct{}
	Err() error
	MarkObservationReady(context.Context) error
	MarkObservationUnready(context.Context) error
	Release(context.Context) error
}

type ObservationCoordinator interface {
	TryAcquireObservationLeadership(context.Context) (Leadership, bool, error)
	ObservationMonitorReady(context.Context) (bool, error)
}

type ObservationNotificationSource interface {
	ListenObservationNotifications(context.Context, func(), func(string)) error
}

// Port is the one explicit capability set implemented by a repository adapter.
// Consumers still accept the narrow interfaces above.
type Port interface {
	Store
	MutationLocker
	ObservationCoordinator
	ObservationNotificationSource
}
