package instanceauth

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateSenderFilesAreIdempotentAndInstanceScoped(t *testing.T) {
	issuer, _ := New(bytes.Repeat([]byte{42}, 32))
	sender, err := NewSender(t.TempDir(), issuer)
	if err != nil {
		t.Fatal(err)
	}
	id := Identity{Scope: "scope-a", AgentID: "agent-1", Generation: 1}
	record, _ := issuer.Issue(id)
	path, err := sender.Install(id, record, "runtime-controller")
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(path) != "antnest-runtime" {
		t.Fatal("sender filename is not receiver-specific")
	}
	for _, p := range []string{path, filepath.Dir(path)} {
		stat, err := os.Stat(p)
		if err != nil || stat.Mode().Perm()&0077 != 0 {
			t.Fatal("private sender path is accessible to other users")
		}
	}
	if again, err := sender.Install(id, record, "runtime-controller"); err != nil || path != again {
		t.Fatal("restart changed sender path", err)
	}
	if err := os.WriteFile(path, []byte("wrong"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := sender.Install(id, record, "runtime-controller"); err == nil {
		t.Fatal("same binding silently replaced credential bytes")
	}
	if err := sender.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("volatile sender was retained")
	}
}
