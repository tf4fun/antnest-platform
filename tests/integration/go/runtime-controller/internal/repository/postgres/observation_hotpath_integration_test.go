package postgres

import (
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestRepositoryObservationWritesDoNotPrune(t *testing.T) {
	for _, action := range []string{"append", "completion"} {
		t.Run(action, func(t *testing.T) {
			store, database, ctx := integrationRepository(t)
			epoch := observationTestEpoch(t, store, ctx)
			if _, err := database.ExecContext(ctx, `
CREATE TABLE runtime_controller.observation_delete_audit (observed BOOLEAN NOT NULL);
CREATE FUNCTION runtime_controller.audit_observation_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO runtime_controller.observation_delete_audit (observed) VALUES (TRUE);
  RETURN NULL;
END $$;
CREATE TRIGGER audit_observation_delete AFTER DELETE ON runtime_controller.observations
FOR EACH STATEMENT EXECUTE FUNCTION runtime_controller.audit_observation_delete();`); err != nil {
				t.Fatal(err)
			}

			now := time.Now().UTC()
			fact := deployment.Observation{
				Kind: deployment.ObservationReconciled, Source: "hotpath_append", ObservedAt: now,
			}
			var stored deployment.Observation
			if action == "append" {
				value, err := store.AppendObservation(ctx, epoch, fact)
				if err != nil {
					t.Fatalf("append observation: %v", err)
				}
				stored = value
			} else {
				operation := integrationOperation("hotpath-init", deployment.OperationInitializeRuntime, now)
				operation.Transition = deployment.LifecycleInitializing
				started, replay, err := store.BeginTransition(ctx, operation)
				if err != nil || replay {
					t.Fatalf("begin initialization: replay=%t err=%v", replay, err)
				}
				started.State, started.Effect = deployment.OperationCompleted, deployment.EffectCompleted
				started.Inspection = integrationEnvironment(started, deployment.LifecycleProvisioned, now)
				fact = deployment.Observation{
					AgentID: started.AgentID, RuntimeRevision: started.RuntimeRevision,
					Kind: deployment.ObservationInitialized, Source: "hotpath_completion", ObservedAt: now,
				}
				value, err := store.CompleteOperation(ctx, started, &fact)
				if err != nil || value == nil {
					t.Fatalf("complete initialization: observation=%+v err=%v", value, err)
				}
				stored = *value
			}

			window, err := store.ListObservations(ctx, 0, 10)
			if err != nil || len(window.Observations) != 1 || stored.Sequence == 0 {
				t.Fatalf("committed observation is not readable: %+v stored=%+v err=%v", window, stored, err)
			}
			observed := window.Observations[0]
			if observed.Sequence != stored.Sequence || observed.Kind != fact.Kind ||
				observed.Source != fact.Source || observed.AgentID != fact.AgentID || observed.RuntimeRevision != fact.RuntimeRevision {
				t.Fatalf("committed observation changed: %+v want=%+v", observed, fact)
			}
			var deletes int
			if err := database.QueryRowContext(ctx,
				`SELECT count(*) FROM runtime_controller.observation_delete_audit`,
			).Scan(&deletes); err != nil {
				t.Fatal(err)
			}
			if deletes != 0 {
				t.Fatalf("observation %s executed %d DELETE statements; want 0", action, deletes)
			}
		})
	}
}
