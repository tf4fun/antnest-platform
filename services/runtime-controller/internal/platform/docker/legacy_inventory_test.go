package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyInventoryHashesEntriesWithoutFollowingLinks(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "code-review"), 0755); err != nil {
		t.Fatal(err)
	}
	body := []byte("---\nname: code-review\ndescription: Review code\n---\nOld body\n")
	if err := os.WriteFile(filepath.Join(root, "code-review", "SKILL.md"), body, 0444); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/outside-secret", filepath.Join(root, "pointer")); err != nil {
		t.Fatal(err)
	}
	containers := []Container{
		{ID: "owned", Running: true, Labels: map[string]string{labelManaged: "runtime", labelScope: "scope-a", labelAgentID: "agent_a"}, Mounts: []ObservedMount{{Type: "volume", Name: "legacy", Destination: "/skills"}}},
		{ID: "foreign", Labels: map[string]string{}, Mounts: []ObservedMount{{Type: "volume", Name: "legacy", Destination: "/other"}}},
		{ID: "unrelated", Mounts: []ObservedMount{{Type: "volume", Name: "another", Destination: "/skills"}}},
	}
	got, err := InventoryLegacySystemSkills(context.Background(), root, "legacy", "scope-a", containers)
	if err != nil {
		t.Fatal(err)
	}
	if got.VolumeName != "legacy" || len(got.Entries) != 3 || len(got.References) != 2 {
		t.Fatalf("incomplete legacy inventory: %+v", got)
	}
	if got.Entries[0].Path != "code-review" || got.Entries[0].Kind != "directory" ||
		got.Entries[1].Path != "code-review/SKILL.md" || got.Entries[1].Kind != "regular" ||
		got.Entries[2].Path != "pointer" || got.Entries[2].Kind != "symlink" {
		t.Fatalf("wrong entries: %+v", got.Entries)
	}
	hash := sha256.Sum256(body)
	if got.Entries[1].Digest != "sha256:"+hex.EncodeToString(hash[:]) || got.Entries[1].Size != int64(len(body)) {
		t.Fatalf("file identity differs: %+v", got.Entries[1])
	}
	if got.References[0].AgentID != "" || got.References[0].Managed || got.References[1].AgentID != "agent_a" || !got.References[1].Managed {
		t.Fatalf("unsafe reference attribution: %+v", got.References)
	}
	if got.InventoryDigest == "" {
		t.Fatal("missing inventory digest")
	}
}

func TestLegacyInventoryRejectsAbsentRootAndCancellation(t *testing.T) {
	if _, err := InventoryLegacySystemSkills(context.Background(), filepath.Join(t.TempDir(), "missing"), "legacy", "scope", nil); err == nil {
		t.Fatal("missing volume mount reported as empty")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := InventoryLegacySystemSkills(ctx, t.TempDir(), "legacy", "scope", nil); err == nil {
		t.Fatal("cancelled inventory returned a partial observation")
	}
}

func TestLegacyInventorySortsDirectoryChildrenAgainstSiblingPrefixes(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "code-review"), 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"code-review/SKILL.md", "code-review.txt"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0644); err != nil {
			t.Fatal(err)
		}
	}
	inventory, err := InventoryLegacySystemSkills(context.Background(), root, "legacy", "scope", nil)
	if err != nil {
		t.Fatal(err)
	}
	for index, path := range []string{"code-review", "code-review.txt", "code-review/SKILL.md"} {
		if inventory.Entries[index].Path != path {
			t.Fatalf("entries[%d]=%q want %q", index, inventory.Entries[index].Path, path)
		}
	}
}
