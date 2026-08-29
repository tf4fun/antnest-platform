package runtimeconn

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

type callerFunc func(context.Context, string, any, any) error

func (f callerFunc) Call(ctx context.Context, method string, input any, output any) error {
	return f(ctx, method, input, output)
}

type staticPeerResolver struct {
	caller Caller
	err    error
}

func (r staticPeerResolver) ResolveRuntimePeer(
	context.Context,
	runtimecontracts.GenerationKey,
) (Caller, error) {
	return r.caller, r.err
}

func TestWorkExecutorPreservesThreeStateTransportBoundary(t *testing.T) {
	target := runtimecontracts.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 2}
	input := validExecInput()
	tests := []struct {
		name string
		call callerFunc
		want runtimecontracts.EffectDisposition
	}{
		{
			name: "runtime rejects before admission",
			call: func(context.Context, string, any, any) error {
				return &Error{Code: CodeInvalidParams, Message: "rejected"}
			},
			want: runtimecontracts.EffectNotStarted,
		},
		{
			name: "runtime internal error is ambiguous",
			call: func(context.Context, string, any, any) error {
				return &Error{Code: CodeInternalError, Message: "result persistence failed"}
			},
			want: runtimecontracts.EffectUnknown,
		},
		{
			name: "transport loses response",
			call: func(context.Context, string, any, any) error {
				return errors.New("connection closed")
			},
			want: runtimecontracts.EffectUnknown,
		},
		{
			name: "runtime sends malformed completed result",
			call: func(_ context.Context, _ string, _ any, output any) error {
				result := output.(*runtimecontracts.ExecResult)
				result.Outcome = runtimecontracts.Outcome{
					Disposition: runtimecontracts.EffectCompleted, Reason: "exited",
				}
				return nil
			},
			want: runtimecontracts.EffectUnknown,
		},
		{
			name: "runtime observes completion",
			call: func(_ context.Context, _ string, _ any, output any) error {
				exitCode := int32(0)
				*output.(*runtimecontracts.ExecResult) = runtimecontracts.ExecResult{
					Outcome: runtimecontracts.Outcome{
						Disposition: runtimecontracts.EffectCompleted, Reason: "exited",
					},
					ExitCode: &exitCode, ProcessReaped: true,
				}
				return nil
			},
			want: runtimecontracts.EffectCompleted,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			executor, err := NewWorkExecutor(staticPeerResolver{caller: test.call})
			if err != nil {
				t.Fatal(err)
			}
			result := executor.Exec(t.Context(), target, input)
			if err := result.Validate(); err != nil {
				t.Fatalf("normalized result is invalid: %#v err=%v", result, err)
			}
			if result.Outcome.Disposition != test.want {
				t.Fatalf("disposition = %s, want %s: %#v", result.Outcome.Disposition, test.want, result)
			}
		})
	}
}

func TestWorkExecutorTreatsPeerResolutionAsNotStarted(t *testing.T) {
	executor, err := NewWorkExecutor(staticPeerResolver{err: ErrSessionUnavailable})
	if err != nil {
		t.Fatal(err)
	}
	result := executor.Exec(
		t.Context(),
		runtimecontracts.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 2},
		validExecInput(),
	)
	if result.Outcome.Disposition != runtimecontracts.EffectNotStarted || result.Outcome.Reason != "runtime_unavailable" {
		t.Fatalf("pre-dispatch failure was not retryable: %#v", result)
	}
}

func TestWorkExecutorCancelsDispatchedOperationAfterCallerDeadline(t *testing.T) {
	target := runtimecontracts.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 2}
	methods := []string{}
	caller := callerFunc(func(ctx context.Context, method string, _ any, output any) error {
		methods = append(methods, method)
		if method == MethodOperationCancel {
			*output.(*runtimecontracts.CancelOperationResult) = runtimecontracts.CancelOperationResult{
				Outcome: runtimecontracts.Outcome{Disposition: runtimecontracts.EffectUnknown, Reason: "canceled"},
			}
			return nil
		}
		return ctx.Err()
	})
	executor, err := NewWorkExecutor(staticPeerResolver{caller: caller})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result := executor.Exec(ctx, target, validExecInput())
	if result.Outcome.Disposition != runtimecontracts.EffectUnknown {
		t.Fatalf("timed out dispatched effect was not unknown: %#v", result)
	}
	if len(methods) != 2 || methods[0] != MethodProcessExec || methods[1] != MethodOperationCancel {
		t.Fatalf("best-effort cancellation sequence = %v", methods)
	}
}

func TestWorkExecutorDoesNotCancelUndispatchedOperation(t *testing.T) {
	calls := 0
	caller := callerFunc(func(context.Context, string, any, any) error {
		calls++
		return fmt.Errorf("%w: queue deadline", ErrCallNotDispatched)
	})
	executor, err := NewWorkExecutor(staticPeerResolver{caller: caller})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	result := executor.Exec(
		ctx,
		runtimecontracts.GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 2},
		validExecInput(),
	)
	if result.Outcome.Disposition != runtimecontracts.EffectNotStarted || calls != 1 {
		t.Fatalf("undispatched effect cancellation drifted: result=%#v calls=%d", result, calls)
	}
}

func validExecInput() runtimecontracts.ExecInput {
	return runtimecontracts.ExecInput{
		OperationRef: runtimecontracts.OperationRef{
			WorkRef: runtimecontracts.WorkRef{
				WorkID: "run-1", WorkEpoch: 1, WorkSessionID: "work-session-1",
			},
			OperationID:   "operation-1",
			RequestDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		},
		Argv: []string{"/bin/true"},
		WorkingDir: runtimecontracts.RootPath{
			Root: runtimecontracts.RootWorkspace, Path: ".",
		},
		Timeout: time.Minute,
	}
}
