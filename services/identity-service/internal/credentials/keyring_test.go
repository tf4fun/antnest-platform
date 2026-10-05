package credentials

import (
	"crypto/aes"
	"crypto/cipher"
	"testing"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
)

func TestIdentityKeyringPreservesLegacyRecordAAD(t *testing.T) {
	oldKey, newKey := []byte("0123456789abcdef0123456789abcdef"), []byte("abcdef0123456789abcdef0123456789")
	box, err := NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"local-v1": oldKey, "kid2": newKey}})
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(oldKey)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	id := "oidc-provider\x00org\x00workforce"
	legacy := SealedSecret{KeyID: "local-v1", Nonce: nonce, Ciphertext: aead.Seal(nil, nonce, []byte("client-secret"), []byte(id))}
	rotated, err := box.Rekey(t.Context(), legacy, id)
	if err != nil || rotated.KeyID != "kid2" || len(rotated.WrappedDataKey) == 0 {
		t.Fatalf("historical conversion: %v", err)
	}
	retired, err := NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"kid2": newKey}})
	if err != nil {
		t.Fatal(err)
	}
	if value, err := retired.Open(rotated, id); err != nil || string(value) != "client-secret" {
		t.Fatalf("retired key read: %v", err)
	}
	if _, err := retired.Open(rotated, "oidc-provider\x00other\x00workforce"); err == nil {
		t.Fatal("organization binding lost")
	}
}
