package runtimeconn

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

const cancellationTimeout = 2 * time.Second

const (
	MethodWorkBegin       = "work.begin"
	MethodWorkEnd         = "work.end"
	MethodProcessExec     = "process.exec"
	MethodFileRead        = "file.read"
	MethodFileWrite       = "file.write"
	MethodFileEdit        = "file.edit"
	MethodFileList        = "file.list"
	MethodOperationCancel = "operation.cancel"
)

type Caller interface {
	Call(context.Context, string, any, any) error
}

type PeerResolver interface {
	ResolveRuntimePeer(context.Context, runtimecontracts.GenerationKey) (Caller, error)
}

type WorkExecutor struct {
	peers PeerResolver
}

func NewWorkExecutor(peers PeerResolver) (*WorkExecutor, error) {
	if peers == nil {
		return nil, fmt.Errorf("JSON-RPC Runtime peer resolver is required")
	}
	return &WorkExecutor{peers: peers}, nil
}

func (e *WorkExecutor) BeginWork(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.BeginWorkInput,
) runtimecontracts.BeginWorkResult {
	if err := target.Validate(); err != nil {
		return runtimecontracts.BeginWorkResult{Outcome: notStartedOutcome("invalid_target", err)}
	}
	if err := input.Validate(); err != nil {
		return runtimecontracts.BeginWorkResult{Outcome: notStartedOutcome("invalid_work", err)}
	}
	var result runtimecontracts.BeginWorkResult
	if err := e.call(ctx, target, MethodWorkBegin, input, &result); err != nil {
		return runtimecontracts.BeginWorkResult{Outcome: callFailureOutcome(err)}
	}
	if err := result.Validate(); err != nil {
		return runtimecontracts.BeginWorkResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

func (e *WorkExecutor) EndWork(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.EndWorkInput,
) runtimecontracts.EndWorkResult {
	if err := target.Validate(); err != nil {
		return runtimecontracts.EndWorkResult{Reason: "invalid_target", Message: err.Error()}
	}
	if err := input.Validate(); err != nil {
		return runtimecontracts.EndWorkResult{Reason: "invalid_work", Message: err.Error()}
	}
	var result runtimecontracts.EndWorkResult
	if err := e.call(ctx, target, MethodWorkEnd, input, &result); err != nil {
		return runtimecontracts.EndWorkResult{Reason: "transport_lost", Message: boundedMessage(err)}
	}
	if err := result.Validate(); err != nil {
		return runtimecontracts.EndWorkResult{Reason: "invalid_runtime_result", Message: boundedMessage(err)}
	}
	return result
}

func (e *WorkExecutor) Exec(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.ExecInput,
) runtimecontracts.ExecResult {
	var result runtimecontracts.ExecResult
	if err := validateTargetAndInput(target, input.Validate()); err != nil {
		result.Outcome = notStartedOutcome("invalid_request", err)
		return result
	}
	wire := execWireInput{
		OperationRef: input.OperationRef, Argv: input.Argv, WorkingDir: input.WorkingDir,
		Env:       append([]runtimecontracts.EnvironmentVariable{}, input.Env...),
		TimeoutMS: uint64(max(input.Timeout.Milliseconds(), 1)),
	}
	if err := e.call(ctx, target, MethodProcessExec, wire, &result); err != nil {
		result.Outcome = callFailureOutcome(err)
		return result
	}
	if err := result.Validate(); err != nil {
		result = runtimecontracts.ExecResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

type execWireInput struct {
	runtimecontracts.OperationRef
	Argv       []string                               `json:"argv"`
	WorkingDir runtimecontracts.RootPath              `json:"working_dir"`
	Env        []runtimecontracts.EnvironmentVariable `json:"env"`
	TimeoutMS  uint64                                 `json:"timeout_ms"`
}

func (e *WorkExecutor) ReadFile(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.ReadFileInput,
) runtimecontracts.ReadFileResult {
	var result runtimecontracts.ReadFileResult
	if err := validateTargetAndInput(target, input.Validate()); err != nil {
		result.Outcome = notStartedOutcome("invalid_request", err)
		return result
	}
	if err := e.call(ctx, target, MethodFileRead, input, &result); err != nil {
		result.Outcome = callFailureOutcome(err)
		return result
	}
	if err := result.Validate(); err != nil {
		result = runtimecontracts.ReadFileResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

func (e *WorkExecutor) WriteFile(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.WriteFileInput,
) runtimecontracts.WriteFileResult {
	var result runtimecontracts.WriteFileResult
	if err := validateTargetAndInput(target, input.Validate()); err != nil {
		result.Outcome = notStartedOutcome("invalid_request", err)
		return result
	}
	if err := e.call(ctx, target, MethodFileWrite, input, &result); err != nil {
		result.Outcome = callFailureOutcome(err)
		return result
	}
	if err := result.Validate(); err != nil {
		result = runtimecontracts.WriteFileResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

func (e *WorkExecutor) EditFile(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.EditFileInput,
) runtimecontracts.EditFileResult {
	var result runtimecontracts.EditFileResult
	if err := validateTargetAndInput(target, input.Validate()); err != nil {
		result.Outcome = notStartedOutcome("invalid_request", err)
		return result
	}
	if err := e.call(ctx, target, MethodFileEdit, input, &result); err != nil {
		result.Outcome = callFailureOutcome(err)
		return result
	}
	if err := result.Validate(); err != nil {
		result = runtimecontracts.EditFileResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

func (e *WorkExecutor) ListDir(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.ListDirInput,
) runtimecontracts.ListDirResult {
	var result runtimecontracts.ListDirResult
	if err := validateTargetAndInput(target, input.Validate()); err != nil {
		result.Outcome = notStartedOutcome("invalid_request", err)
		return result
	}
	if err := e.call(ctx, target, MethodFileList, input, &result); err != nil {
		result.Outcome = callFailureOutcome(err)
		return result
	}
	if err := result.Validate(); err != nil {
		result = runtimecontracts.ListDirResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

func (e *WorkExecutor) CancelOperation(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	input runtimecontracts.CancelOperationInput,
) runtimecontracts.CancelOperationResult {
	var result runtimecontracts.CancelOperationResult
	if err := target.Validate(); err != nil {
		result.Outcome = notStartedOutcome("invalid_target", err)
		return result
	}
	if err := input.Validate(); err != nil {
		result.Outcome = notStartedOutcome("invalid_request", err)
		return result
	}
	if err := e.call(ctx, target, MethodOperationCancel, input, &result); err != nil {
		result.Outcome = callFailureOutcome(err)
		return result
	}
	if err := result.Validate(); err != nil {
		result = runtimecontracts.CancelOperationResult{Outcome: unknownOutcome("invalid_runtime_result", err)}
	}
	return result
}

func (e *WorkExecutor) call(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	method string,
	input any,
	output any,
) error {
	return e.callPeer(ctx, target, method, input, output)
}

func (e *WorkExecutor) callPeer(
	ctx context.Context,
	target runtimecontracts.GenerationKey,
	method string,
	input any,
	output any,
) error {
	peer, err := e.peers.ResolveRuntimePeer(ctx, target)
	if err != nil {
		return fmt.Errorf("%w: resolve Runtime peer: %w", ErrCallNotDispatched, err)
	}
	err = peer.Call(ctx, method, input, output)
	if err == nil || ctx.Err() == nil || errors.Is(err, ErrCallNotDispatched) {
		return err
	}
	operation, ok := cancellationOperation(input)
	if !ok {
		return err
	}
	cancelCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), cancellationTimeout)
	defer cancel()
	var result runtimecontracts.CancelOperationResult
	_ = peer.Call(cancelCtx, MethodOperationCancel, runtimecontracts.CancelOperationInput{
		WorkRef: operation.WorkRef, OperationID: operation.OperationID,
	}, &result)
	return err
}

func cancellationOperation(input any) (runtimecontracts.OperationRef, bool) {
	switch value := input.(type) {
	case execWireInput:
		return value.OperationRef, true
	case runtimecontracts.ReadFileInput:
		return value.OperationRef, true
	case runtimecontracts.WriteFileInput:
		return value.OperationRef, true
	case runtimecontracts.EditFileInput:
		return value.OperationRef, true
	case runtimecontracts.ListDirInput:
		return value.OperationRef, true
	default:
		return runtimecontracts.OperationRef{}, false
	}
}

func validateTargetAndInput(target runtimecontracts.GenerationKey, inputErr error) error {
	if err := target.Validate(); err != nil {
		return err
	}
	return inputErr
}

func callFailureOutcome(err error) runtimecontracts.Outcome {
	if errors.Is(err, ErrCallNotDispatched) {
		return notStartedOutcome("runtime_unavailable", err)
	}
	var rpcErr *Error
	if errors.As(err, &rpcErr) {
		switch rpcErr.Code {
		case CodeInvalidRequest, CodeMethodNotFound, CodeInvalidParams:
			return notStartedOutcome("runtime_rejected", rpcErr)
		default:
			return unknownOutcome("runtime_error", rpcErr)
		}
	}
	return unknownOutcome("transport_lost", err)
}

func notStartedOutcome(reason string, err error) runtimecontracts.Outcome {
	return runtimecontracts.Outcome{
		Disposition: runtimecontracts.EffectNotStarted,
		Reason:      reason,
		Message:     boundedMessage(err),
	}
}

func unknownOutcome(reason string, err error) runtimecontracts.Outcome {
	return runtimecontracts.Outcome{
		Disposition: runtimecontracts.EffectUnknown,
		Reason:      reason,
		Message:     boundedMessage(err),
	}
}

func boundedMessage(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	if len(message) > 4096 {
		return message[:4096]
	}
	return message
}
