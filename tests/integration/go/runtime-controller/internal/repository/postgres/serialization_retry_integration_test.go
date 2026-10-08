package postgres

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

// Mutations of different Agents hold different Agent locks, so PostgreSQL may
// abort one of their SERIALIZABLE transactions (SQLSTATE 40001). Offboarding
// disables every Agent of a principal at once; no caller may see that abort.
func TestRepositoryConcurrentAgentTransitionsSurviveSerializationFailures(t *testing.T) {
	repository, _, ctx := integrationRepository(t)
	const agents = 12
	for round := range 3 {
		now := time.Date(2026, 10, 8, 0, 0, round, 0, time.UTC)
		start := make(chan struct{})
		errs := make(chan error, agents)
		var group sync.WaitGroup
		for index := range agents {
			group.Add(1)
			go func() {
				defer group.Done()
				<-start
				requestID := fmt.Sprintf("init-%d-%d", round, index)
				operation := integrationOperation(requestID, deployment.OperationInitializeRuntime, now)
				operation.AgentID = fmt.Sprintf("agent-%d-%d", round, index)
				operation.ImageReference = "antnest/runtime:latest"
				operation.ImageID = integrationSpecDigest
				operation.Transition = deployment.LifecycleInitializing
				started, _, err := repository.BeginTransition(ctx, operation)
				if err != nil {
					errs <- fmt.Errorf("begin %s: %w", requestID, err)
					return
				}
				started.State = deployment.OperationCompleted
				started.Effect = deployment.EffectCompleted
				started.Inspection = integrationEnvironment(started, deployment.LifecycleProvisioned, now)
				observation := deployment.Observation{
					AgentID: started.AgentID, RuntimeRevision: started.RuntimeRevision,
					Kind: deployment.ObservationInitialized, Source: "integration_test", ObservedAt: now,
				}
				if _, err := repository.CompleteOperation(ctx, started, &observation); err != nil {
					errs <- fmt.Errorf("complete %s: %w", requestID, err)
				}
			}()
		}
		close(start)
		group.Wait()
		close(errs)
		for err := range errs {
			t.Error(err)
		}
	}
}
