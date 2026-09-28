package docker

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"strings"
	"time"
)

type LegacyExportAttestation struct {
	Version         int    `json:"version"`
	KeyID           string `json:"key_id"`
	VerifierID      string `json:"verifier_id"`
	StorageRef      string `json:"storage_ref"`
	BackupRef       string `json:"backup_ref"`
	VolumeName      string `json:"volume_name"`
	InventoryDigest string `json:"inventory_digest"`
	ArchiveDigest   string `json:"archive_digest"`
	ManifestDigest  string `json:"manifest_digest"`
	VerifiedAt      string `json:"verified_at"`
	ExpiresAt       string `json:"expires_at"`
	Signature       string `json:"signature"`
}

func AttestLegacySystemSkillsExport(ctx context.Context, destinationRoot, backupRef, volumeName, manifestDigest, storageRef, verifierID, keyID string, privateKey ed25519.PrivateKey, now time.Time) (LegacyExportAttestation, error) {
	if err := ctx.Err(); err != nil {
		return LegacyExportAttestation{}, err
	}
	if !legacyBackupIDPattern.MatchString(backupRef) || !legacyBackupIDPattern.MatchString(verifierID) || !legacyBackupIDPattern.MatchString(keyID) ||
		!legacyBackupDigestPattern.MatchString(manifestDigest) || len(privateKey) != ed25519.PrivateKeySize || now.IsZero() || !validLegacyExportVolumeName(volumeName) || !validLegacyExportStorageRef(storageRef) {
		return LegacyExportAttestation{}, fmt.Errorf("invalid legacy export attestation identity")
	}
	if err := privateBackupRoot(destinationRoot); err != nil {
		return LegacyExportAttestation{}, err
	}
	receipt, err := verifiedLegacyBackup(ctx, filepath.Join(destinationRoot, backupRef), backupRef, volumeName, "")
	if err != nil {
		return LegacyExportAttestation{}, err
	}
	if receipt.ManifestDigest != manifestDigest {
		return LegacyExportAttestation{}, ErrLegacyBackupConflict
	}
	verifiedAt := now.UTC()
	proof := LegacyExportAttestation{
		Version: 1, KeyID: keyID, VerifierID: verifierID, StorageRef: storageRef,
		BackupRef: backupRef, VolumeName: volumeName, InventoryDigest: receipt.InventoryDigest,
		ArchiveDigest: receipt.ArchiveDigest, ManifestDigest: receipt.ManifestDigest,
		VerifiedAt: verifiedAt.Format(time.RFC3339Nano),
		ExpiresAt:  verifiedAt.Add(24 * time.Hour).Format(time.RFC3339Nano),
	}
	proof.Signature = base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, legacyExportAttestationMessage(proof)))
	return proof, nil
}

func legacyExportAttestationMessage(proof LegacyExportAttestation) []byte {
	return []byte(strings.Join([]string{
		"antnest/legacy-skill-export/v1", proof.KeyID, proof.VerifierID,
		proof.StorageRef, proof.BackupRef, proof.VolumeName, proof.InventoryDigest,
		proof.ArchiveDigest, proof.ManifestDigest, proof.VerifiedAt, proof.ExpiresAt, "",
	}, "\n"))
}

func validLegacyExportVolumeName(value string) bool {
	if value == "" || len(value) > 255 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e || value[i] == '/' || value[i] == '\\' {
			return false
		}
	}
	return true
}

func validLegacyExportStorageRef(value string) bool {
	if value == "" || len(value) > 1024 {
		return false
	}
	for i := 0; i < len(value); i++ {
		if value[i] < 0x21 || value[i] > 0x7e {
			return false
		}
	}
	reference, err := url.Parse(value)
	if err != nil || reference.User != nil || reference.RawQuery != "" || reference.Fragment != "" || reference.Opaque != "" || reference.Hostname() == "" || reference.Path == "" || reference.Path == "/" {
		return false
	}
	switch reference.Scheme {
	case "s3", "gs", "az", "ssh", "nfs":
	default:
		return false
	}
	host := strings.ToLower(reference.Hostname())
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return false
	}
	if address := net.ParseIP(host); address != nil && (address.IsLoopback() || address.IsUnspecified()) {
		return false
	}
	return true
}
