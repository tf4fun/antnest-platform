package orchestration

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestLifecycleWorkerOptions(t *testing.T) {
	const timeout = 7 * time.Second
	for _, test := range []struct {
		name        string
		buildID     string
		expectEmpty bool
	}{
		{name: "empty build keeps zero version", buildID: "", expectEmpty: true},
		{name: "explicit build sets deployment identity", buildID: "build-abc123"},
	} {
		t.Run(test.name, func(t *testing.T) {
			options := lifecycleWorkerOptions(timeout, WorkerConfiguration{BuildID: test.buildID})
			require.Equal(t, timeout, options.WorkerStopTimeout)
			require.Equal(t, 4, options.MaxConcurrentActivityExecutionSize)
			require.Equal(t, 4, options.MaxConcurrentWorkflowTaskExecutionSize)
			require.False(t, options.DeploymentOptions.UseVersioning,
				"task-queue routing stays disabled - BuildID is deployment identity only")
			version := options.DeploymentOptions.Version
			if test.expectEmpty {
				require.Empty(t, version.DeploymentName)
				require.Empty(t, version.BuildID)
				return
			}
			require.Equal(t, "agent-controller", version.DeploymentName)
			require.Equal(t, test.buildID, version.BuildID)
		})
	}
}
