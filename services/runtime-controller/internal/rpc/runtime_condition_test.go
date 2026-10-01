package rpc

import (
	"encoding/json"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRuntimeInspectionExposesCurrentCondition(t *testing.T) {
	value := deployment.Environment{Phase: deployment.PhaseExited, Reason: "runtime_exited", DiagnosticSummary: "exit 1"}
	payload, err := json.Marshal(runtimeInspectionFromDomain(value))
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["phase"] != "exited" || decoded["reason"] != "runtime_exited" || decoded["diagnostic_summary"] != "exit 1" {
		t.Fatalf("lost condition on wire: %s", payload)
	}
}
