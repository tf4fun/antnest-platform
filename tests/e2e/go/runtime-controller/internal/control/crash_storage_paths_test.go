//go:build unix

package control_test

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// Crash jobs, effect journals and evidence must survive removal of build caches.
func durableCrashPath(value string) (string, error) {
	if value == "" {
		return "", fmt.Errorf("durable path is required")
	}
	// Abs cleans parent segments before resolving symbolic ancestors. Reject
	// those segments so callers cannot use a different raw TMPDIR after validation.
	for _, part := range strings.Split(value, string(os.PathSeparator)) {
		if part == ".." || part == ".cache" {
			return "", fmt.Errorf("durable path must not contain cache or parent segments")
		}
	}
	path, err := filepath.Abs(value)
	if err != nil {
		return "", err
	}
	allowed := func(path string) bool {
		for _, part := range strings.Split(path, string(os.PathSeparator)) {
			if part == ".cache" {
				return false
			}
		}
		return true
	}
	if !allowed(path) {
		return "", fmt.Errorf("durable files must not use .cache")
	}
	ancestor := path
	for {
		_, err = os.Lstat(ancestor)
		if err == nil {
			break
		}
		if !os.IsNotExist(err) {
			return "", err
		}
		parent := filepath.Dir(ancestor)
		if parent == ancestor {
			return "", err
		}
		ancestor = parent
	}
	resolved, err := filepath.EvalSymlinks(ancestor)
	if err != nil {
		return "", err
	}
	if !allowed(resolved) {
		return "", fmt.Errorf("durable files must not use a cache alias")
	}
	return path, nil
}

func crashDirectory(value string) (string, error) {
	path, err := durableCrashPath(value)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("durable directory required")
	}
	return path, nil
}

func crashEvidenceDirectory() (string, error) {
	value := os.Getenv("ANTNEST_RUNTIME_CRASH_EVIDENCE")
	if value == "" {
		return "", nil
	}
	return crashDirectory(value)
}

func crashEvidencePath(name string) (string, error) {
	directory, err := crashEvidenceDirectory()
	if err != nil || directory == "" {
		return directory, err
	}
	if name == "" || name == "." || name == ".." || filepath.Base(name) != name {
		return "", fmt.Errorf("invalid evidence filename")
	}
	return crashFilePath(filepath.Join(directory, name), false)
}

func crashFilePath(value string, input bool) (string, error) {
	path, err := durableCrashPath(value)
	if err != nil {
		return "", err
	}
	info, err := os.Lstat(path)
	if err != nil {
		if !input && os.IsNotExist(err) {
			return path, nil
		}
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", fmt.Errorf("durable file must be regular, not a link")
	}
	return path, nil
}

func crashTempDir(t *testing.T) string {
	t.Helper()
	if _, err := crashDirectory(os.TempDir()); err != nil {
		t.Fatalf("invalid crash temporary directory: %v", err)
	}
	path, err := crashDirectory(t.TempDir())
	if err != nil {
		t.Fatalf("invalid crash temporary directory: %v", err)
	}
	return path
}

func openCrashOutput(value string, appendMode bool) (*os.File, error) {
	path, err := crashFilePath(value, false)
	if err != nil {
		return nil, err
	}
	flags := os.O_WRONLY | os.O_CREATE | syscall.O_NOFOLLOW | syscall.O_NONBLOCK
	if appendMode {
		flags |= os.O_APPEND
	}
	file, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) { _ = file.Close(); return nil, err }
	info, err := file.Stat()
	if err != nil {
		return fail(err)
	}
	if !info.Mode().IsRegular() {
		return fail(fmt.Errorf("durable output must be regular"))
	}
	if err = file.Chmod(0600); err != nil {
		return fail(err)
	}
	if !appendMode {
		if err = file.Truncate(0); err != nil {
			return fail(err)
		}
	}
	return file, nil
}

func writeCrashFile(path string, data []byte) error {
	file, err := openCrashOutput(path, false)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func readCrashFile(value string) ([]byte, error) {
	path, err := crashFilePath(value, true)
	if err != nil {
		return nil, err
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("durable input must be regular")
	}
	return io.ReadAll(file)
}
