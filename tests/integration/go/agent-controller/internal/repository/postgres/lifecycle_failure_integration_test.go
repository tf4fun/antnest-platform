package postgres

import (
	"context"
	"errors"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
	"strings"
	"testing"
)

func TestWorkflowInvariantFailureIsAtomicAndDoesNotOverwriteAnotherPhase(t *testing.T) {
	repository, base := identityTestRepository(t)
	service := newIntegratedLifecycleService(repository, repository, &offboardingDependencies{}, &offboardingDependencies{}, offboardingClock{}, application.WithLifecycleExecution(testLifecycleExecution(repository)))
	accepted, err := service.DisableAgent(context.Background(), application.DisableAgentInput{RequestID: "invariant-disable", AgentID: base.Agent.AgentID})
	if err != nil {
		t.Fatal(err)
	}
	operation, err := repository.GetLifecycleOperation(context.Background(), accepted.Operation.RequestID)
	if err != nil {
		t.Fatal(err)
	}
	input := ports.QuarantineLifecycleOperation{RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint, ExpectedPhase: domain.PhaseRuntimeDisable, ErrorCode: "lifecycle_invariant_failed", ErrorDetail: "invalid persisted source", EventID: "quarantine-event"}
	if err := repository.QuarantineLifecycleOperation(context.Background(), input); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("future phase accepted: %v", err)
	}
	input.ExpectedPhase = operation.Phase
	input.Fingerprint = strings.Repeat("f", 64)
	if err := repository.QuarantineLifecycleOperation(context.Background(), input); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("wrong fingerprint: %v", err)
	}
	input.Fingerprint = operation.RequestFingerprint
	if err := repository.QuarantineLifecycleOperation(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	if err := repository.QuarantineLifecycleOperation(context.Background(), input); err != nil {
		t.Fatal(err)
	}
	operation, err = repository.GetLifecycleOperation(context.Background(), input.RequestID)
	if err != nil || operation.State != domain.OperationFailed {
		t.Fatalf("operation: %+v %v", operation, err)
	}
	agent, err := loadAgentRecord(context.Background(), repository.pool, base.Agent.AgentID)
	if err != nil || (agent.LifecycleState != domain.AgentCreated || agent.ActivationState != domain.ActivationEnabled || agent.RuntimeState != domain.RuntimeUnknown) || agent.ActiveOperationRequestID != "" {
		t.Fatalf("agent: %+v %v", agent, err)
	}
	var events int
	if err := repository.pool.QueryRow(context.Background(), "SELECT count(*) FROM agent_controller.agent_events WHERE event_id=$1", input.EventID).Scan(&events); err != nil || events != 1 {
		t.Fatalf("failure event count=%d %v", events, err)
	}
}
