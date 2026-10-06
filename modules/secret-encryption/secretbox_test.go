package secretencryption

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"errors"
	"testing"
)

func TestEnvelopeRotationAndIdentityAuthentication(t *testing.T) {
	ctx := t.Context()
	keys := map[string][]byte{LegacyKeyID: testKey(1), "kid2": testKey(2), "alias": testKey(2)}
	box, err := NewLocal(Config{ActiveKID: "kid2", Keys: keys}, "test-service")
	if err != nil {
		t.Fatal(err)
	}
	identity := []byte("record-1")
	sealed, err := box.Seal(ctx, []byte("private-secret"), identity)
	if err != nil {
		t.Fatal(err)
	}
	if sealed.KeyID != "kid2" || len(sealed.WrappedDataKey) == 0 || bytes.Contains(sealed.Ciphertext, []byte("private-secret")) {
		t.Fatal("incomplete envelope")
	}
	for _, test := range []string{"valid", "unknown kid", "kid alias", "record swap", "purpose swap", "ciphertext", "wrapped key", "nonce", "legacy downgrade"} {
		t.Run(test, func(t *testing.T) {
			changed := sealed
			changed.Ciphertext = bytes.Clone(sealed.Ciphertext)
			changed.WrappedDataKey = bytes.Clone(sealed.WrappedDataKey)
			changed.Nonce = bytes.Clone(sealed.Nonce)
			aad, reader := identity, box
			switch test {
			case "unknown kid":
				changed.KeyID = "missing"
			case "kid alias":
				changed.KeyID = "alias"
			case "record swap":
				aad = []byte("record-2")
			case "purpose swap":
				reader, err = NewLocal(Config{ActiveKID: "kid2", Keys: keys}, "another-service")
				if err != nil {
					t.Fatal(err)
				}
			case "ciphertext":
				changed.Ciphertext[0] ^= 1
			case "wrapped key":
				changed.WrappedDataKey[0] ^= 1
			case "nonce":
				changed.Nonce[0] ^= 1
			case "legacy downgrade":
				changed.KeyID = LegacyKeyID
				changed.WrappedDataKey = nil
			}
			plain, openErr := reader.Open(ctx, changed, aad)
			if test == "valid" {
				if openErr != nil || string(plain) != "private-secret" {
					t.Fatalf("open: %v", openErr)
				}
			} else if openErr == nil {
				t.Fatal("tampering accepted")
			}
		})
	}
	old, err := NewLocal(Config{ActiveKID: LegacyKeyID, Keys: keys}, "test-service")
	if err != nil {
		t.Fatal(err)
	}
	oldEnvelope, err := old.Seal(ctx, []byte("private-secret"), identity)
	if err != nil {
		t.Fatal(err)
	}
	rotated, err := box.Rekey(ctx, oldEnvelope, identity)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(oldEnvelope.Ciphertext, rotated.Ciphertext) || !bytes.Equal(oldEnvelope.Nonce, rotated.Nonce) || bytes.Equal(oldEnvelope.WrappedDataKey, rotated.WrappedDataKey) || rotated.KeyID != "kid2" {
		t.Fatal("rotation must re-wrap, keeping payload")
	}
	onlyNew, err := NewLocal(Config{ActiveKID: "kid2", Keys: map[string][]byte{"kid2": testKey(2)}}, "test-service")
	if err != nil {
		t.Fatal(err)
	}
	if plain, err := onlyNew.Open(ctx, rotated, identity); err != nil || string(plain) != "private-secret" {
		t.Fatalf("retire old key: %v", err)
	}
	if _, err := onlyNew.Open(ctx, oldEnvelope, identity); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("old key not retired: %v", err)
	}
	rotatedAgain, err := onlyNew.Rekey(ctx, rotated, identity)
	if err != nil || !bytes.Equal(rotatedAgain.WrappedDataKey, rotated.WrappedDataKey) {
		t.Fatal("active envelope rekey is not idempotent")
	}
}

func TestHistoricalRecordAndCancellation(t *testing.T) {
	key := testKey(1)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	identity := []byte("historical-identity")
	sealed := SealedSecret{KeyID: LegacyKeyID, Nonce: nonce, Ciphertext: aead.Seal(nil, nonce, []byte("old-secret"), identity)}
	box, err := NewLocal(Config{ActiveKID: "kid2", Keys: map[string][]byte{LegacyKeyID: key, "kid2": testKey(2)}}, "test-service")
	if err != nil {
		t.Fatal(err)
	}
	converted, err := box.Rekey(t.Context(), sealed, identity)
	if err != nil || converted.KeyID != "kid2" || len(converted.WrappedDataKey) == 0 {
		t.Fatalf("convert legacy: %v", err)
	}
	if value, err := box.Open(t.Context(), converted, identity); err != nil || string(value) != "old-secret" {
		t.Fatalf("converted open: %v", err)
	}
	sealed.KeyID = "kid2"
	if _, err := box.Open(t.Context(), sealed, identity); err == nil {
		t.Fatal("unversioned legacy record accepted under new ID")
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := box.Seal(ctx, []byte("secret"), identity); !errors.Is(err, context.Canceled) {
		t.Fatal("seal cancellation lost")
	}
	if _, err := box.Open(ctx, converted, identity); !errors.Is(err, context.Canceled) {
		t.Fatal("open cancellation lost")
	}
	if _, err := box.Rekey(ctx, converted, identity); !errors.Is(err, context.Canceled) {
		t.Fatal("rekey cancellation lost")
	}
}
