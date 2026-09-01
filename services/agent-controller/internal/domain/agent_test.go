package domain

import "testing"

func TestAgentStateContainsOnlyStableAvailability(t *testing.T) {
	t.Parallel()

	valid := []struct {
		from AgentState
		to   AgentState
	}{
		{AgentProvisioning, AgentAvailable},
		{AgentProvisioning, AgentUnavailable},
		{AgentAvailable, AgentDisabled},
		{AgentAvailable, AgentUnavailable},
		{AgentAvailable, AgentDeleting},
		{AgentDisabled, AgentAvailable},
		{AgentDisabled, AgentUnavailable},
		{AgentDisabled, AgentDeleting},
		{AgentUnavailable, AgentAvailable},
		{AgentUnavailable, AgentDeleting},
		{AgentDeleting, AgentDeleted},
	}
	for _, testCase := range valid {
		if err := ValidateAgentStateTransition(testCase.from, testCase.to); err != nil {
			t.Errorf("expected %s -> %s to be valid: %v", testCase.from, testCase.to, err)
		}
	}

	invalid := []struct {
		from AgentState
		to   AgentState
	}{
		{AgentProvisioning, AgentDisabled},
		{AgentProvisioning, AgentDeleting},
		{AgentAvailable, AgentProvisioning},
		{AgentDisabled, AgentProvisioning},
		{AgentDeleted, AgentAvailable},
	}
	for _, testCase := range invalid {
		if err := ValidateAgentStateTransition(testCase.from, testCase.to); err == nil {
			t.Errorf("expected %s -> %s to be rejected", testCase.from, testCase.to)
		}
	}
}

func TestAgentRunAdmissionRequiresAvailableStateAndNoOperation(t *testing.T) {
	t.Parallel()

	agent := Agent{desiredState: DesiredEnabled, state: AgentAvailable}
	if err := agent.CanAcquireRun(); err != nil {
		t.Fatalf("available Agent rejected: %v", err)
	}

	agent.activeOperationRequestID = "request-1"
	if err := agent.CanAcquireRun(); err == nil {
		t.Fatal("Agent with active lifecycle operation admitted a Run")
	}

	agent.activeOperationRequestID = ""
	agent.state = AgentUnavailable
	if err := agent.CanAcquireRun(); err == nil {
		t.Fatal("unavailable Agent admitted a Run")
	}

	agent.state = AgentAvailable
	agent.desiredState = DesiredDisabled
	if err := agent.CanAcquireRun(); err == nil {
		t.Fatal("Agent with disabled desired state admitted a Run")
	}
}
