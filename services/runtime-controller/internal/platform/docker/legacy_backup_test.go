package docker

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type unavailableLegacyBackupEngine struct{}

func (unavailableLegacyBackupEngine) InspectVolume(context.Context, string) (Volume, error) {
	return Volume{}, errors.New("Docker unavailable")
}

func (unavailableLegacyBackupEngine) ListAllContainers(context.Context) ([]Container, error) {
	return nil, errors.New("Docker unavailable")
}

func TestLegacyBackupWriterReplaysVerifiedReceiptWithoutDocker(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	if err := os.Chmod(destination, 0700); err != nil {
		t.Fatal(err)
	}
	inventory, err := InventoryLegacySystemSkills(context.Background(), source, "legacy", "scope", nil)
	if err != nil {
		t.Fatal(err)
	}
	first, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", inventory.InventoryDigest, "replay", nil)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := NewLegacyBackupWriter(unavailableLegacyBackupEngine{}, source, destination, "legacy", "scope")
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := writer.Backup(context.Background(), "replay", inventory.InventoryDigest)
	if err != nil || replayed.ManifestDigest != first.ManifestDigest {
		t.Fatalf("offline replay=%+v err=%v", replayed, err)
	}
	got, err := writer.Receipt(context.Background(), "replay")
	if err != nil || got.ManifestDigest != first.ManifestDigest || got.ArchiveDigest != first.ArchiveDigest {
		t.Fatalf("offline receipt=%+v err=%v", got, err)
	}
	if _, err := writer.Receipt(context.Background(), "missing"); !errors.Is(err, ErrLegacyBackupNotFound) {
		t.Fatalf("missing receipt error=%v", err)
	}
	if _, err := writer.Receipt(context.Background(), "../escape"); err == nil {
		t.Fatal("invalid backup ID accepted")
	}
	if err := os.WriteFile(filepath.Join(destination, "replay", "archive.tar"), []byte("corrupt"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Receipt(context.Background(), "replay"); err == nil {
		t.Fatal("corrupt stored receipt accepted")
	}
}

func TestLegacyBackupCopiesExactTreeAndReplaysVerifiedReceipt(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	if err := os.Chmod(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(source, "code-review"), 0755); err != nil {
		t.Fatal(err)
	}
	body := []byte("old private Skill\n")
	if err := os.WriteFile(filepath.Join(source, "code-review", "SKILL.md"), body, 0444); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("code-review/SKILL.md", filepath.Join(source, "shortcut")); err != nil {
		t.Fatal(err)
	}
	inventory, err := InventoryLegacySystemSkills(context.Background(), source, "legacy", "scope", nil)
	if err != nil {
		t.Fatal(err)
	}
	receipt, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", inventory.InventoryDigest, "backup-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.BackupRef != "backup-1" || receipt.VolumeName != "legacy" || receipt.InventoryDigest != inventory.InventoryDigest || len(receipt.Entries) != len(inventory.Entries) || !strings.HasPrefix(receipt.ArchiveDigest, "sha256:") || !strings.HasPrefix(receipt.ManifestDigest, "sha256:") {
		t.Fatalf("incomplete backup receipt: %+v", receipt)
	}
	backupDirectory := filepath.Join(destination, "backup-1")
	if info, err := os.Stat(backupDirectory); err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("backup directory mode=%v err=%v", info, err)
	}
	archivePath := filepath.Join(backupDirectory, "archive.tar")
	if info, err := os.Stat(archivePath); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("archive mode=%v err=%v", info, err)
	}
	for _, name := range []string{"manifest.json", "receipt.sha256"} {
		if info, err := os.Lstat(filepath.Join(backupDirectory, name)); err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			t.Fatalf("%s mode=%v err=%v", name, info, err)
		}
	}
	archive, err := os.Open(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = archive.Close() }()
	reader := tar.NewReader(archive)
	seen := make(map[string]string)
	for {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		content, err := io.ReadAll(reader)
		if err != nil {
			t.Fatal(err)
		}
		seen[header.Name] = string(content)
		if header.Name == "shortcut" && (header.Typeflag != tar.TypeSymlink || header.Linkname != "code-review/SKILL.md") {
			t.Fatalf("symlink changed: %+v", header)
		}
	}
	if seen["code-review/SKILL.md"] != string(body) || len(seen) != 3 {
		t.Fatalf("archive content differs: %+v", seen)
	}
	replayed, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", inventory.InventoryDigest, "backup-1", nil)
	if err != nil || replayed.ManifestDigest != receipt.ManifestDigest {
		t.Fatalf("verified replay=%+v err=%v", replayed, err)
	}
	if err := os.WriteFile(archivePath, []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", inventory.InventoryDigest, "backup-1", nil); err == nil {
		t.Fatal("corrupted archive replayed")
	}
}

func TestLegacyBackupReplayRejectsSymlinkedManifest(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	if err := os.Chmod(destination, 0700); err != nil {
		t.Fatal(err)
	}
	inventory, err := InventoryLegacySystemSkills(context.Background(), source, "legacy", "scope", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", inventory.InventoryDigest, "backup-3", nil); err != nil {
		t.Fatal(err)
	}
	manifest := filepath.Join(destination, "backup-3", "manifest.json")
	copy := filepath.Join(destination, "copy.json")
	bytes, err := os.ReadFile(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copy, bytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(manifest); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(copy, manifest); err != nil {
		t.Fatal(err)
	}
	if _, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", inventory.InventoryDigest, "backup-3", nil); err == nil {
		t.Fatal("symlinked manifest replayed")
	}
}

func TestLegacyBackupRejectsChangedInventoryAndUnsupportedInput(t *testing.T) {
	source := t.TempDir()
	destination := t.TempDir()
	if err := os.Chmod(destination, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(source, "file"), []byte("a"), 0644); err != nil {
		t.Fatal(err)
	}
	old := sha256.Sum256([]byte("old"))
	if _, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", "sha256:"+hex.EncodeToString(old[:]), "backup-2", nil); err == nil {
		t.Fatal("changed source was backed up")
	}
	if _, err := os.Stat(filepath.Join(destination, "backup-2")); !os.IsNotExist(err) {
		t.Fatalf("failed backup left receipt directory: %v", err)
	}
	if _, err := CreateLegacySystemSkillsBackup(context.Background(), source, destination, "legacy", "scope", "invalid", "../escape", nil); err == nil {
		t.Fatal("invalid backup identity accepted")
	}
}
