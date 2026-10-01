package postgres

import (
	"strings"
	"testing"
)

func TestReleaseDoesNotEmbedLegacySkillMigrations(t *testing.T) {
	files, err := migrationFiles.ReadDir("migrations")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if strings.Contains(file.Name(), "legacy_") {
			t.Errorf("release still embeds %s", file.Name())
		}
	}
	for _, migration := range schemaMigrations {
		if strings.Contains(migration.name, "legacy_") || strings.Contains(migration.sql, "legacy_system_skills") || strings.Contains(migration.sql, "legacy_skill_migration") {
			t.Errorf("release still applies %s", migration.name)
		}
	}
}
