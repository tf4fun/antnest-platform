package instanceauth

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
)

func TestSealedCredentialsAreInstanceBoundAndRestartStable(t *testing.T) {
	key := bytes.Repeat([]byte{41}, 32)
	issuer, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	id := Identity{Scope: "scope-a", AgentID: "agent_a", Generation: 3}
	record, err := issuer.Issue(id)
	if err != nil {
		t.Fatal(err)
	}
	other, err := issuer.Issue(id)
	if err != nil {
		t.Fatal(err)
	}
	if record.ConnectionID == other.ConnectionID {
		t.Fatal("fresh generations must not reuse connection identity")
	}
	restarted, err := New(key)
	if err != nil {
		t.Fatal(err)
	}
	rc, err := issuer.Open(id, record, "runtime-controller")
	if err != nil {
		t.Fatal(err)
	}
	acp, err := issuer.Open(id, record, "agent-acp-service")
	if err != nil {
		t.Fatal(err)
	}
	if rc == acp || len(rc) != 43 || len(acp) != 43 {
		t.Fatal("callers require distinct canonical 32-byte credentials")
	}
	for _, caller := range []string{"runtime-controller", "agent-acp-service"} {
		before, _ := issuer.Open(id, record, caller)
		after, err := restarted.Open(id, record, caller)
		if err != nil || before != after {
			t.Fatal("restart replaced or lost accepted credential")
		}
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(encoded, []byte(rc)) || bytes.Contains(encoded, []byte(acp)) {
		t.Fatal("record contains a raw credential")
	}
	for _, wrong := range []Identity{{Scope: "scope-b", AgentID: id.AgentID, Generation: id.Generation}, {Scope: id.Scope, AgentID: "agent_b", Generation: id.Generation}, {Scope: id.Scope, AgentID: id.AgentID, Generation: 4}} {
		if _, err := restarted.Open(wrong, record, "agent-acp-service"); err == nil {
			t.Fatal("cross-instance credential opened")
		}
	}
	if _, err := issuer.Open(id, record, "admin-console"); err == nil {
		t.Fatal("unexpected caller opened")
	}
	altered := *record
	altered.ConnectionID = other.ConnectionID
	if _, err := issuer.Open(id, &altered, "agent-acp-service"); err == nil {
		t.Fatal("connection identity was not authenticated")
	}
	profile, err := issuer.Receiver(id, record)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(profile, []byte(rc)) || bytes.Contains(profile, []byte(acp)) || !bytes.Contains(profile, []byte("sha256:")) {
		t.Fatal("receiver bootstrap must contain hashes only")
	}
	if _, err := serviceauth.ParseReceiver("antnest-runtime", profile, false); err != nil {
		t.Fatal(err)
	}
}

func TestCredentialKeyFileIsPrivateRegularAndExact(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "key")
	if err := os.WriteFile(path, bytes.Repeat([]byte{19}, 32), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKey(path); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKey(path); err == nil {
		t.Fatal("public key file accepted")
	}
	if err := os.Chmod(path, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKey(link); err == nil {
		t.Fatal("symlink key accepted")
	}
	if err := os.WriteFile(path, bytes.Repeat([]byte{19}, 33), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadKey(path); err == nil {
		t.Fatal("oversized key accepted")
	}
	if _, err := New(bytes.Repeat([]byte{1}, 31)); err == nil {
		t.Fatal("short master key accepted")
	}
}

func TestRecordDecodeRejectsMalformedOrAmbiguousData(t *testing.T) {
	issuer, _ := New(bytes.Repeat([]byte{42}, 32))
	id := Identity{Scope: "scope-a", AgentID: "agent_a", Generation: 1}
	record, _ := issuer.Issue(id)
	encoded, _ := json.Marshal(record)
	decoded, err := Decode(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := issuer.Open(id, decoded, "runtime-controller"); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`{}`, string(encoded) + `{}`, strings.Replace(string(encoded), `"connection_id":`, `"unexpected":0,"connection_id":`, 1), strings.Replace(string(encoded), `"connection_id":`, `"connection_id":"rci_00000000000000000000000000000000","connection_id":`, 1)} {
		if _, err := Decode([]byte(raw)); err == nil {
			t.Fatal("invalid accepted record decoded")
		}
	}
}

func TestPrivateKeyRejectsFIFOWithoutBlocking(t *testing.T) {
	if path := os.Getenv("ANTNEST_RC_FIFO_TEST_PATH"); path != "" {
		if _, err := LoadKey(path); err == nil {
			t.Fatal("FIFO key accepted")
		}
		if _, err := ReadSenderFile(path); err == nil {
			t.Fatal("FIFO sender accepted")
		}
		return
	}
	path := filepath.Join(t.TempDir(), "fifo")
	if err := syscall.Mkfifo(path, 0600); err != nil {
		t.Fatal(err)
	}
	// Race-instrumented test executables include a one-second exit delay.
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestPrivateKeyRejectsFIFOWithoutBlocking$")
	command.Env = append(os.Environ(), "ANTNEST_RC_FIFO_TEST_PATH="+path)
	if err := command.Run(); err != nil {
		t.Fatal("private non-regular file blocked or survived rejection", err)
	}
}
