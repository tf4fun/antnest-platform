package postgres

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestMigrationUpgradesAnUnchangedVersionOneDatabase(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatalf("open repository: %v", err)
	}
	t.Cleanup(repository.Close)
	if _, err := repository.pool.Exec(ctx, "DROP SCHEMA IF EXISTS agent_controller CASCADE"); err != nil {
		t.Fatalf("drop Agent Controller schema: %v", err)
	}
	if _, err := repository.pool.Exec(ctx, initialSchemaSQL); err != nil {
		t.Fatalf("apply version-one schema: %v", err)
	}
	if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.schema_migrations (version, name, checksum)
VALUES (1, $1, $2)`, schemaMigrations[0].name, migrationChecksum(initialSchemaSQL)); err != nil {
		t.Fatalf("record version-one schema: %v", err)
	}
	now := time.Unix(100, 0).UTC()
	if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.agents (
    id, organization_id, owner_user_id, name, desired_state, lifecycle_state,
    access_revision, runtime_revision, aggregate_sequence, created_at, updated_at
) VALUES ('agent-migration', 'organization-migration', 'user-migration', 'Migration Agent',
	      'enabled', 'available', 'access-migration', 'runtime-migration', 0, $1, $1)`, now); err != nil {
		t.Fatalf("seed version-one Agent: %v", err)
	}
	if _, err := repository.pool.Exec(ctx, `
INSERT INTO agent_controller.run_admissions (
    admission_id, request_id, request_fingerprint, agent_id, session_id,
    principal_id, access_revision, state, deadline, runtime_revision,
    snapshot, terminal_report, finished_at, created_at, updated_at
) VALUES (
    'admission-migration', 'request-run-migration', $2, 'agent-migration',
    'session-migration', 'user-migration', 'access-migration',
    'blocked_unknown_effect', $3, 'runtime-migration',
    '{"runtime":{"runtime_revision":"runtime-migration"},"execution_spec":{"skill_instructions":[]}}'::jsonb,
    '{"terminal_class":"unresolved","tool_effect_state":"unknown","stop_reason":"","error_class":"tool_effect_unknown"}'::jsonb,
    $1, $1, $1
)`, now, strings.Repeat("a", 64), now.Add(time.Hour)); err != nil {
		t.Fatalf("seed version-one unresolved Run: %v", err)
	}

	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("upgrade Agent Controller schema: %v", err)
	}
	if err := repository.Migrate(ctx); err != nil {
		t.Fatalf("replay Agent Controller migrations: %v", err)
	}
	var count int
	if err := repository.pool.QueryRow(ctx,
		"SELECT count(*) FROM agent_controller.schema_migrations",
	).Scan(&count); err != nil {
		t.Fatalf("count applied migrations: %v", err)
	}
	if count != len(schemaMigrations) {
		t.Fatalf("applied migrations = %d, want %d", count, len(schemaMigrations))
	}
	var source string
	if err := repository.pool.QueryRow(ctx, `
SELECT terminal_report ->> 'unknown_effect_source'
FROM agent_controller.run_admissions
WHERE admission_id = 'admission-migration'`).Scan(&source); err != nil {
		t.Fatalf("read migrated unresolved source: %v", err)
	}
	if source != string(domain.UnknownEffectUnclassified) {
		t.Fatalf("migrated unresolved source = %q", source)
	}
	replayed, err := repository.FinishRun(ctx, ports.FinishRunCommand{
		RequestID: "request-replay-migration", AdmissionID: "admission-migration",
		Report: domain.TerminalReport{
			Class: domain.TerminalUnresolved, ToolEffectState: domain.ToolEffectUnknown,
			UnknownEffectSource: domain.UnknownEffectUnclassified,
			ErrorClass:          "tool_effect_unknown",
		},
		Event: &ports.RunAdmissionEvent{
			EventID: "event-replay-migration", EventType: ports.EventRunAdmissionUnresolved,
			Data:       map[string]any{"terminal_class": string(domain.TerminalUnresolved)},
			OccurredAt: now.Add(2 * time.Hour),
		},
		Now: now.Add(2 * time.Hour),
	})
	if err != nil || replayed.Status != "already_finished" {
		t.Fatalf("replay migrated unresolved Run: result=%+v err=%v", replayed, err)
	}
}
