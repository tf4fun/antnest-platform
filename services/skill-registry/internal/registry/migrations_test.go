package registry

import "testing"

func TestMigrationJournalRejectsUnknownOrChangedVersion(t *testing.T) {
	if err := validateMigrationJournal(map[string]string{}, "abc"); err != nil {
		t.Fatal(err)
	}
	if err := validateMigrationJournal(map[string]string{"0001_registry.sql": "abc"}, "abc"); err != nil {
		t.Fatal(err)
	}
	for _, journal := range []map[string]string{
		{"0001_registry.sql": "changed"},
		{"0001_registry.sql": "abc", "0002_future.sql": "future"},
	} {
		if err := validateMigrationJournal(journal, "abc"); err == nil {
			t.Fatalf("accepted incompatible migration journal: %v", journal)
		}
	}
}
