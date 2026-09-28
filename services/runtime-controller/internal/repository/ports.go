package repository

import (
	"context"
	"errors"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

var (
	ErrNotFound                    = errors.New("repository record not found")
	ErrIdempotencyConflict         = errors.New("repository idempotency identity conflict")
	ErrOperationFinalized          = errors.New("repository operation is finalized")
	ErrLockLost                    = errors.New("repository coordination lock was lost")
	ErrConcurrentMutation          = errors.New("repository Agent mutation is already active")
	ErrTransitionConflict          = errors.New("repository lifecycle transition conflict")
	ErrRevisionConflict            = errors.New("repository revision conflict")
	ErrInvariantConflict           = errors.New("repository invariant conflict")
	ErrPreparedSkillSetInvalidated = errors.New("prepared Skill set is unavailable or invalidated")
	ErrSkillCleanupInProgress      = errors.New("skill set cleanup is in progress")
	ErrSkillPreparationClosed      = errors.New("agent Skill preparation is closed")
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
	MaxClaimedGeneration(context.Context, string) (uint64, error)
	AppendObservation(context.Context, deployment.Observation) (deployment.Observation, error)
	ListObservations(context.Context, uint64, int) (deployment.ObservationWindow, error)
	Ready(context.Context) error
}

type MutationLocker interface {
	WithAgentLock(context.Context, string, func(context.Context) error) error
}

// SkillPreparationStore is separate from the Runtime lifecycle Store: durable
// preparation can begin before an Environment exists and must not consume the
// lifecycle mutation deadline.
type SkillPreparationStore interface {
	AdmitSkillPreparation(context.Context, skillset.PrepareRequest) (skillset.PreparationReceipt, error)
	GetSkillPreparation(context.Context, string, string, string, string) (skillset.PreparationReceipt, error)
	ReleaseSkillPreparation(context.Context, string, string, string, string, string) error
}

// PreparedSkillReferenceStore resolves an accepted logical reference to the
// exact private materialization. Lifecycle admission must repeat this check in
// the same transaction that records the operation.
type PreparedSkillReferenceStore interface {
	ResolvePreparedSkillSet(context.Context, skillset.PreparedReference) (skillset.PreparedMaterialization, error)
}

// ReadySkillSetStore requeues a missing, idle materialization while retaining
// its logical preparation references for an idempotent retry.
type ReadySkillSetStore interface {
	PreparedSkillReferenceStore
	ResetMissingReadySkillVolume(context.Context, skillset.PreparedMaterialization) error
	MarkDriftedReadySkillVolume(context.Context, skillset.PreparedMaterialization) error
}

type SkillPreparationWorkerStore interface {
	ClaimSkillPreparation(context.Context, string, string, time.Time, time.Duration, int) (*skillset.PreparationJob, error)
	RenewSkillPreparation(context.Context, int64, string, time.Time, time.Duration) error
	CheckpointSkillPackage(context.Context, int64, string, skillset.FrozenSkill, skillset.Package, time.Time) error
	CompleteSkillPreparation(context.Context, int64, string, string, time.Time) error
	SetSkillPreparationFailure(context.Context, int64, string, skillset.PreparationState, string, *time.Time, time.Time) error
	ResetMissingSkillVolume(context.Context, int64, string, time.Time) error
}

type SkillCleanupStore interface {
	ClaimSkillCleanup(context.Context, string, string, time.Time, time.Duration) (*skillset.CleanupJob, error)
	CompleteSkillCleanup(context.Context, int64, string, time.Time) error
	PostponeSkillCleanup(context.Context, int64, string, time.Time, time.Duration, string) error
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
