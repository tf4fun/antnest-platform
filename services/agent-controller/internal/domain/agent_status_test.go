package domain

import "testing"

func TestAgentStatusSeparatesLifecycleActivationAndRuntime(t *testing.T) {
	for _, test := range []struct {
		name  string
		state AgentStatus
		ready bool
	}{
		{"not created", AgentStatus{Lifecycle: AgentNotCreated}, false},
		{"waiting", AgentStatus{Lifecycle: AgentCreated, Activation: ActivationEnabled, Runtime: RuntimeWaiting}, false},
		{"available", AgentStatus{Lifecycle: AgentCreated, Activation: ActivationEnabled, Runtime: RuntimeAvailable}, true},
		{"disabled despite stale health", AgentStatus{Lifecycle: AgentCreated, Activation: ActivationDisabled, Runtime: RuntimeAvailable}, false},
		{"exited", AgentStatus{Lifecycle: AgentCreated, Activation: ActivationEnabled, Runtime: RuntimeExited}, false},
		{"deleted", AgentStatus{Lifecycle: AgentDeleted, Activation: ActivationEnabled, Runtime: RuntimeAvailable}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := test.state.RuntimeReady(); got != test.ready {
				t.Fatalf("ready=%v want=%v", got, test.ready)
			}
		})
	}
}

func TestObservedRuntimeConditionUsesPhaseBeforeHealth(t *testing.T) {
	for _, test := range []struct {
		phase, health string
		want          RuntimeState
	}{
		{"created", "starting", RuntimeWaiting}, {"running", "starting", RuntimeWaiting},
		{"running", "healthy", RuntimeAvailable}, {"running", "unhealthy", RuntimeUnhealthy},
		{"exited", "healthy", RuntimeExited}, {"absent", "unknown", RuntimeAbsent},
		{"unknown", "healthy", RuntimeUnknown}, {"running", "unknown", RuntimeUnknown},
	} {
		if got := ObservedRuntimeState(test.phase, test.health); got != test.want {
			t.Errorf("%s/%s=%s want %s", test.phase, test.health, got, test.want)
		}
	}
}
