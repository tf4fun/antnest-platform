package postgres

import (
	"strings"
	"testing"
)

func TestInitialMigrationOwnsCompleteAgentControllerBoundary(t *testing.T) {
	t.Parallel()

	required := []string{
		"agent_controller.catalog_requests",
		"agent_controller.provider_credentials",
		"agent_controller.model_profiles",
		"agent_controller.model_profile_revisions",
		"agent_controller.agent_templates",
		"agent_controller.agent_template_revisions",
		"agent_controller.agents",
		"agent_controller.agent_spec_revisions",
		"agent_controller.execution_revisions",
		"agent_controller.agent_access_bindings",
		"agent_controller.agent_lifecycle_operations",
		"agent_controller.run_admissions",
		"agent_controller.runtime_observation_cursor",
		"agent_controller.event_journal_cursor",
		"agent_controller.agent_events",
	}
	for _, table := range required {
		if !strings.Contains(initialSchemaSQL, table) {
			t.Errorf("initial migration does not define %s", table)
		}
	}

	forbidden := []string{"identity.", "runtime_controller.", "runtime_egress.", "agent_acp."}
	for _, schema := range forbidden {
		if strings.Contains(initialSchemaSQL, schema) {
			t.Errorf("migration reaches another service schema %s", schema)
		}
	}
}

func TestSchemaMigrationsHaveFinalSerializationConstraints(t *testing.T) {
	t.Parallel()

	allMigrations := initialSchemaSQL + ownerAndEmptySkillsSQL
	required := []string{
		"operations_agent_nonterminal_unique",
		"admissions_agent_occupancy_unique",
		"agent_events_aggregate_sequence_unique",
		"UNIQUE (organization_id, profile_key)",
		"UNIQUE (organization_id, template_key)",
		"source_runtime_absent",
		"model_profile_head_fk",
		"model_profile_credential_fk",
		"template_head_fk",
		"template_model_revision_fk",
		"agents_projection_idx",
		"agents_organization_projection_idx",
		"agents_owner_projection_idx",
		"agents_state_projection_idx",
		"agents_global_projection_idx",
		"notify_agent_event_commit",
		"agent_events_notify_commit",
		"event_journal_cursor_singleton",
		"runtime_observation_cursor_singleton",
		"agent_events_type_known",
		"agents_owner_access_revision_unique",
		"access_bindings_agent_unique",
		"access_bindings_owner_fk",
		"run_admissions_empty_skills",
	}
	for _, constraint := range required {
		if !strings.Contains(allMigrations, constraint) {
			t.Errorf("schema migrations lack %s", constraint)
		}
	}
}

func TestMigrationRecordRejectsNameOrChecksumDrift(t *testing.T) {
	t.Parallel()

	if err := validateMigrationRecord(1, "initial_agent_controller_schema", "checksum", "initial_agent_controller_schema", "checksum"); err != nil {
		t.Fatalf("matching migration record: %v", err)
	}
	if err := validateMigrationRecord(1, "initial_agent_controller_schema", "checksum", "renamed", "checksum"); err == nil {
		t.Fatal("migration name drift was accepted")
	}
	if err := validateMigrationRecord(1, "initial_agent_controller_schema", "checksum", "initial_agent_controller_schema", "changed"); err == nil {
		t.Fatal("migration checksum drift was accepted")
	}
}

func TestMigrationHistoryMustBeAnExactPrefix(t *testing.T) {
	t.Parallel()

	versionOne := schemaMigrations[0]
	valid := []migrationRecord{{
		version: versionOne.version, name: versionOne.name, checksum: migrationChecksum(versionOne.sql),
	}}
	if err := validateMigrationHistory(valid); err != nil {
		t.Fatalf("valid prefix rejected: %v", err)
	}
	invalid := []migrationRecord{{
		version: 2, name: schemaMigrations[1].name, checksum: migrationChecksum(schemaMigrations[1].sql),
	}}
	if err := validateMigrationHistory(invalid); err == nil {
		t.Fatal("migration history with a missing first version was accepted")
	}
}
