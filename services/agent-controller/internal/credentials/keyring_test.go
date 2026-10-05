package credentials

import (
	"crypto/aes"
	"crypto/cipher"
	"testing"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestKeyringReadsHistoricalProviderIdentityAndRetiresKey(t *testing.T) {
	key := []byte("0123456789abcdef0123456789abcdef")
	keys := map[string][]byte{LocalKeyVersion: key, "kid2": []byte("abcdef0123456789abcdef0123456789")}
	identity := ports.CredentialIdentity{OrganizationID: "org", CredentialRef: "ref", CredentialVersion: "version"}
	aad, err := credentialAAD(identity)
	if err != nil {
		t.Fatal(err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	legacy := ports.SealedSecret{KeyVersion: LocalKeyVersion, Nonce: nonce, Ciphertext: aead.Seal(nil, nonce, []byte("provider-secret"), aad)}
	box, err := NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: keys})
	if err != nil {
		t.Fatal(err)
	}
	converted, err := box.Rekey(t.Context(), identity, legacy)
	if err != nil || converted.KeyVersion != "kid2" || len(converted.WrappedDataKey) == 0 {
		t.Fatalf("legacy conversion: %v", err)
	}
	onlyNew, err := NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"kid2": keys["kid2"]}})
	if err != nil {
		t.Fatal(err)
	}
	if value, err := onlyNew.Open(t.Context(), identity, converted); err != nil || value != "provider-secret" {
		t.Fatalf("new-only read: %v", err)
	}
	if _, err := onlyNew.Open(t.Context(), identity, legacy); err == nil {
		t.Fatal("retired legacy key remained usable")
	}
	identity.CredentialVersion = "another-version"
	if _, err := box.Open(t.Context(), identity, converted); err == nil {
		t.Fatal("Provider credential-version binding lost")
	}
}
