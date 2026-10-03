package postgres

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type catalogStateClock struct{ now time.Time }

func (clock *catalogStateClock) Now() time.Time { return clock.now }

type afterProviderReplayMissStore struct {
	ports.CatalogStore
	afterMiss func()
}

func (store *afterProviderReplayMissStore) ReplayProviderRequest(ctx context.Context, kind ports.CatalogRequestKind, requestID, fingerprint string) (ports.ProviderConnectionRecord, bool, error) {
	record, found, err := store.CatalogStore.ReplayProviderRequest(ctx, kind, requestID, fingerprint)
	if err == nil && !found {
		store.afterMiss()
	}
	return record, found, err
}

func TestCredentialRotationReplaysRequestCommittedAfterInitialLookup(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	clock := &catalogStateClock{now: time.Unix(100, 0).UTC()}
	service := fixtureCatalogService(repository, box, clock)
	ctx := context.Background()
	created, err := service.CreateProviderConnection(ctx, providerTestInput("provider", "org"))
	if err != nil {
		t.Fatal(err)
	}
	input := application.RotateProviderCredentialInput{
		RequestID: "concurrent-rotation", OrganizationID: "org", ConnectionID: created.ConnectionID,
		ExpectedVersion: created.CredentialVersion,
		Credential:      application.ProviderCredentialInput{Method: "api_key", APIKey: "new-secret"},
	}
	var committed application.ProviderConnectionView
	store := &afterProviderReplayMissStore{CatalogStore: repository, afterMiss: func() {
		committed, err = service.RotateProviderCredential(ctx, input)
		if err != nil {
			t.Fatal(err)
		}
	}}
	replayed, err := fixtureCatalogService(store, box, clock).RotateProviderCredential(ctx, input)
	if err != nil || !reflect.DeepEqual(committed, replayed) {
		t.Fatalf("committed duplicate did not replay: got=%+v error=%v", replayed, err)
	}
	current, err := service.GetProviderConnection(ctx, "org", created.ConnectionID)
	if err != nil || !reflect.DeepEqual(committed, current) || current.CredentialRevision != 2 {
		t.Fatalf("duplicate rotated credentials again: got=%+v error=%v", current, err)
	}
}

func TestProviderKeepsOnlyCurrentSecretAndOriginalRotationReceipts(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	clock := &catalogStateClock{now: time.Unix(100, 0).UTC()}
	service := fixtureCatalogService(repository, box, clock)
	ctx := context.Background()
	input := providerTestInput("current-state", "org")
	third := input.Models[0]
	third.ProfileKey, third.Model.Model = "third", "third"
	input.Models = append(input.Models, third)
	created, err := service.CreateProviderConnection(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	var total int
	err = repository.pool.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM agent_controller.provider_connections) +
 (SELECT count(*) FROM agent_controller.model_profiles) +
 (SELECT count(*) FROM agent_controller.catalog_requests)`).Scan(&total)
	if err != nil || total != 5 {
		t.Fatalf("initial catalog rows=%d error=%v", total, err)
	}
	clock.now = clock.now.Add(time.Second)
	rotate := application.RotateProviderCredentialInput{
		RequestID: "rotation-one", OrganizationID: "org", ConnectionID: created.ConnectionID,
		ExpectedVersion: created.CredentialVersion,
		Credential:      application.ProviderCredentialInput{Method: "api_key", APIKey: "first-rotated-secret"},
	}
	first, err := service.RotateProviderCredential(ctx, rotate)
	if err != nil {
		t.Fatal(err)
	}
	clock.now = clock.now.Add(time.Second)
	next := rotate
	next.RequestID, next.ExpectedVersion, next.Credential.APIKey = "rotation-two", first.CredentialVersion, "new-secret"
	current, err := service.RotateProviderCredential(ctx, next)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := service.RotateProviderCredential(ctx, rotate)
	if err != nil || !reflect.DeepEqual(first, replayed) {
		t.Fatalf("rotation receipt drift: %v", err)
	}
	replayedCreate, err := service.CreateProviderConnection(ctx, input)
	if err != nil || !reflect.DeepEqual(created, replayedCreate) {
		t.Fatalf("create receipt drift: %v", err)
	}
	assertEncryptedProviderCredential(t, repository, box, current)
	assertProviderCounts(t, repository, 1, 3)
	var payload string
	if err := repository.pool.QueryRow(ctx, `SELECT jsonb_agg(to_jsonb(r))::text FROM agent_controller.catalog_requests r`).Scan(&payload); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"initial-secret", "first-rotated-secret", "new-secret", "ciphertext", "nonce"} {
		if strings.Contains(payload, secret) {
			t.Fatalf("catalog receipt contains secret material: %s", secret)
		}
	}
}

func TestModelCommandsReplaySnapshotsWithoutRollingBackCurrentParameters(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	clock := &catalogStateClock{now: time.Unix(100, 0).UTC()}
	service := fixtureCatalogService(repository, box, clock)
	ctx := context.Background()
	provider, err := service.CreateProviderConnection(ctx, providerTestInput("provider", "org"))
	if err != nil {
		t.Fatal(err)
	}
	parameters := providerTestInput("unused", "org").Models[0].Model
	parameters.Model = "separate"
	input := application.CreateModelProfileInput{RequestID: "model-create", OrganizationID: "org",
		ProviderConnectionID: provider.ConnectionID, ProfileKey: "separate", DisplayName: "Original", Model: parameters}
	created, err := service.CreateModelProfile(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	clock.now = clock.now.Add(time.Second)
	edit := application.ReviseModelProfileInput{RequestID: "model-edit", OrganizationID: "org",
		ExpectedVersion: created.Revision,
		ModelProfileID:  created.ModelProfileID, DisplayName: "Edited", Model: parameters}
	edit.Model.ContextWindow = 4096
	first, err := service.ReviseModelProfile(ctx, edit)
	if err != nil {
		t.Fatal(err)
	}
	clock.now = clock.now.Add(time.Second)
	next := edit
	next.ExpectedVersion = first.Revision
	next.RequestID, next.DisplayName, next.Model.ContextWindow = "model-edit-two", "Current", 16384
	latest, err := service.ReviseModelProfile(ctx, next)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := service.CreateModelProfile(ctx, input)
	if err != nil || !reflect.DeepEqual(created, replayed) {
		t.Fatalf("create response drift: %v", err)
	}
	replayed, err = service.ReviseModelProfile(ctx, edit)
	if err != nil || !reflect.DeepEqual(first, replayed) {
		t.Fatalf("update response drift: %v", err)
	}
	current, err := service.GetModelProfile(ctx, "org", latest.ModelProfileID)
	if err != nil || !reflect.DeepEqual(latest, current) {
		t.Fatalf("replay rolled back current model: %v", err)
	}
	assertProviderCounts(t, repository, 1, 3)
}
