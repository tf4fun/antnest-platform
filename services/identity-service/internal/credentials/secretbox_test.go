package credentials

import (
	"bytes"
	"testing"
)

func TestSecretBoxBindsCiphertextToRecordIdentity(t *testing.T) {
	t.Parallel()

	key := bytes.Repeat([]byte{7}, 32)
	box, err := NewSecretBox(key)
	if err != nil {
		t.Fatalf("new secret box: %v", err)
	}
	sealed, err := box.Seal([]byte("provider-secret"), "provider-1")
	if err != nil {
		t.Fatalf("seal: %v", err)
	}
	if bytes.Contains(sealed.Ciphertext, []byte("provider-secret")) {
		t.Fatal("ciphertext contains plaintext")
	}
	opened, err := box.Open(sealed, "provider-1")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if string(opened) != "provider-secret" {
		t.Fatalf("opened = %q", opened)
	}
	if _, err := box.Open(sealed, "provider-2"); err == nil {
		t.Fatal("ciphertext opened under another record identity")
	}
}

func TestSecretBoxRequiresAES256Key(t *testing.T) {
	t.Parallel()

	if _, err := NewSecretBox(make([]byte, 31)); err == nil {
		t.Fatal("31-byte key was accepted")
	}
}
