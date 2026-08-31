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

func TestInitialMigrationHasFinalSerializationConstraints(t *testing.T) {
	t.Parallel()

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
	}
	for _, constraint := range required {
		if !strings.Contains(initialSchemaSQL, constraint) {
			t.Errorf("initial migration lacks %s", constraint)
		}
	}
}

func TestMigrationRecordRejectsNameOrChecksumDrift(t *testing.T) {
	t.Parallel()

	if err := validateMigrationRecord("initial_agent_controller_schema", "checksum", "initial_agent_controller_schema", "checksum"); err != nil {
		t.Fatalf("matching migration record: %v", err)
	}
	if err := validateMigrationRecord("initial_agent_controller_schema", "checksum", "renamed", "checksum"); err == nil {
		t.Fatal("migration name drift was accepted")
	}
	if err := validateMigrationRecord("initial_agent_controller_schema", "checksum", "initial_agent_controller_schema", "changed"); err == nil {
		t.Fatal("migration checksum drift was accepted")
	}
}
