package postgres

import (
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRuntimeConditionSurvivesOperationSnapshot(t *testing.T) {
	value := deployment.Environment{
		Phase: deployment.PhaseExited, Health: deployment.HealthUnknown,
		Reason: "runtime_oom_killed", DiagnosticSummary: "Process exited with code 137",
		ObservedAt: time.Now().UTC(),
	}
	got := environmentSnapshotFromDomain(value).domain()
	if got.Phase != value.Phase || got.Reason != value.Reason || got.DiagnosticSummary != value.DiagnosticSummary || !got.ObservedAt.Equal(value.ObservedAt) {
		t.Fatalf("lost runtime condition: %+v", got)
	}
}
