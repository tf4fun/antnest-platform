package registry

import "testing"

func TestDiscoveryMigrationJournalSupportsOrderedUpgradeWithoutRewritingBase(t *testing.T) {
	expected := map[string]string{"0001_registry.sql": "base", "0002_discovery.sql": "new"}
	for _, journal := range []map[string]string{{}, {"0001_registry.sql": "base"}, expected} {
		if err := validateMigrationJournal(journal, expected); err != nil {
			t.Fatal(err)
		}
	}
	for _, journal := range []map[string]string{
		{"0001_registry.sql": "changed"}, {"0002_discovery.sql": "new"}, {"0001_registry.sql": "base", "0003_unknown.sql": "?"}} {
		if err := validateMigrationJournal(journal, expected); err == nil {
			t.Fatalf("accepted incompatible journal %+v", journal)
		}
	}
}
