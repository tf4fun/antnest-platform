package application

import (
	"crypto/ed25519"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestVerifyLegacyExportAttestationBindsTrustedKeyChoiceAndReceipt(t *testing.T) {
	now := time.Date(2026, 9, 28, 8, 0, 0, 0, time.UTC)
	seed := make([]byte, ed25519.SeedSize)
	key := ed25519.NewKeyFromSeed(seed)
	trusted := map[string]ed25519.PublicKey{"current": key.Public().(ed25519.PublicKey)}
	digest := func(char string) string { return "sha256:" + strings.Repeat(char, 64) }
	choice := ports.LegacySkillChoice{BackupRef: "backup-1", VolumeName: "legacy", InventoryDigest: digest("a"), BackupDigest: digest("b")}
	receipt := ports.LegacySkillBackupReceipt{BackupRef: "backup-1", VolumeName: "legacy", InventoryDigest: digest("a"), ArchiveDigest: digest("c"), ManifestDigest: digest("b")}
	proof := LegacyExportAttestation{Version: 1, KeyID: "current", VerifierID: "verifier-1", StorageRef: "s3://backups.example/legacy/backup-1", BackupRef: "backup-1", VolumeName: "legacy", InventoryDigest: digest("a"), ArchiveDigest: digest("c"), ManifestDigest: digest("b"), VerifiedAt: now.Add(-time.Minute).Format(time.RFC3339Nano), ExpiresAt: now.Add(time.Hour).Format(time.RFC3339Nano)}
	sign := func() {
		proof.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(key, legacyExportAttestationMessage(proof)))
	}
	sign()
	if err := VerifyLegacyExportAttestation(proof, trusted, choice, receipt, now); err != nil {
		t.Fatalf("valid proof rejected: %v", err)
	}
	checks := []struct {
		name   string
		change func()
	}{
		{"untrusted key", func() { proof.KeyID = "unknown" }},
		{"changed storage", func() { proof.StorageRef = "s3://other.example/legacy/backup-1" }},
		{"wrong choice", func() { choice.BackupRef = "other" }},
		{"wrong receipt", func() { receipt.ArchiveDigest = digest("d") }},
		{"expired", func() { proof.ExpiresAt = now.Add(-time.Second).Format(time.RFC3339Nano); sign() }},
		{"future", func() { proof.VerifiedAt = now.Add(2 * time.Minute).Format(time.RFC3339Nano); sign() }},
		{"too long", func() { proof.ExpiresAt = now.Add(25 * time.Hour).Format(time.RFC3339Nano); sign() }},
		{"local storage", func() { proof.StorageRef = "ssh://localhost/legacy"; sign() }},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			p, c, r := proof, choice, receipt
			check.change()
			if err := VerifyLegacyExportAttestation(proof, trusted, choice, receipt, now); err == nil {
				t.Fatal("invalid proof accepted")
			}
			proof, choice, receipt = p, c, r
		})
	}
}
