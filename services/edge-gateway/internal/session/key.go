package session

import (
	"crypto/sha256"
	"fmt"
	"io"
	"os"
)

// LoadCSRFKey reads a deployment-owned key without logging its path or bytes.
func LoadCSRFKey(path string) ([]byte, error) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() != sha256.Size {
		return nil, fmt.Errorf("CSRF key must be a readable regular 32-byte file")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("CSRF key is unreadable")
	}
	defer func() { _ = file.Close() }()
	info, err = file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("CSRF key must be a regular file")
	}
	key, err := io.ReadAll(io.LimitReader(file, sha256.Size+1))
	if err != nil || len(key) != sha256.Size {
		return nil, fmt.Errorf("CSRF key must contain exactly 32 raw bytes")
	}
	return key, nil
}
