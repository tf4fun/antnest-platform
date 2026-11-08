package postgres

import "testing"

func TestResourceIDMigrationPlan(t *testing.T) {
	if err := validateMigrationPlan(); err != nil {
		t.Fatalf("migration plan must stay valid: %v", err)
	}
	if len(schemaMigrations) != 16 {
		t.Fatalf("expected 16 migrations, got %d", len(schemaMigrations))
	}
	last := schemaMigrations[len(schemaMigrations)-1]
	if last.version != 16 || last.name != "opaque_resource_references" {
		t.Fatalf("unexpected newest migration: %+v", last)
	}
	if last.sql != resourceIDsSQL {
		t.Fatal("migration 16 must run resourceIDsSQL")
	}
	if got := migrationChecksum(resourceIDsSQL); got != last.checksum {
		t.Fatalf("migration 16 checksum %s, expected %s", last.checksum, got)
	}
	for index, candidate := range schemaMigrations[:len(schemaMigrations)-1] {
		if candidate.version != int64(index+1) {
			t.Fatalf("migration %d moved to version %d", index+1, candidate.version)
		}
	}
}
