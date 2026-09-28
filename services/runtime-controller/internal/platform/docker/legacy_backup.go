package docker

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

var legacyBackupIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var legacyBackupDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
var ErrLegacyBackupConflict = errors.New("legacy backup request conflicts with stored receipt")
var ErrLegacyBackupNotFound = errors.New("legacy backup receipt not found")

type LegacyBackupReceipt struct {
	BackupRef       string                 `json:"backup_ref"`
	VolumeName      string                 `json:"volume_name"`
	InventoryDigest string                 `json:"inventory_digest"`
	Entries         []LegacyInventoryEntry `json:"entries"`
	ArchiveDigest   string                 `json:"archive_digest"`
	CreatedAt       time.Time              `json:"created_at"`
	ManifestDigest  string                 `json:"manifest_digest,omitempty"`
}

type LegacyBackupWriter struct {
	engine     LegacyInventoryEngine
	sourceRoot string
	backupRoot string
	volumeName string
	scope      string
	mu         sync.Mutex
}

func NewLegacyBackupWriter(engine LegacyInventoryEngine, sourceRoot, backupRoot, volumeName, scope string) (*LegacyBackupWriter, error) {
	if engine == nil || sourceRoot == "" || volumeName == "" || scope == "" {
		return nil, fmt.Errorf("legacy backup configuration is incomplete")
	}
	if err := privateBackupRoot(backupRoot); err != nil {
		return nil, err
	}
	return &LegacyBackupWriter{engine: engine, sourceRoot: sourceRoot, backupRoot: backupRoot, volumeName: volumeName, scope: scope}, nil
}

func (writer *LegacyBackupWriter) Backup(ctx context.Context, requestID, expectedDigest string) (LegacyBackupReceipt, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if ctx.Err() != nil {
		return LegacyBackupReceipt{}, ctx.Err()
	}
	if !legacyBackupIDPattern.MatchString(requestID) || !legacyBackupDigestPattern.MatchString(expectedDigest) {
		return LegacyBackupReceipt{}, fmt.Errorf("invalid legacy backup identity")
	}
	if err := privateBackupRoot(writer.backupRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if _, err := os.Lstat(filepath.Join(writer.backupRoot, requestID)); err == nil {
		return verifiedLegacyBackup(ctx, filepath.Join(writer.backupRoot, requestID), requestID, writer.volumeName, expectedDigest)
	} else if !errors.Is(err, os.ErrNotExist) {
		return LegacyBackupReceipt{}, err
	}
	volume, err := writer.engine.InspectVolume(ctx, writer.volumeName)
	if err != nil || volume.Name != writer.volumeName {
		return LegacyBackupReceipt{}, fmt.Errorf("inspect legacy system Skill volume: %v", err)
	}
	containers, err := writer.engine.ListAllContainers(ctx)
	if err != nil {
		return LegacyBackupReceipt{}, fmt.Errorf("list legacy system Skill volume consumers: %w", err)
	}
	return CreateLegacySystemSkillsBackup(ctx, writer.sourceRoot, writer.backupRoot, writer.volumeName, writer.scope, expectedDigest, requestID, containers)
}

// Receipt verifies persisted evidence without consulting the old shared volume.
func (writer *LegacyBackupWriter) Receipt(ctx context.Context, backupRef string) (LegacyBackupReceipt, error) {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if !legacyBackupIDPattern.MatchString(backupRef) {
		return LegacyBackupReceipt{}, fmt.Errorf("invalid legacy backup identity")
	}
	if err := privateBackupRoot(writer.backupRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	path := filepath.Join(writer.backupRoot, backupRef)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return LegacyBackupReceipt{}, ErrLegacyBackupNotFound
	} else if err != nil {
		return LegacyBackupReceipt{}, err
	}
	return verifiedLegacyBackup(ctx, path, backupRef, writer.volumeName, "")
}

// CreateLegacySystemSkillsBackup builds a private, immutable local snapshot.
// An operator must separately export it to protected storage before any Agent
// migration gate can be cleared.
func CreateLegacySystemSkillsBackup(ctx context.Context, sourceRoot, backupRoot, volumeName, scope, expectedDigest, backupID string, containers []Container) (LegacyBackupReceipt, error) {
	if err := ctx.Err(); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if !legacyBackupIDPattern.MatchString(backupID) || !legacyBackupDigestPattern.MatchString(expectedDigest) || volumeName == "" || scope == "" {
		return LegacyBackupReceipt{}, fmt.Errorf("invalid legacy backup identity")
	}
	if err := privateBackupRoot(backupRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	final := filepath.Join(backupRoot, backupID)
	if _, err := os.Lstat(final); err == nil {
		return verifiedLegacyBackup(ctx, final, backupID, volumeName, expectedDigest)
	} else if !errors.Is(err, os.ErrNotExist) {
		return LegacyBackupReceipt{}, err
	}
	inventory, err := InventoryLegacySystemSkills(ctx, sourceRoot, volumeName, scope, containers)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	if inventory.InventoryDigest != expectedDigest {
		return LegacyBackupReceipt{}, ErrLegacyInventoryChanged
	}
	for _, entry := range inventory.Entries {
		if entry.Kind == "unsupported" {
			return LegacyBackupReceipt{}, fmt.Errorf("legacy backup cannot preserve unsupported entry %q", entry.Path)
		}
	}
	stage, err := os.MkdirTemp(backupRoot, ".legacy-staging-")
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	defer func() { _ = os.RemoveAll(stage) }()
	if err := os.Chmod(stage, 0700); err != nil {
		return LegacyBackupReceipt{}, err
	}
	archivePath := filepath.Join(stage, "archive.tar")
	archive, err := os.OpenFile(archivePath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	archiveHash := sha256.New()
	writer := tar.NewWriter(io.MultiWriter(archive, archiveHash))
	writeErr := writeLegacyBackupArchive(ctx, writer, sourceRoot, inventory.Entries)
	closeErr := errors.Join(writer.Close(), archive.Sync(), archive.Close())
	if err := errors.Join(writeErr, closeErr); err != nil {
		return LegacyBackupReceipt{}, err
	}
	second, err := InventoryLegacySystemSkills(ctx, sourceRoot, volumeName, scope, containers)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	if second.InventoryDigest != inventory.InventoryDigest {
		return LegacyBackupReceipt{}, ErrLegacyInventoryChanged
	}
	receipt := LegacyBackupReceipt{BackupRef: backupID, VolumeName: volumeName, InventoryDigest: expectedDigest,
		Entries: inventory.Entries, ArchiveDigest: "sha256:" + hex.EncodeToString(archiveHash.Sum(nil)), CreatedAt: time.Now().UTC()}
	manifest, err := json.Marshal(receipt)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	manifestHash := sha256.Sum256(manifest)
	receipt.ManifestDigest = "sha256:" + hex.EncodeToString(manifestHash[:])
	if err := writePrivateBackupFile(filepath.Join(stage, "manifest.json"), manifest); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if err := writePrivateBackupFile(filepath.Join(stage, "receipt.sha256"), []byte(receipt.ManifestDigest+"\n")); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if _, err := verifiedLegacyBackup(ctx, stage, backupID, volumeName, expectedDigest); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if err := syncLegacyBackupDirectory(stage); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if err := os.Rename(stage, final); err != nil {
		if _, statErr := os.Lstat(final); statErr == nil {
			return verifiedLegacyBackup(ctx, final, backupID, volumeName, expectedDigest)
		}
		return LegacyBackupReceipt{}, err
	}
	if err := syncLegacyBackupDirectory(backupRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	return receipt, nil
}

func writePrivateBackupFile(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	if written, err := file.Write(data); err != nil || written != len(data) {
		_ = file.Close()
		return fmt.Errorf("write legacy backup file: %w", errors.Join(err, io.ErrShortWrite))
	}
	return errors.Join(file.Sync(), file.Close())
}

func syncLegacyBackupDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}

func privateBackupRoot(root string) error {
	info, err := os.Lstat(root)
	if err != nil {
		return fmt.Errorf("inspect legacy backup root: %w", err)
	}
	if !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return fmt.Errorf("legacy backup root must be a private directory")
	}
	return nil
}

func writeLegacyBackupArchive(ctx context.Context, writer *tar.Writer, root string, entries []LegacyInventoryEntry) error {
	rootHandle, err := os.OpenRoot(root)
	if err != nil {
		return err
	}
	defer func() { _ = rootHandle.Close() }()
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		name := filepath.FromSlash(entry.Path)
		info, err := rootHandle.Lstat(name)
		if err != nil || uint32(info.Mode().Perm()) != entry.Mode {
			return ErrLegacyInventoryChanged
		}
		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return err
		}
		header.Name = entry.Path
		switch entry.Kind {
		case "directory":
			if !info.IsDir() {
				return ErrLegacyInventoryChanged
			}
		case "symlink":
			if info.Mode()&os.ModeSymlink == 0 {
				return ErrLegacyInventoryChanged
			}
			target, err := rootHandle.Readlink(name)
			if err != nil {
				return err
			}
			hash := sha256.Sum256([]byte(target))
			if entry.Digest != "sha256:"+hex.EncodeToString(hash[:]) {
				return ErrLegacyInventoryChanged
			}
			header.Linkname = target
		case "regular":
			if !info.Mode().IsRegular() || info.Size() != entry.Size {
				return ErrLegacyInventoryChanged
			}
		default:
			return fmt.Errorf("unsupported legacy backup entry %q", entry.Path)
		}
		if err := writer.WriteHeader(header); err != nil {
			return err
		}
		if entry.Kind == "regular" {
			file, err := rootHandle.Open(name)
			if err != nil {
				return err
			}
			opened, err := file.Stat()
			if err != nil || !os.SameFile(info, opened) {
				_ = file.Close()
				return ErrLegacyInventoryChanged
			}
			hash := sha256.New()
			copied, copyErr := io.CopyN(writer, io.TeeReader(&legacyContextReader{ctx: ctx, source: file}, hash), entry.Size)
			closeErr := file.Close()
			if err := errors.Join(copyErr, closeErr); err != nil || copied != entry.Size || entry.Digest != "sha256:"+hex.EncodeToString(hash.Sum(nil)) {
				return ErrLegacyInventoryChanged
			}
		}
	}
	return nil
}

func verifiedLegacyBackup(ctx context.Context, directory, backupID, volumeName, expectedDigest string) (LegacyBackupReceipt, error) {
	info, err := os.Lstat(directory)
	if err != nil || !info.IsDir() || info.Mode().Perm()&0077 != 0 {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy backup directory is absent or unprotected")
	}
	for _, name := range []string{"archive.tar", "manifest.json", "receipt.sha256"} {
		fileInfo, err := os.Lstat(filepath.Join(directory, name))
		if err != nil || !fileInfo.Mode().IsRegular() || fileInfo.Mode().Perm()&0077 != 0 {
			return LegacyBackupReceipt{}, fmt.Errorf("legacy backup file %q is absent or unprotected", name)
		}
		if name == "manifest.json" && fileInfo.Size() > 64<<20 || name == "receipt.sha256" && fileInfo.Size() > 128 || name == "archive.tar" && fileInfo.Size() > (maxLegacyInventoryBytes+maxLegacyInventoryEntries*8192) {
			return LegacyBackupReceipt{}, fmt.Errorf("legacy backup file %q exceeds its bound", name)
		}
	}
	manifest, err := os.ReadFile(filepath.Join(directory, "manifest.json"))
	if err != nil || len(manifest) > 64<<20 {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy backup manifest is absent or oversized")
	}
	hash := sha256.Sum256(manifest)
	digest := "sha256:" + hex.EncodeToString(hash[:])
	recorded, err := os.ReadFile(filepath.Join(directory, "receipt.sha256"))
	if err != nil || strings.TrimSpace(string(recorded)) != digest {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy backup manifest receipt differs")
	}
	var receipt LegacyBackupReceipt
	if err := json.Unmarshal(manifest, &receipt); err != nil || receipt.ManifestDigest != "" || !legacyBackupDigestPattern.MatchString(receipt.ArchiveDigest) {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy backup manifest identity differs")
	}
	if receipt.BackupRef != backupID || receipt.VolumeName != volumeName || !legacyBackupDigestPattern.MatchString(receipt.InventoryDigest) ||
		expectedDigest != "" && receipt.InventoryDigest != expectedDigest {
		return LegacyBackupReceipt{}, ErrLegacyBackupConflict
	}
	archivePath := filepath.Join(directory, "archive.tar")
	archive, err := os.Open(archivePath)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	defer func() { _ = archive.Close() }()
	archiveHash := sha256.New()
	if _, err := io.Copy(archiveHash, &legacyContextReader{ctx: ctx, source: archive}); err != nil || receipt.ArchiveDigest != "sha256:"+hex.EncodeToString(archiveHash.Sum(nil)) {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy backup archive digest differs")
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return LegacyBackupReceipt{}, err
	}
	reader := tar.NewReader(&legacyContextReader{ctx: ctx, source: archive})
	for _, entry := range receipt.Entries {
		header, err := reader.Next()
		if err != nil || header.Name != entry.Path || uint32(header.Mode&0777) != entry.Mode {
			return LegacyBackupReceipt{}, fmt.Errorf("legacy backup archive entry differs")
		}
		switch entry.Kind {
		case "directory":
			if header.Typeflag != tar.TypeDir {
				return LegacyBackupReceipt{}, fmt.Errorf("legacy backup directory differs")
			}
		case "symlink":
			hash := sha256.Sum256([]byte(header.Linkname))
			if header.Typeflag != tar.TypeSymlink || entry.Digest != "sha256:"+hex.EncodeToString(hash[:]) {
				return LegacyBackupReceipt{}, fmt.Errorf("legacy backup link differs")
			}
		case "regular":
			fileHash := sha256.New()
			read, err := io.Copy(fileHash, reader)
			if err != nil || header.Typeflag != tar.TypeReg && header.Typeflag != oldTarRegularType || read != entry.Size || entry.Digest != "sha256:"+hex.EncodeToString(fileHash.Sum(nil)) {
				return LegacyBackupReceipt{}, fmt.Errorf("legacy backup file differs")
			}
		default:
			return LegacyBackupReceipt{}, fmt.Errorf("unsupported legacy backup entry")
		}
	}
	if _, err := reader.Next(); !errors.Is(err, io.EOF) {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy backup archive has extra entries")
	}
	receipt.ManifestDigest = digest
	return receipt, nil
}
