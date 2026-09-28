package postgres

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"os"
	"strconv"
	"testing"
	"time"
)

func TestLegacyVerifierKeyHistoryRejectsRevivalAndReuse(t *testing.T) {
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	repository, err := Open(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	prefix := "legacy-verifier-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	key := func() ed25519.PublicKey {
		public, _, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		return public
	}
	firstKey, secondKey, thirdKey, changedKey := key(), key(), key(), key()
	first, second, third := prefix+"-1", prefix+"-2", prefix+"-3"
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{first: firstKey, second: secondKey}); err != nil {
		t.Fatal(err)
	}
	if active, err := repository.LegacyVerifierKeyActive(ctx, first, firstKey); err != nil || !active {
		t.Fatalf("first active=%t %v", active, err)
	}
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{second: secondKey, third: thirdKey}); err != nil {
		t.Fatal(err)
	}
	if active, err := repository.LegacyVerifierKeyActive(ctx, first, firstKey); err != nil || active {
		t.Fatalf("removed key active=%t %v", active, err)
	}
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{first: firstKey}); err == nil {
		t.Fatal("revoked key revived")
	}
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{second: changedKey}); err == nil {
		t.Fatal("key ID reused with different bytes")
	}
	if err := repository.ReconcileLegacyVerifierKeys(ctx, map[string]ed25519.PublicKey{prefix + "-4": secondKey}); err == nil {
		t.Fatal("key bytes reused with different ID")
	}
	if active, err := repository.LegacyVerifierKeyActive(ctx, second, secondKey); err != nil || !active {
		t.Fatalf("failed reconciles changed active key=%t %v", active, err)
	}
}
