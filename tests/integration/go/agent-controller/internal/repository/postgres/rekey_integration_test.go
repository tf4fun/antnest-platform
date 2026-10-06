package postgres

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"errors"
	"reflect"
	"sync"
	"testing"
	"time"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func providerRotationBoxes(t *testing.T) (*credentials.SecretBox, *credentials.SecretBox, *credentials.SecretBox) {
	t.Helper()
	oldKey, newKey := []byte("0123456789abcdef0123456789abcdef"), []byte("abcdef0123456789abcdef0123456789")
	old, err := credentials.NewSecretBox(oldKey)
	if err != nil {
		t.Fatal(err)
	}
	ring, err := credentials.NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"local-v1": oldKey, "kid2": newKey}})
	if err != nil {
		t.Fatal(err)
	}
	retired, err := credentials.NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"kid2": newKey}})
	if err != nil {
		t.Fatal(err)
	}
	return old, ring, retired
}

func storedProviderIdentity(record ports.ProviderConnectionRecord) ports.CredentialIdentity {
	return ports.CredentialIdentity{OrganizationID: record.OrganizationID, CredentialRef: record.ConnectionID, CredentialVersion: record.CredentialVersion}
}

func createRekeyProvider(t *testing.T, repository *Repository, box *credentials.SecretBox, requestID string) ports.ProviderConnectionRecord {
	t.Helper()
	view, err := fixtureCatalogService(repository, box, providerTestClock{}).CreateProviderConnection(t.Context(), providerTestInput(requestID, "org"))
	if err != nil {
		t.Fatal(err)
	}
	record, err := repository.GetProviderAccess(t.Context(), "org", view.ConnectionID)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestProviderRekeyMixedRecordsResumesWithoutBusinessChanges(t *testing.T) {
	repository := providerTestRepository(t)
	old, ring, retired := providerRotationBoxes(t)
	first := createRekeyProvider(t, repository, old, "first")
	second := createRekeyProvider(t, repository, old, "second")
	active := createRekeyProvider(t, repository, ring, "active")
	// Reproduce a real pre-upgrade record, without calling the new envelope sealer.
	identity := storedProviderIdentity(first)
	var aad []byte
	for _, value := range []string{identity.OrganizationID, identity.CredentialRef, identity.CredentialVersion} {
		aad = binary.BigEndian.AppendUint32(aad, uint32(len(value)))
		aad = append(aad, value...)
	}
	block, err := aes.NewCipher([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := repository.pool.Exec(t.Context(), `UPDATE agent_controller.provider_connections SET ciphertext=$2, nonce=$3, wrapped_data_key=NULL WHERE id=$1`, first.ConnectionID, aead.Seal(nil, nonce, []byte("initial-secret"), aad), nonce); err != nil {
		t.Fatal(err)
	}
	var businessBefore string
	if err := repository.pool.QueryRow(t.Context(), `SELECT jsonb_agg(to_jsonb(p) - 'ciphertext' - 'nonce' - 'key_version' - 'wrapped_data_key' ORDER BY id)::text FROM agent_controller.provider_connections p`).Scan(&businessBefore); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	var committed int64
	err = repository.RekeyProviderCredentials(ctx, ring, 1, func(progress secretencryption.Progress) error { committed += progress.Updated; cancel(); return nil })
	if !errors.Is(err, context.Canceled) || committed != 1 {
		t.Fatalf("interrupted batches: updated=%d error=%v", committed, err)
	}
	cancel()
	var progress []secretencryption.Progress
	if err := repository.RekeyProviderCredentials(t.Context(), ring, 1, func(p secretencryption.Progress) error { progress = append(progress, p); return nil }); err != nil {
		t.Fatal(err)
	}
	var changed int64
	for _, p := range progress {
		changed += p.Updated
	}
	if changed != 1 || len(progress) == 0 || progress[len(progress)-1].Remaining != 0 {
		t.Fatalf("resume progress: %+v", progress)
	}
	var businessAfter string
	if err := repository.pool.QueryRow(t.Context(), `SELECT jsonb_agg(to_jsonb(p) - 'ciphertext' - 'nonce' - 'key_version' - 'wrapped_data_key' ORDER BY id)::text FROM agent_controller.provider_connections p`).Scan(&businessAfter); err != nil || businessBefore != businessAfter {
		t.Fatalf("business records changed: %v", err)
	}
	for _, before := range []ports.ProviderConnectionRecord{first, second, active} {
		after, err := repository.GetProviderAccess(t.Context(), "org", before.ConnectionID)
		if err != nil {
			t.Fatal(err)
		}
		if value, err := retired.Open(t.Context(), storedProviderIdentity(after), after.SealedCredential); err != nil || value != "initial-secret" {
			t.Fatalf("retired-key read: %v", err)
		}
		if before.ConnectionID == second.ConnectionID && (!bytes.Equal(before.SealedCredential.Ciphertext, after.SealedCredential.Ciphertext) || !bytes.Equal(before.SealedCredential.Nonce, after.SealedCredential.Nonce)) {
			t.Fatal("envelope rotation rewrote payload")
		}
		if before.ConnectionID == active.ConnectionID && !reflect.DeepEqual(before.SealedCredential, after.SealedCredential) {
			t.Fatal("active record was rewritten")
		}
	}
	source, err := repository.ReadExecutionSource(t.Context(), "org")
	if err != nil || len(source.Providers) != 3 {
		t.Fatalf("execution source after rekey: %v", err)
	}
	for _, provider := range source.Providers {
		if value, err := retired.Open(t.Context(), storedProviderIdentity(provider), provider.SealedCredential); err != nil || value != "initial-secret" {
			t.Fatalf("execution publication lost the envelope: %v", err)
		}
	}
	if err := repository.RekeyProviderCredentials(t.Context(), ring, 100, func(p secretencryption.Progress) error {
		if p.Updated != 0 || p.Remaining != 0 {
			t.Fatal("repeat was not idempotent")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestProviderRekeyAuthenticationFailureRollsBackBatch(t *testing.T) {
	repository := providerTestRepository(t)
	old, ring, _ := providerRotationBoxes(t)
	first := createRekeyProvider(t, repository, old, "first")
	second := createRekeyProvider(t, repository, old, "second")
	if first.ConnectionID > second.ConnectionID {
		first, second = second, first
	}
	if _, err := repository.pool.Exec(t.Context(), `UPDATE agent_controller.provider_connections SET key_version='missing' WHERE id=$1`, second.ConnectionID); err != nil {
		t.Fatal(err)
	}
	if err := repository.RekeyProviderCredentials(t.Context(), ring, 100, nil); !errors.Is(err, secretencryption.ErrUnknownKey) {
		t.Fatalf("unknown key result: %v", err)
	}
	after, err := repository.GetProviderAccess(t.Context(), "org", first.ConnectionID)
	if err != nil || !reflect.DeepEqual(after.SealedCredential, first.SealedCredential) {
		t.Fatalf("failed batch partly committed: %v", err)
	}
	corrupt := bytes.Clone(second.SealedCredential.WrappedDataKey)
	corrupt[len(corrupt)-1] ^= 1
	if _, err := repository.pool.Exec(t.Context(), `UPDATE agent_controller.provider_connections SET key_version=$2, wrapped_data_key=$3 WHERE id=$1`, second.ConnectionID, second.SealedCredential.KeyVersion, corrupt); err != nil {
		t.Fatal(err)
	}
	if err := repository.RekeyProviderCredentials(t.Context(), ring, 100, nil); !errors.Is(err, secretencryption.ErrAuthentication) {
		t.Fatalf("tampered key result: %v", err)
	}
	after, err = repository.GetProviderAccess(t.Context(), "org", first.ConnectionID)
	if err != nil || !reflect.DeepEqual(after.SealedCredential, first.SealedCredential) {
		t.Fatalf("tampered batch partly committed: %v", err)
	}
	if err := repository.RekeyProviderCredentials(t.Context(), ring, 0, nil); !errors.Is(err, secretencryption.ErrBatchSize) {
		t.Fatalf("invalid batch: %v", err)
	}
}

type blockedProviderRekeyer struct {
	ports.CredentialRekeyer
	entered, release chan struct{}
	once             sync.Once
}

func (box *blockedProviderRekeyer) Rekey(ctx context.Context, identity ports.CredentialIdentity, sealed ports.SealedSecret) (ports.SealedSecret, error) {
	box.once.Do(func() { close(box.entered) })
	select {
	case <-ctx.Done():
		return ports.SealedSecret{}, ctx.Err()
	case <-box.release:
	}
	return box.CredentialRekeyer.Rekey(ctx, identity, sealed)
}

func TestProviderRekeyKeepsReadersAvailableAndSerializesCredentialWriter(t *testing.T) {
	repository := providerTestRepository(t)
	old, ring, retired := providerRotationBoxes(t)
	before := createRekeyProvider(t, repository, old, "concurrent")
	blocked := &blockedProviderRekeyer{CredentialRekeyer: ring, entered: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	var releaseOnce sync.Once
	results, done := make(chan error, 1), make(chan struct{})
	go func() { defer close(done); results <- repository.RekeyProviderCredentials(ctx, blocked, 100, nil) }()
	defer func() { releaseOnce.Do(func() { close(blocked.release) }); cancel(); <-done }()
	select {
	case <-blocked.entered:
	case <-ctx.Done():
		t.Fatal("rekey did not acquire row")
	}
	for range 10 {
		record, err := repository.GetProviderAccess(ctx, "org", before.ConnectionID)
		if err != nil {
			t.Fatal(err)
		}
		if value, err := ring.Open(ctx, storedProviderIdentity(record), record.SealedCredential); err != nil || value != "initial-secret" {
			t.Fatalf("concurrent read failed: %v", err)
		}
	}
	if err := repository.RekeyProviderCredentials(ctx, ring, 1, nil); !errors.Is(err, ErrRekeyInProgress) {
		t.Fatalf("overlapping rekey accepted: %v", err)
	}
	written, writerDone := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(writerDone)
		_, err := fixtureCatalogService(repository, ring, providerTestClock{}).RotateProviderCredential(ctx, application.RotateProviderCredentialInput{RequestID: "concurrent-write", OrganizationID: "org", ConnectionID: before.ConnectionID, ExpectedVersion: before.CredentialVersion, Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "replacement-secret"}})
		written <- err
	}()
	defer func() {
		cancel()
		select {
		case <-writerDone:
		case <-time.After(2 * time.Second):
			t.Error("credential writer did not stop")
		}
	}()
	releaseOnce.Do(func() { close(blocked.release) })
	if err := <-results; err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	after, err := repository.GetProviderAccess(ctx, "org", before.ConnectionID)
	if err != nil {
		t.Fatal(err)
	}
	if after.CredentialVersion == before.CredentialVersion {
		t.Fatal("rekey overwrote concurrent replacement")
	}
	if value, err := retired.Open(ctx, storedProviderIdentity(after), after.SealedCredential); err != nil || value != "replacement-secret" {
		t.Fatalf("replacement read: %v", err)
	}
}
