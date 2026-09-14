package ports

import (
	"context"
	"errors"
	"fmt"
)

const (
	DefaultExecutionSnapshotMaxBytes = 16 * 1024 * 1024
	MaximumExecutionEndpointBytes    = 2048
	MaximumExecutionIdentifierBytes  = 200
	MaximumExecutionTextUnits        = 200
)

var ErrExecutionCapacityExceeded = errors.New("execution configuration capacity exceeded")

type ExecutionCapacityError struct {
	RequiredBytes int
	LimitBytes    int
}

func (failure *ExecutionCapacityError) Error() string {
	return fmt.Sprintf("execution configuration requires %d bytes including closure reserve; limit is %d bytes", failure.RequiredBytes, failure.LimitBytes)
}

func (*ExecutionCapacityError) Unwrap() error { return ErrExecutionCapacityExceeded }

type ExecutionCapacityInput struct {
	Current ExecutionSource
	Targets []AgentSpecRecord
}

// ExecutionCapacityGuard only performs local projection and cryptography.
// The caller holds the organization transaction; no network or storage IO is allowed.
type ExecutionCapacityGuard interface {
	ValidateExecutionCapacity(context.Context, ExecutionCapacityInput) error
}
