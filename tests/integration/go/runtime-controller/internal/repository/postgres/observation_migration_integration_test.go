package postgres

import (
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/repository"
)

func TestObservationRetentionUpgradeFromVersionTwelve(t *testing.T) {
	for _, history := range []bool{false, true} {
		name := "empty"
		if history {
			name = "retained sparse history"
		}
		t.Run(name, func(t *testing.T) {
			store, database, ctx := integrationRepository(t)
			if _, err := database.ExecContext(ctx, "DROP SCHEMA runtime_controller CASCADE"); err != nil {
				t.Fatal(err)
			}
			if _, err := database.ExecContext(ctx, bootstrapSQL); err != nil {
				t.Fatal(err)
			}
			for _, migration := range schemaMigrations {
				if migration.version > 12 {
					break
				}
				if _, err := database.ExecContext(ctx, migration.sql); err != nil {
					t.Fatal(err)
				}
				if _, err := database.ExecContext(ctx, `INSERT INTO runtime_controller.schema_migrations(version,name,checksum) VALUES ($1,$2,$3)`, migration.version, migration.name, migration.checksum); err != nil {
					t.Fatal(err)
				}
			}
			if history {
				if _, err := database.ExecContext(ctx, `
INSERT INTO runtime_controller.observations(sequence,agent_id,runtime_revision,generation,spec_digest,kind,source,observed_at)
VALUES (10,'','',0,'','reconciled','legacy-10',NOW()),(20,'','',0,'','reconciled','legacy-20',NOW());
SELECT setval('runtime_controller.observations_sequence_seq',20,true);`); err != nil {
					t.Fatal(err)
				}
			}
			if err := Migrate(ctx, database); err != nil {
				t.Fatal(err)
			}
			window, err := store.ListObservations(ctx, 0, 10)
			if err != nil {
				t.Fatal(err)
			}
			if history {
				if len(window.Observations) != 2 || window.PrunedThrough != 9 || window.LatestSequence != 20 {
					t.Fatalf("legacy history changed: %+v", window)
				}
			} else if len(window.Observations) != 0 || window.PrunedThrough != 0 || window.LatestSequence != 0 {
				t.Fatalf("empty legacy floor: %+v", window)
			}
			epoch := observationTestEpoch(t, store, ctx)
			if epoch <= 0 {
				t.Fatalf("upgraded epoch: %d", epoch)
			}
			if history {
				store.maxObservationRows = 1
				if count, err := store.PruneObservationBatch(ctx, epoch); err != nil || count != 1 {
					t.Fatalf("sparse actual-row bound: %d %v", count, err)
				}
				window, err = store.ListObservations(ctx, 10, 10)
				if err != nil || len(window.Observations) != 1 || window.PrunedThrough != 10 || window.Observations[0].Sequence != 20 {
					t.Fatalf("sparse retained window: %+v %v", window, err)
				}
			}
			if err := Migrate(ctx, database); err != nil {
				t.Fatal(err)
			}
			var repeated repository.ObservationEpoch
			if err := database.QueryRowContext(ctx, "SELECT epoch FROM runtime_controller.observation_leader WHERE id=1").Scan(&repeated); err != nil {
				t.Fatal(err)
			}
			if repeated != epoch {
				t.Fatalf("repeat migration reset epoch: %d -> %d", epoch, repeated)
			}
			repeatedWindow, err := store.ListObservations(ctx, 0, 10)
			if err != nil || repeatedWindow.PrunedThrough != window.PrunedThrough {
				t.Fatalf("repeat migration reset floor: %+v %v", repeatedWindow, err)
			}
		})
	}
}
