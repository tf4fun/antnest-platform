package orchestration

import (
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
	enums "go.temporal.io/api/enums/v1"
	failurepb "go.temporal.io/api/failure/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/sdk/log"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	"google.golang.org/protobuf/encoding/protojson"
)

func TestActivityRetryBudgetExpiredRequiresEngineTimeoutState(t *testing.T) {
	for _, state := range []enums.RetryState{
		enums.RETRY_STATE_TIMEOUT,
		enums.RETRY_STATE_IN_PROGRESS,
		enums.RETRY_STATE_MAXIMUM_ATTEMPTS_REACHED,
		enums.RETRY_STATE_NON_RETRYABLE_FAILURE,
		enums.RETRY_STATE_CANCEL_REQUESTED,
		enums.RETRY_STATE_INTERNAL_SERVER_ERROR,
	} {
		t.Run(state.String(), func(t *testing.T) {
			failure := &failurepb.Failure{
				Message:     "activity error",
				FailureInfo: &failurepb.Failure_ActivityFailureInfo{ActivityFailureInfo: &failurepb.ActivityFailureInfo{RetryState: state}},
				Cause:       &failurepb.Failure{Message: "temporary dependency failure", FailureInfo: &failurepb.Failure_ApplicationFailureInfo{ApplicationFailureInfo: &failurepb.ApplicationFailureInfo{Type: "dependency_unavailable"}}},
			}
			err := temporal.GetDefaultFailureConverter().FailureToError(failure)
			var timeoutErr *temporal.TimeoutError
			require.False(t, errors.As(err, &timeoutErr), "the engine retained an application failure")
			require.Equal(t, state == enums.RETRY_STATE_TIMEOUT, activityRetryBudgetExpired(fmt.Errorf("phase: %w", err)))
		})
	}
	require.False(t, activityRetryBudgetExpired(nil))
	require.False(t, activityRetryBudgetExpired(errors.New("RETRY_STATE_TIMEOUT")))
}

func TestRetryDeadlineChangeReplaysOldClosedHistory(t *testing.T) {
	// Captured from Temporal 1.32.0 before the retry-budget classification fix.
	// It contains synthetic test input only, and failed without termination.
	data, err := os.ReadFile("testdata/create_retry_budget_v1_history.json")
	require.NoError(t, err)
	history := &historypb.History{}
	require.NoError(t, protojson.Unmarshal(data, history))
	last := history.Events[len(history.Events)-1].GetWorkflowExecutionFailedEventAttributes()
	require.NotNil(t, last)
	require.Equal(t, enums.RETRY_STATE_TIMEOUT, last.Failure.GetActivityFailureInfo().GetRetryState())
	require.NotNil(t, last.Failure.Cause.GetApplicationFailureInfo())
	require.Nil(t, last.Failure.Cause.GetTimeoutFailureInfo())
	replayer := worker.NewWorkflowReplayer()
	replayer.RegisterWorkflowWithOptions(CreateAgentWorkflow, workflow.RegisterOptions{Name: "CreateAgentWorkflow"})
	require.NoError(t, replayer.ReplayWorkflowHistory(
		log.NewStructuredLogger(slog.New(slog.NewTextHandler(io.Discard, nil))), history))
}
