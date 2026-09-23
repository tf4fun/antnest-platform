package postgres

import (
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRepositoryCreationCompletionIsIndependentFromObservations(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	now := time.Now().UTC()
	input := integrationOperation("create-observation", deployment.OperationInitializeRuntime, now)
	input.Transition = deployment.LifecycleInitializing
	operation, _, err := repository.BeginTransition(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	operation.State, operation.Effect = deployment.OperationCompleted, deployment.EffectCompleted
	operation.Inspection = integrationEnvironment(operation, deployment.LifecycleProvisioned, now)
	operation.Inspection.Health = deployment.HealthUnknown
	operation.Inspection.RuntimeExecutionID, operation.Inspection.MCPEndpoint = "", ""
	if _, err := repository.CompleteOperation(ctx, operation, nil); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []deployment.ObservationKind{deployment.ObservationStarting, deployment.ObservationHealthy, deployment.ObservationUnhealthy} {
		_, err := repository.AppendObservation(ctx, deployment.Observation{
			AgentID: operation.AgentID, Generation: operation.Generation, SpecDigest: operation.SpecDigest,
			RuntimeRevision: operation.RuntimeRevision, Kind: kind, Source: "test", ObservedAt: now,
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	stored, err := repository.GetOperation(ctx, operation.RequestID)
	if err != nil || stored.State != deployment.OperationCompleted || stored.ErrorCode != "" || stored.Inspection.Health != deployment.HealthUnknown {
		t.Fatalf("observation changed creation history: %+v %v", stored, err)
	}
	head, err := repository.GetEnvironment(ctx, operation.AgentID)
	if err != nil || head.LifecycleState != deployment.LifecycleProvisioned || head.OperationID != "" {
		t.Fatalf("creation did not release the lifecycle slot: %+v %v", head, err)
	}
}
