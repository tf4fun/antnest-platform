package secretencryption

import (
	"bytes"
	"context"
	"errors"
	"testing"
)

func TestEnvelopeMACIsPrivateBoundAndSurvivesMasterKeyRotation(t *testing.T) {
	ctx, identity, value := t.Context(), []byte("record-1"), []byte("low-entropy-secret")
	keys := map[string][]byte{"old": testKey(1), "new": testKey(2)}
	old, _ := NewLocal(Config{ActiveKID: "old", Keys: keys}, "test-service")
	sealed, err := old.Seal(ctx, value, identity)
	if err != nil {
		t.Fatal(err)
	}
	mac, err := old.Authenticate(ctx, sealed, identity, "public-fingerprint", value)
	if err != nil || len(mac) != 32 {
		t.Fatal("MAC unavailable", err)
	}
	for _, test := range []struct {
		purpose string
		value   []byte
	}{
		{"request-fingerprint", value}, {"public-fingerprint", []byte("another guess")},
	} {
		other, err := old.Authenticate(ctx, sealed, identity, test.purpose, test.value)
		if err != nil || bytes.Equal(mac, other) {
			t.Fatal("MAC domain/value not bound", err)
		}
	}
	another, _ := old.Seal(ctx, value, identity)
	other, err := old.Authenticate(ctx, another, identity, "public-fingerprint", value)
	if err != nil || bytes.Equal(mac, other) {
		t.Fatal("different envelopes share a guess verifier", err)
	}
	rotator, _ := NewLocal(Config{ActiveKID: "new", Keys: keys}, "test-service")
	rotated, err := rotator.Rekey(ctx, sealed, identity)
	if err != nil {
		t.Fatal(err)
	}
	retired, _ := NewLocal(Config{ActiveKID: "new", Keys: map[string][]byte{"new": testKey(2)}}, "test-service")
	after, err := retired.Authenticate(ctx, rotated, identity, "public-fingerprint", value)
	if err != nil || !bytes.Equal(mac, after) {
		t.Fatal("master-key retirement broke MAC", err)
	}
	if _, err := old.Authenticate(ctx, sealed, []byte("record-2"), "public-fingerprint", value); err == nil {
		t.Fatal("identity substitution accepted")
	}
	if _, err := old.Authenticate(ctx, sealed, identity, "", value); err == nil {
		t.Fatal("empty purpose accepted")
	}
	sealed.Ciphertext = bytes.Clone(sealed.Ciphertext)
	sealed.Ciphertext[0] ^= 1
	if _, err := old.Authenticate(ctx, sealed, identity, "public-fingerprint", value); !errors.Is(err, ErrAuthentication) {
		t.Fatal("unauthenticated ciphertext used for MAC", err)
	}
	canceled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := retired.Authenticate(canceled, rotated, identity, "public-fingerprint", value); !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation lost", err)
	}
}
