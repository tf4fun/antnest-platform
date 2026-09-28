package main

import (
	"context"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	platformdocker "soft/antnest-platform/services/runtime-controller/internal/platform/docker"
)

func main() {
	destination := flag.String("destination", "", "read-only protected export mount")
	backupRef := flag.String("backup-ref", "", "RC backup reference")
	volumeName := flag.String("volume-name", "", "legacy shared volume name")
	manifestDigest := flag.String("manifest-digest", "", "expected RC manifest SHA-256")
	storageRef := flag.String("storage-ref", "", "credential-free external storage reference")
	verifierID := flag.String("verifier-id", "", "independent verifier identity")
	keyID := flag.String("key-id", "", "trusted Ed25519 key identity")
	keyFile := flag.String("key-file", "", "private PKCS8 PEM file")
	flag.Parse()
	if flag.NArg() != 0 || *destination == "" || *backupRef == "" || *volumeName == "" || *manifestDigest == "" || *storageRef == "" || *verifierID == "" || *keyID == "" || *keyFile == "" {
		fmt.Fprintln(os.Stderr, "legacy backup attestation requires destination, backup-ref, volume-name, manifest-digest, storage-ref, verifier-id, key-id and key-file")
		os.Exit(2)
	}
	key, err := readVerifierKey(*keyFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, "legacy backup verifier key is invalid:", err)
		os.Exit(1)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	proof, err := platformdocker.AttestLegacySystemSkillsExport(ctx, *destination, *backupRef, *volumeName, *manifestDigest, *storageRef, *verifierID, *keyID, key, time.Now())
	if err != nil {
		fmt.Fprintln(os.Stderr, "legacy backup export verification failed:", err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(proof); err != nil {
		fmt.Fprintln(os.Stderr, "legacy backup attestation could not be written:", err)
		os.Exit(1)
	}
}

func readVerifierKey(path string) (ed25519.PrivateKey, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() < 1 || info.Size() > 8192 {
		return nil, fmt.Errorf("key must be a 0600 regular file of at most 8192 bytes")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, fmt.Errorf("key file changed while opening")
	}
	contents, err := io.ReadAll(io.LimitReader(file, 8193))
	if err != nil || len(contents) > 8192 {
		return nil, fmt.Errorf("key file could not be read within size limit")
	}
	block, trailing := pem.Decode(contents)
	if block == nil || block.Type != "PRIVATE KEY" || len(block.Headers) != 0 || strings.TrimSpace(string(trailing)) != "" {
		return nil, fmt.Errorf("key must contain exactly one PKCS8 private-key PEM block")
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("key is not valid PKCS8")
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(key) != ed25519.PrivateKeySize {
		return nil, fmt.Errorf("key is not Ed25519")
	}
	return key, nil
}
