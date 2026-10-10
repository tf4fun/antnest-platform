package session

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadCSRFKeyRequiresExactlyOneRawRegularKey(t *testing.T) {
	directory := t.TempDir()
	for _, size := range []int{0, 31, 32, 33, 64} {
		path := filepath.Join(directory, "csrf.key")
		payload := bytes.Repeat([]byte{0x8b}, size)
		if err := os.WriteFile(path, payload, 0600); err != nil {
			t.Fatal(err)
		}
		key, err := LoadCSRFKey(path)
		if size == 32 {
			if err != nil || !bytes.Equal(key, payload) {
				t.Fatalf("valid raw key rejected: %v", err)
			}
		} else if err == nil {
			t.Errorf("accepted %d bytes", size)
		}
	}
	for _, path := range []string{"", filepath.Join(directory, "missing-secret"), directory} {
		if _, err := LoadCSRFKey(path); err == nil || (path != "" && strings.Contains(err.Error(), path)) {
			t.Errorf("unsafe key error handling for invalid input: %v", err)
		}
	}
}
