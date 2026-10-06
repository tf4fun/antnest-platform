package e2e

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"os"
	"sync"
	"testing"
	"time"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/repository"
)

func rotationFixture(t *testing.T) (*oidcAdmissionFixture, *credentials.SecretBox, *credentials.SecretBox) {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_IDENTITY_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_IDENTITY_TEST_DATABASE_URL is not set")
	}
	f := newOIDCAdmissionFixture(t, databaseURL)
	key := bytes.Repeat([]byte{8}, 32)
	ring, err := credentials.NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"local-v1": bytes.Repeat([]byte{7}, 32), "kid2": key}})
	if err != nil {
		t.Fatal(err)
	}
	retired, err := credentials.NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"kid2": key}})
	if err != nil {
		t.Fatal(err)
	}
	return f, ring, retired
}

func setRotationFlow(t *testing.T, f *oidcAdmissionFixture, box *credentials.SecretBox) {
	t.Helper()
	flow, err := oidcflow.NewService(oidcflow.Config{Repository: f.repository, Federation: f.federation, SecretBox: box, NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: f.time, RedirectURI: "https://identity.test/protocol/oidc/callback", SessionTTL: time.Minute, TokenTTL: time.Hour})
	if err != nil {
		t.Fatal(err)
	}
	f.flow = flow
}

func downgradeFixtureEnvelope(t *testing.T, f *oidcAdmissionFixture, table, id, identity string) {
	t.Helper()
	// Only fixed fixture table names are accepted; all data values stay parameterized.
	prefix := "secret"
	if table == "oidc_providers" {
		prefix = "client_secret"
	} else if table != "oidc_auth_sessions" {
		t.Fatal("unexpected fixture table")
	}
	var sealed credentials.SealedSecret
	err := f.pool.QueryRow(t.Context(), "SELECT "+prefix+"_ciphertext, "+prefix+"_nonce, "+prefix+"_key_id, "+prefix+"_wrapped_data_key FROM "+table+" WHERE id=$1", id).Scan(&sealed.Ciphertext, &sealed.Nonce, &sealed.KeyID, &sealed.WrappedDataKey)
	if err != nil {
		t.Fatal(err)
	}
	key := bytes.Repeat([]byte{7}, 32)
	old, err := credentials.NewSecretBox(key)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := old.Open(sealed, identity)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(plain)
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		t.Fatal(err)
	}
	_, err = f.pool.Exec(t.Context(), "UPDATE "+table+" SET "+prefix+"_ciphertext=$2, "+prefix+"_nonce=$3, "+prefix+"_wrapped_data_key=NULL WHERE id=$1", id, aead.Seal(nil, nonce, plain, []byte(identity)), nonce)
	if err != nil {
		t.Fatal(err)
	}
}

func TestOIDCRekeyResumesAcrossTablesAndKeepsPendingCallbackUsable(t *testing.T) {
	f, ring, retired := rotationFixture(t)
	input := f.start(t)
	var providerID, sessionID string
	if err := f.pool.QueryRow(t.Context(), `SELECT p.id, s.id FROM oidc_providers p JOIN oidc_auth_sessions s ON s.provider_id=p.id`).Scan(&providerID, &sessionID); err != nil {
		t.Fatal(err)
	}
	downgradeFixtureEnvelope(t, f, "oidc_providers", providerID, oidcflow.ProviderSecretIdentity(f.admin.Organization.ID, "workforce"))
	downgradeFixtureEnvelope(t, f, "oidc_auth_sessions", sessionID, sessionID)
	fingerprint := func() string {
		var result string
		if err := f.pool.QueryRow(t.Context(), `SELECT md5((SELECT jsonb_agg(to_jsonb(p) - 'client_secret_ciphertext' - 'client_secret_nonce' - 'client_secret_key_id' - 'client_secret_wrapped_data_key' ORDER BY id)::text FROM oidc_providers p) || (SELECT jsonb_agg(to_jsonb(s) - 'secret_ciphertext' - 'secret_nonce' - 'secret_key_id' - 'secret_wrapped_data_key' ORDER BY id)::text FROM oidc_auth_sessions s))`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := fingerprint()
	ctx, cancel := context.WithCancel(t.Context())
	var committed int64
	err := f.store.RekeyOIDCSecrets(ctx, ring, 1, func(p secretencryption.Progress) error { committed += p.Updated; cancel(); return nil })
	cancel()
	if !errors.Is(err, context.Canceled) || committed != 1 {
		t.Fatalf("interrupt: committed=%d error=%v", committed, err)
	}
	var remainingUpdates int64
	tables := map[string]bool{}
	if err := f.store.RekeyOIDCSecrets(t.Context(), ring, 1, func(p secretencryption.Progress) error {
		remainingUpdates += p.Updated
		if p.Updated == 0 && p.Remaining == 0 {
			tables[p.Table] = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if remainingUpdates != 1 || len(tables) != 2 || before != fingerprint() {
		t.Fatal("resume changed business facts or missed a table")
	}
	if err := f.store.RekeyOIDCSecrets(t.Context(), ring, 100, func(p secretencryption.Progress) error {
		if p.Updated != 0 || p.Remaining != 0 {
			t.Fatal("repeat was not idempotent")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	setRotationFlow(t, f, retired)
	result, err := f.flow.CompleteLogin(t.Context(), input)
	if err != nil || result.AccessToken == "" {
		t.Fatalf("pre-rotation callback could not complete after key retirement: %v", err)
	}
	if replay, err := f.flow.CompleteLogin(t.Context(), input); err != nil || !replay.AlreadyCompleted || replay.TokenID != result.TokenID {
		t.Fatalf("callback replay changed: %v", err)
	}
}

func TestOIDCRekeyUnknownKeyRollsBackBatch(t *testing.T) {
	f, ring, _ := rotationFixture(t)
	old, err := credentials.NewSecretBox(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := old.Seal([]byte("second-fixture-secret"), oidcflow.ProviderSecretIdentity(f.admin.Organization.ID, "second"))
	if err != nil {
		t.Fatal(err)
	}
	// A separate issuer avoids the organization/issuer uniqueness rule. The
	// appended ID makes this bad row follow the valid row in the same batch.
	var id string
	if err := f.pool.QueryRow(t.Context(), `INSERT INTO oidc_providers
		(id, organization_id, name, display_name, issuer, client_id, client_secret_ciphertext,
		 client_secret_nonce, scopes, enabled, revision, authorization_endpoint, token_endpoint,
		 token_endpoint_auth_method, id_token_signing_algs, userinfo_endpoint, jwks_uri,
		 created_at, updated_at, client_secret_key_id, client_secret_wrapped_data_key)
		SELECT id || '-later', organization_id, 'second', display_name, 'https://second.invalid',
		 client_id, $1, $2, scopes, enabled, revision, authorization_endpoint, token_endpoint,
		 token_endpoint_auth_method, id_token_signing_algs, userinfo_endpoint, jwks_uri,
		 created_at, updated_at, $3, $4 FROM oidc_providers WHERE organization_id=$5 RETURNING id`,
		sealed.Ciphertext, sealed.Nonce, sealed.KeyID, sealed.WrappedDataKey, f.admin.Organization.ID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(t.Context(), `UPDATE oidc_providers SET client_secret_key_id='missing' WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	var before, after string
	query := `SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY id)::text) FROM oidc_providers p`
	if err := f.pool.QueryRow(t.Context(), query).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := f.store.RekeyOIDCSecrets(t.Context(), ring, 100, nil); !errors.Is(err, secretencryption.ErrUnknownKey) {
		t.Fatalf("unknown key: %v", err)
	}
	if err := f.pool.QueryRow(t.Context(), query).Scan(&after); err != nil || before != after {
		t.Fatalf("failed batch partly committed: %v", err)
	}
}

type blockedOIDCRekeyer struct {
	credentials.Rekeyer
	entered, release chan struct{}
	once             sync.Once
}

func (box *blockedOIDCRekeyer) Rekey(ctx context.Context, sealed credentials.SealedSecret, identity string) (credentials.SealedSecret, error) {
	box.once.Do(func() { close(box.entered) })
	select {
	case <-ctx.Done():
		return credentials.SealedSecret{}, ctx.Err()
	case <-box.release:
	}
	return box.Rekeyer.Rekey(ctx, sealed, identity)
}

func TestOIDCRekeyKeepsReadersAvailableAndMetadataWriterUsesActiveKey(t *testing.T) {
	f, ring, retired := rotationFixture(t)
	setRotationFlow(t, f, ring)
	blocked := &blockedOIDCRekeyer{Rekeyer: ring, entered: make(chan struct{}), release: make(chan struct{})}
	ctx, cancel := context.WithTimeout(t.Context(), 15*time.Second)
	defer cancel()
	var releaseOnce sync.Once
	result, done := make(chan error, 1), make(chan struct{})
	go func() { defer close(done); result <- f.store.RekeyOIDCSecrets(ctx, blocked, 100, nil) }()
	defer func() { releaseOnce.Do(func() { close(blocked.release) }); cancel(); <-done }()
	select {
	case <-blocked.entered:
	case <-ctx.Done():
		t.Fatal("rekey did not lock a row")
	}
	for range 10 {
		provider, err := f.store.OIDC().FindProvider(ctx, f.admin.Organization.ID, "workforce")
		if err != nil {
			t.Fatal(err)
		}
		if value, err := ring.Open(provider.ClientSecret, oidcflow.ProviderSecretIdentity(provider.OrganizationID, provider.Name)); err != nil || string(value) != "client-secret" {
			t.Fatalf("concurrent reader: %v", err)
		}
	}
	if err := f.store.RekeyOIDCSecrets(ctx, ring, 1, nil); !errors.Is(err, repository.ErrRekeyInProgress) {
		t.Fatalf("overlapping job: %v", err)
	}
	written, writerDone := make(chan error, 1), make(chan struct{})
	go func() {
		defer close(writerDone)
		input := f.providerInput
		input.RequestID, input.ClientSecret, input.Enabled = "metadata", "", false
		_, err := f.flow.UpsertProvider(ctx, input)
		written <- err
	}()
	defer func() { cancel(); <-writerDone }()
	releaseOnce.Do(func() { close(blocked.release) })
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if err := <-written; err != nil {
		t.Fatal(err)
	}
	provider, err := f.store.OIDC().FindProvider(ctx, f.admin.Organization.ID, "workforce")
	if err != nil || provider.ClientSecret.KeyID != "kid2" || provider.Enabled {
		t.Fatalf("metadata update restored an old key: %v", err)
	}
	if value, err := retired.Open(provider.ClientSecret, oidcflow.ProviderSecretIdentity(provider.OrganizationID, provider.Name)); err != nil || string(value) != "client-secret" {
		t.Fatalf("retired-key metadata read: %v", err)
	}
}
