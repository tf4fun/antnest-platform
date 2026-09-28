package docker

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLegacyExportAttestationSignsOnlyRevalidatedDestination(t *testing.T) {
	sourceTree := t.TempDir()
	backupRoot := t.TempDir()
	destination := t.TempDir()
	for _, root := range []string{backupRoot, destination} {
		if err := os.Chmod(root, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(sourceTree, "note.txt"), []byte("legacy evidence"), 0444); err != nil {
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
	if _, err := ExportLegacySystemSkillsBackup(context.Background(), backupRoot, destination, "backup-1", "legacy", backup.ManifestDigest); err != nil {
		t.Fatal(err)
	}
	privateKey := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{7}, ed25519.SeedSize))
	verifiedAt := time.Date(2026, 9, 28, 1, 2, 3, 0, time.UTC)
	proof, err := AttestLegacySystemSkillsExport(context.Background(), destination, "backup-1", "legacy", backup.ManifestDigest,
		"s3://protected-backups/legacy/backup-1", "verifier-a", "key-1", privateKey, verifiedAt)
	if err != nil {
		t.Fatal(err)
	}
	if proof.Version != 1 || proof.BackupRef != backup.BackupRef || proof.InventoryDigest != backup.InventoryDigest || proof.ArchiveDigest != backup.ArchiveDigest || proof.ManifestDigest != backup.ManifestDigest ||
		proof.ExpiresAt != "2026-09-29T01:02:03Z" {
		t.Fatalf("wrong attestation identity: %+v", proof)
	}
	message := strings.Join([]string{"antnest/legacy-skill-export/v1", "key-1", "verifier-a", "s3://protected-backups/legacy/backup-1", "backup-1", "legacy", backup.InventoryDigest, backup.ArchiveDigest, backup.ManifestDigest, "2026-09-28T01:02:03Z", "2026-09-29T01:02:03Z", ""}, "\n")
	signature, err := base64.StdEncoding.DecodeString(proof.Signature)
	if err != nil || !ed25519.Verify(privateKey.Public().(ed25519.PublicKey), []byte(message), signature) {
		t.Fatalf("signature does not cover contract message: %v", err)
	}
	if _, err := AttestLegacySystemSkillsExport(context.Background(), destination, "backup-1", "legacy", backup.ManifestDigest,
		"file:///tmp/local-copy", "verifier-a", "key-1", privateKey, verifiedAt); err == nil {
		t.Fatal("local storage URI accepted")
	}
	if _, err := AttestLegacySystemSkillsExport(context.Background(), destination, "backup-1", "legacy", backup.ManifestDigest,
		"s3://protected-backups/legacy/backup-1", "verifier-a\nforged", "key-1", privateKey, verifiedAt); err == nil {
		t.Fatal("newline identity accepted")
	}
	if _, err := AttestLegacySystemSkillsExport(context.Background(), destination, "backup-1", "legacy", "sha256:"+strings.Repeat("0", 64),
		"s3://protected-backups/legacy/backup-1", "verifier-a", "key-1", privateKey, verifiedAt); err == nil {
		t.Fatal("wrong RC digest accepted")
	}
	if err := os.WriteFile(filepath.Join(destination, "backup-1", "archive.tar"), []byte("tampered"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := AttestLegacySystemSkillsExport(context.Background(), destination, "backup-1", "legacy", backup.ManifestDigest,
		"s3://protected-backups/legacy/backup-1", "verifier-a", "key-1", privateKey, verifiedAt); err == nil {
		t.Fatal("tampered target signed")
	}
}
