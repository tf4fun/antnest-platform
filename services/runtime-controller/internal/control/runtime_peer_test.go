package control

import (
	"context"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestInspectionClearsStalePeerForAbsentCompute(t *testing.T) {
	repository := newLifecycleRepository()
	repository.environments["agent-1"] = deployment.Environment{
		AgentID: "agent-1", RuntimeRevision: lifecycleRevision,
		LifecycleState: deployment.LifecycleDisabled, RuntimeEndpoint: "10.243.1.20",
	}
	service := newLifecycleService(t, repository, newLifecyclePlatform())
	inspection, err := service.InspectRuntime(context.Background(), "agent-1")
	if err != nil || inspection.RuntimeEndpoint != "" {
		t.Fatal("absent compute retained a peer address", inspection.RuntimeEndpoint, err)
	}
}
