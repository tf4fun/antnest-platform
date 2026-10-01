package registry

import "testing"

func TestMigrationJournalRejectsUnknownOrChangedVersion(t *testing.T) {
	expected := map[string]string{"0001_registry.sql": "abc"}
	if err := validateMigrationJournal(map[string]string{}, expected); err != nil {
		t.Fatal(err)
	}
	if err := validateMigrationJournal(map[string]string{"0001_registry.sql": "abc"}, expected); err != nil {
		t.Fatal(err)
	}
	for _, journal := range []map[string]string{
		{"0001_registry.sql": "changed"},
		{"0001_registry.sql": "abc", "0002_future.sql": "future"},
	} {
		if err := validateMigrationJournal(journal, expected); err == nil {
			t.Fatalf("accepted incompatible migration journal: %v", journal)
		}
	}
}
