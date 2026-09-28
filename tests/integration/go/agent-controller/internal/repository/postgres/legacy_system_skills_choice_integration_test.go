package postgres

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestLegacyChoiceKeepsGateClosedAndPreservesAuditableRevisions(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	base, _ := seedConfiguredAgentForTest(t, ctx, repository, false)
	agent := base.Agent
	if _, err := repository.pool.Exec(ctx, `INSERT INTO agent_controller.legacy_system_skills_migrations(agent_id,organization_id,state) VALUES($1,$2,'pending')`, agent.AgentID, agent.OrganizationID); err != nil {
		t.Fatal(err)
	}
	choice := ports.LegacySkillChoice{
		RequestID: "legacy-choice-1", Fingerprint: strings.Repeat("a", 64), AgentID: agent.AgentID,
		OrganizationID: agent.OrganizationID, ActorPrincipalID: "admin-1", Kind: "empty",
		VolumeName: "legacy-volume", InventoryDigest: "sha256:" + strings.Repeat("b", 64),
		BackupRef: "artifact-backup-1", BackupDigest: "sha256:" + strings.Repeat("c", 64),
		CreatedAt: time.Now().UTC(),
	}
	first, err := repository.RecordLegacySkillChoice(ctx, choice)
	if err != nil || first.Sequence != 1 {
		t.Fatalf("first choice=%+v, %v", first, err)
	}
	if replay, err := repository.RecordLegacySkillChoice(ctx, choice); err != nil || replay.Sequence != 1 || !replay.CreatedAt.Equal(first.CreatedAt) {
		t.Fatalf("exact replay=%+v, %v", replay, err)
	}
	choice.Fingerprint = strings.Repeat("d", 64)
	if _, err := repository.RecordLegacySkillChoice(ctx, choice); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("conflicting replay=%v", err)
	}
	choice.RequestID, choice.Fingerprint, choice.Kind = "legacy-choice-2", strings.Repeat("e", 64), "template_revision"
	choice.TemplateID, choice.TemplateRevision = "template-1", 2
	second, err := repository.RecordLegacySkillChoice(ctx, choice)
	if err != nil || second.Sequence != 2 {
		t.Fatalf("replacement choice=%+v, %v", second, err)
	}
	record, err := repository.GetLegacySkillMigration(ctx, agent.OrganizationID, agent.AgentID)
	if err != nil || record.State != "pending" || record.LatestChoice == nil || record.LatestChoice.RequestID != "legacy-choice-2" {
		t.Fatalf("legacy migration record=%+v, %v", record, err)
	}
	if pending, err := repository.LegacySystemSkillsMigrationRequired(ctx, agent.AgentID); err != nil || !pending {
		t.Fatalf("choice reopened Agent admission: %t %v", pending, err)
	}
	if _, err := repository.GetLegacySkillMigration(ctx, "foreign-org", agent.AgentID); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("cross-organization record=%v", err)
	}
	if _, err := repository.RecordLegacySkillChoice(ctx, ports.LegacySkillChoice{RequestID: "foreign", Fingerprint: strings.Repeat("f", 64), AgentID: agent.AgentID, OrganizationID: "foreign-org", ActorPrincipalID: "admin-2", Kind: "empty", VolumeName: "legacy-volume", InventoryDigest: choice.InventoryDigest, BackupRef: choice.BackupRef, BackupDigest: choice.BackupDigest, CreatedAt: choice.CreatedAt}); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("cross-organization choice=%v", err)
	}
}
