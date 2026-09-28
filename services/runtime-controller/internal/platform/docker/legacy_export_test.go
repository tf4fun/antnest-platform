package docker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestLegacyBackupExportCopiesAndRevalidatesPrivateDestination(t *testing.T) {
	sourceTree := t.TempDir()
	backupRoot := t.TempDir()
	exportRoot := t.TempDir()
	for _, root := range []string{backupRoot, exportRoot} {
		if err := os.Chmod(root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(sourceTree, "old-skill.txt"), []byte("legacy content"), 0444); err != nil {
		t.Fatal(err)
	}
	inventory, err := InventoryLegacySystemSkills(context.Background(), sourceTree, "legacy", "scope", nil)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := CreateLegacySystemSkillsBackup(context.Background(), sourceTree, backupRoot, "legacy", "scope", inventory.InventoryDigest, "backup-1", nil)
	if err != nil {
		t.Fatal(err)
	}
	exported, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, exportRoot, "backup-1", "legacy", backup.ManifestDigest)
	if err != nil || exported.ManifestDigest != backup.ManifestDigest || exported.ArchiveDigest != backup.ArchiveDigest {
		t.Fatalf("export=%+v err=%v", exported, err)
	}
	for _, name := range []string{"archive.tar", "manifest.json", "receipt.sha256"} {
		info, err := os.Lstat(filepath.Join(exportRoot, "backup-1", name))
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 {
			t.Fatalf("export %s mode=%v err=%v", name, info, err)
		}
	}
	if info, err := os.Lstat(filepath.Join(exportRoot, "backup-1")); err != nil || !info.IsDir() || info.Mode().Perm() != 0700 {
		t.Fatalf("export directory mode=%v err=%v", info, err)
	}
	if err := os.RemoveAll(backupRoot); err != nil {
		t.Fatal(err)
	}
	if replayed, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, exportRoot, "backup-1", "legacy", backup.ManifestDigest); err != nil || replayed.ManifestDigest != backup.ManifestDigest {
		t.Fatalf("replay required source or differed: %+v err=%v", replayed, err)
	}
	if err := os.WriteFile(filepath.Join(exportRoot, "backup-1", "archive.tar"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, exportRoot, "backup-1", "legacy", backup.ManifestDigest); err == nil {
		t.Fatal("corrupt export replayed")
	}
}

func TestLegacyBackupExportWaitingForDestinationLockHonorsCancellation(t *testing.T) {
	sourceRoot := t.TempDir()
	destinationRoot := t.TempDir()
	if err := os.Chmod(destinationRoot, 0700); err != nil {
		t.Fatal(err)
	}
	lock, err := os.OpenFile(filepath.Join(destinationRoot, ".legacy-export.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = lock.Close() }()
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Millisecond)
	defer cancel()
	if _, err := ExportLegacySystemSkillsBackup(ctx, sourceRoot, destinationRoot, "backup-1", "legacy", "sha256:"+strings.Repeat("a", 64)); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("lock wait ignored deadline: %v", err)
	}
}

func TestLegacyBackupExportRejectsWrongIdentityAndUnsafeDestination(t *testing.T) {
	sourceTree := t.TempDir()
	backupRoot := t.TempDir()
	exportRoot := t.TempDir()
	for _, root := range []string{backupRoot, exportRoot} {
		if err := os.Chmod(root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	inventory, err := InventoryLegacySystemSkills(context.Background(), sourceTree, "legacy", "scope", nil)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := CreateLegacySystemSkillsBackup(context.Background(), sourceTree, backupRoot, "legacy", "scope", inventory.InventoryDigest, "backup-2", nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, exportRoot, "backup-2", "legacy", "sha256:"+strings.Repeat("0", 64)); err == nil {
		t.Fatal("wrong manifest digest accepted")
	}
	if _, err := os.Lstat(filepath.Join(exportRoot, "backup-2")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("failed export left a target: %v", err)
	}
	if _, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, backupRoot, "backup-2", "legacy", backup.ManifestDigest); err == nil {
		t.Fatal("source reused as export destination")
	}
	aliasParent := t.TempDir()
	if err := os.Mkdir(filepath.Join(backupRoot, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(backupRoot, filepath.Join(aliasParent, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, filepath.Join(aliasParent, "alias", "nested"), "backup-2", "legacy", backup.ManifestDigest); err == nil {
		t.Fatal("source nested alias accepted as destination")
	}
	if err := os.Chmod(exportRoot, 0755); err != nil {
		t.Fatal(err)
	}
	if _, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, exportRoot, "backup-2", "legacy", backup.ManifestDigest); err == nil {
		t.Fatal("public destination accepted")
	}
}
