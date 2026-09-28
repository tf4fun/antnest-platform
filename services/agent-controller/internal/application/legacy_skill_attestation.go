package application

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

var ErrLegacyAttestationInvalid = errors.New("legacy Skill export attestation invalid")

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

// VerifyLegacyExportAttestation checks a caller-supplied proof against an
// operator-pinned key, the latest persisted choice and a freshly read RC receipt.
// It does not change the Agent migration gate.
func VerifyLegacyExportAttestation(proof LegacyExportAttestation, trustedKeys map[string]ed25519.PublicKey, choice ports.LegacySkillChoice, receipt ports.LegacySkillBackupReceipt, now time.Time) error {
	if proof.Version != 1 || !legacyBackupRefPattern.MatchString(proof.KeyID) || !legacyBackupRefPattern.MatchString(proof.VerifierID) ||
		!legacyBackupRefPattern.MatchString(proof.BackupRef) || !validLegacyAttestationVolume(proof.VolumeName) ||
		!validLegacyAttestationStorage(proof.StorageRef) || !skillDigestPattern.MatchString(proof.InventoryDigest) ||
		!skillDigestPattern.MatchString(proof.ArchiveDigest) || !skillDigestPattern.MatchString(proof.ManifestDigest) {
		return ErrLegacyAttestationInvalid
	}
	key := trustedKeys[proof.KeyID]
	if len(key) != ed25519.PublicKeySize {
		return ErrLegacyAttestationInvalid
	}
	verifiedAt, err := time.Parse(time.RFC3339Nano, proof.VerifiedAt)
	if err != nil || verifiedAt.Format(time.RFC3339Nano) != proof.VerifiedAt {
		return ErrLegacyAttestationInvalid
	}
	expiresAt, err := time.Parse(time.RFC3339Nano, proof.ExpiresAt)
	if err != nil || expiresAt.Format(time.RFC3339Nano) != proof.ExpiresAt || !expiresAt.After(now) || !expiresAt.After(verifiedAt) ||
		expiresAt.After(verifiedAt.Add(24*time.Hour)) || verifiedAt.After(now.Add(time.Minute)) {
		return ErrLegacyAttestationInvalid
	}
	signature, err := base64.StdEncoding.DecodeString(proof.Signature)
	if err != nil || len(signature) != ed25519.SignatureSize || base64.StdEncoding.EncodeToString(signature) != proof.Signature ||
		!ed25519.Verify(key, legacyExportAttestationMessage(proof), signature) {
		return ErrLegacyAttestationInvalid
	}
	if choice.BackupRef != proof.BackupRef || choice.VolumeName != proof.VolumeName || choice.InventoryDigest != proof.InventoryDigest || choice.BackupDigest != proof.ManifestDigest ||
		receipt.BackupRef != proof.BackupRef || receipt.VolumeName != proof.VolumeName || receipt.InventoryDigest != proof.InventoryDigest ||
		receipt.ArchiveDigest != proof.ArchiveDigest || receipt.ManifestDigest != proof.ManifestDigest {
		return ErrLegacyAttestationInvalid
	}
	return nil
}

func legacyExportAttestationMessage(proof LegacyExportAttestation) []byte {
	return []byte(strings.Join([]string{
		"antnest/legacy-skill-export/v1", proof.KeyID, proof.VerifierID, proof.StorageRef,
		proof.BackupRef, proof.VolumeName, proof.InventoryDigest, proof.ArchiveDigest,
		proof.ManifestDigest, proof.VerifiedAt, proof.ExpiresAt, "",
	}, "\n"))
}

func validLegacyAttestationVolume(value string) bool {
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

func validLegacyAttestationStorage(value string) bool {
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
