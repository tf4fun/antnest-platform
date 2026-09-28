package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
)

func main() {
	source := flag.String("source", "", "read-only RC backup volume mount")
	destination := flag.String("destination", "", "private operator destination mount")
	backupRef := flag.String("backup-ref", "", "RC backup reference")
	volumeName := flag.String("volume-name", "", "legacy shared volume name")
	manifestDigest := flag.String("manifest-digest", "", "expected RC manifest SHA-256")
	flag.Parse()
	if flag.NArg() != 0 || *source == "" || *destination == "" || *backupRef == "" || *volumeName == "" || *manifestDigest == "" {
		fmt.Fprintln(os.Stderr, "legacy backup export requires source, destination, backup-ref, volume-name and manifest-digest")
		os.Exit(2)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	receipt, err := platformdocker.ExportLegacySystemSkillsBackup(ctx, *source, *destination, *backupRef, *volumeName, *manifestDigest)
	if err != nil {
		fmt.Fprintln(os.Stderr, "legacy backup copy or verification failed:", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(struct {
		Status          string `json:"status"`
		BackupRef       string `json:"backup_ref"`
		InventoryDigest string `json:"inventory_digest"`
		ArchiveDigest   string `json:"archive_digest"`
		ManifestDigest  string `json:"manifest_digest"`
	}{"copy_verified", receipt.BackupRef, receipt.InventoryDigest, receipt.ArchiveDigest, receipt.ManifestDigest}); err != nil {
		fmt.Fprintln(os.Stderr, "legacy backup result could not be written:", err)
		os.Exit(1)
	}
}
