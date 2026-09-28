package docker

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// ExportLegacySystemSkillsBackup makes an independently verified directory copy.
// The caller must separately prove the destination is protected off-host storage.
func ExportLegacySystemSkillsBackup(ctx context.Context, backupRoot, destinationRoot, backupRef, volumeName, manifestDigest string) (LegacyBackupReceipt, error) {
	if err := ctx.Err(); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if !legacyBackupIDPattern.MatchString(backupRef) || !legacyBackupDigestPattern.MatchString(manifestDigest) || volumeName == "" {
		return LegacyBackupReceipt{}, fmt.Errorf("invalid legacy export identity")
	}
	sourceAbs, err := filepath.Abs(backupRoot)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	targetAbs, err := filepath.Abs(destinationRoot)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	if legacyExportPathsOverlap(sourceAbs, targetAbs) {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy export source and destination overlap")
	}
	if err := privateBackupRoot(destinationRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if resolvedSource, err := filepath.EvalSymlinks(backupRoot); err == nil {
		resolvedTarget, err := filepath.EvalSymlinks(destinationRoot)
		if err != nil {
			return LegacyBackupReceipt{}, err
		}
		if legacyExportPathsOverlap(resolvedSource, resolvedTarget) {
			return LegacyBackupReceipt{}, fmt.Errorf("legacy export source and destination overlap")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return LegacyBackupReceipt{}, err
	}
	lockPath := filepath.Join(destinationRoot, ".legacy-export.lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	defer func() { _ = lock.Close() }()
	info, err := lock.Stat()
	linked, linkErr := os.Lstat(lockPath)
	if err != nil || linkErr != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || !os.SameFile(info, linked) {
		return LegacyBackupReceipt{}, fmt.Errorf("legacy export lock is unprotected")
	}
	if err := lockLegacyExport(ctx, lock); err != nil {
		return LegacyBackupReceipt{}, fmt.Errorf("lock legacy export destination: %w", err)
	}
	defer func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN) }()

	final := filepath.Join(destinationRoot, backupRef)
	if _, err := os.Lstat(final); err == nil {
		receipt, err := verifiedLegacyBackup(ctx, final, backupRef, volumeName, "")
		if err != nil {
			return LegacyBackupReceipt{}, err
		}
		if receipt.ManifestDigest != manifestDigest {
			return LegacyBackupReceipt{}, ErrLegacyBackupConflict
		}
		return receipt, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return LegacyBackupReceipt{}, err
	}
	if err := privateBackupRoot(backupRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	source := filepath.Join(backupRoot, backupRef)
	receipt, err := verifiedLegacyBackup(ctx, source, backupRef, volumeName, "")
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	if receipt.ManifestDigest != manifestDigest {
		return LegacyBackupReceipt{}, ErrLegacyBackupConflict
	}

	stage, err := os.MkdirTemp(destinationRoot, ".legacy-export-staging-")
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	defer func() { _ = os.RemoveAll(stage) }()
	if err := os.Chmod(stage, 0700); err != nil {
		return LegacyBackupReceipt{}, err
	}
	for _, item := range []struct {
		name  string
		limit int64
	}{
		{"archive.tar", maxLegacyInventoryBytes + maxLegacyInventoryEntries*8192},
		{"manifest.json", 64 << 20},
		{"receipt.sha256", 128},
	} {
		if err := copyLegacyExportFile(ctx, source, stage, item.name, item.limit); err != nil {
			return LegacyBackupReceipt{}, err
		}
	}
	copied, err := verifiedLegacyBackup(ctx, stage, backupRef, volumeName, receipt.InventoryDigest)
	if err != nil {
		return LegacyBackupReceipt{}, err
	}
	if copied.ManifestDigest != receipt.ManifestDigest || copied.ArchiveDigest != receipt.ArchiveDigest {
		return LegacyBackupReceipt{}, ErrLegacyBackupConflict
	}
	if err := syncLegacyBackupDirectory(stage); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if err := os.Rename(stage, final); err != nil {
		return LegacyBackupReceipt{}, err
	}
	if err := syncLegacyBackupDirectory(destinationRoot); err != nil {
		return LegacyBackupReceipt{}, err
	}
	return copied, nil
}

func lockLegacyExport(ctx context.Context, file *os.File) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			return nil
		}
		if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			return err
		}
		timer := time.NewTimer(50 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func legacyExportPathsOverlap(source, target string) bool {
	for _, pair := range [][2]string{{source, target}, {target, source}} {
		relative, err := filepath.Rel(pair[0], pair[1])
		if err == nil && (relative == "." || relative != ".." && !strings.HasPrefix(relative, ".."+string(os.PathSeparator))) {
			return true
		}
	}
	return false
}

func copyLegacyExportFile(ctx context.Context, sourceDirectory, destinationDirectory, name string, limit int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	root, err := os.OpenRoot(sourceDirectory)
	if err != nil {
		return err
	}
	defer func() { _ = root.Close() }()
	before, err := root.Lstat(name)
	if err != nil || !before.Mode().IsRegular() || before.Mode().Perm()&0077 != 0 || before.Size() > limit {
		return fmt.Errorf("legacy export source file %q is unprotected or oversized", name)
	}
	source, err := root.Open(name)
	if err != nil {
		return err
	}
	defer func() { _ = source.Close() }()
	opened, err := source.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return fmt.Errorf("legacy export source file %q changed", name)
	}
	target, err := os.OpenFile(filepath.Join(destinationDirectory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	copied, copyErr := io.CopyN(target, &legacyContextReader{ctx: ctx, source: source}, before.Size())
	var extra [1]byte
	extraCount, extraErr := source.Read(extra[:])
	if errors.Is(extraErr, io.EOF) {
		extraErr = nil
	}
	closeErr := errors.Join(target.Sync(), target.Close())
	if err := errors.Join(copyErr, extraErr, closeErr); err != nil || copied != before.Size() || extraCount != 0 {
		return fmt.Errorf("legacy export source file %q changed or failed to copy: %w", name, err)
	}
	return nil
}
