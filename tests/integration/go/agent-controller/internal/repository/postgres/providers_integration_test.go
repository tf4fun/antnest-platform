package postgres

import (
	"context"
	"errors"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestProviderModelAndCredentialLifecyclesAreIndependent(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	service := fixtureCatalogService(repository, box, providerTestClock{})
	ctx := context.Background()
	input := providerTestInput("create", "org")
	connection, err := service.CreateProviderConnection(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := service.CreateProviderConnection(ctx, input)
	if err != nil || !reflect.DeepEqual(connection, replay) {
		t.Fatalf("create replay drifted: %v", err)
	}
	models, _, err := repository.ListModelProfiles(ctx, "org", "", 10)
	if err != nil || len(models) != 2 {
		t.Fatalf("initial models: count=%d error=%v", len(models), err)
	}
	assertProviderCounts(t, repository, 1, 2)
	selected := models[0]
	parameters := selected.Revision.Snapshot().Model.Parameters()
	parameters.ContextWindow, parameters.SupportsImages = 4096, false
	updated, err := service.ReviseModelProfile(ctx, application.ReviseModelProfileInput{
		ExpectedVersion: selected.Revision.Revision(),
		RequestID:       "model-edit", OrganizationID: "org", ModelProfileID: selected.ModelProfileID,
		DisplayName: "Updated", Model: parameters,
	})
	if err != nil || updated.ProviderConnectionID != connection.ConnectionID {
		t.Fatalf("model edit changed credential: %+v %v", updated, err)
	}
	assertProviderCounts(t, repository, 1, 2)
	rotate := application.RotateProviderCredentialInput{
		RequestID: "rotate", OrganizationID: "org", ConnectionID: connection.ConnectionID,
		ExpectedVersion: connection.CredentialVersion, Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "new-secret"},
	}
	rotated, err := service.RotateProviderCredential(ctx, rotate)
	if err != nil || rotated.CredentialVersion == connection.CredentialVersion {
		t.Fatalf("rotation: %v", err)
	}
	assertProviderCounts(t, repository, 1, 2)
	assertEncryptedProviderCredential(t, repository, box, rotated)
	replayedCreate, err := service.CreateProviderConnection(ctx, input)
	if err != nil || !reflect.DeepEqual(replayedCreate, connection) {
		t.Fatalf("create replay after rotation changed original credential version: %v", err)
	}
	current, err := service.GetModelProfile(ctx, "org", selected.ModelProfileID)
	if err != nil || !reflect.DeepEqual(current, updated) {
		t.Fatalf("rotation changed current model parameters: %+v %v", current, err)
	}
	input.Credential.APIKey = "conflicting-create"
	if _, err := service.CreateProviderConnection(ctx, input); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("conflicting request accepted: %v", err)
	}
	assertProviderModelIsolation(t, service, connection, selected)
}

func TestProviderDiscoveryDecryptsCurrentCredentialInternally(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	lister := &storedCredentialLister{}
	service := fixtureCatalogService(repository, box, providerTestClock{}, application.WithProviderCredentialReader(repository, box), application.WithProviderDiscovery(fixtureProviderValidator{}, lister))
	connection, err := service.CreateProviderConnection(t.Context(), providerTestInput("access-create", "org"))
	if err != nil {
		t.Fatal(err)
	}
	access, err := service.DiscoverProviderModels(t.Context(), "org", connection.ConnectionID)
	if err != nil || len(access.Models) != 1 || len(lister.secrets) != 1 || lister.secrets[0] != "initial-secret" {
		t.Fatalf("read stored access: %v", err)
	}
	rotated, err := service.RotateProviderCredential(t.Context(), application.RotateProviderCredentialInput{
		RequestID: "access-rotate", OrganizationID: "org", ConnectionID: connection.ConnectionID,
		ExpectedVersion: connection.CredentialVersion, Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "rotated-secret"},
	})
	if err != nil {
		t.Fatal(err)
	}
	access, err = service.DiscoverProviderModels(t.Context(), "org", connection.ConnectionID)
	if err != nil || len(access.Models) != 1 || len(lister.secrets) != 2 || lister.secrets[1] != "rotated-secret" || rotated.CredentialVersion == connection.CredentialVersion {
		t.Fatalf("read rotated access: %v", err)
	}
	public, err := repository.GetProviderConnection(t.Context(), "org", connection.ConnectionID)
	if err != nil || len(public.SealedCredential.Ciphertext) > 0 {
		t.Fatal("metadata read loaded a credential")
	}
	assertProviderCounts(t, repository, 1, 2)
}

func assertProviderModelIsolation(t *testing.T, service *application.CatalogService, connection application.ProviderConnectionView, model ports.ModelProfileRecord) {
	t.Helper()
	ctx := context.Background()
	input := application.CreateModelProfileInput{
		RequestID: "duplicate", OrganizationID: "org", ProviderConnectionID: connection.ConnectionID,
		ProfileKey: "different-key", DisplayName: "Duplicate", Model: model.Revision.Snapshot().Model.Parameters(),
	}
	if _, err := service.CreateModelProfile(ctx, input); !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("duplicate API model identity accepted: %v", err)
	}
	input.RequestID, input.OrganizationID = "cross-org", "other-org"
	if _, err := service.CreateModelProfile(ctx, input); !errors.Is(err, ports.ErrNotFound) {
		t.Fatalf("cross-organization connection accepted: %v", err)
	}
	second, err := service.CreateProviderConnection(ctx, providerTestInput("second", "org"))
	if err != nil || second.ConnectionID == connection.ConnectionID {
		t.Fatalf("same model IDs on another connection rejected: %v", err)
	}
}

func assertEncryptedProviderCredential(t *testing.T, repository *Repository, box *credentials.SecretBox, view application.ProviderConnectionView) {
	t.Helper()
	var sealed ports.SealedSecret
	err := repository.pool.QueryRow(context.Background(), `SELECT ciphertext, nonce, key_version, wrapped_data_key
FROM agent_controller.provider_connections WHERE id=$1 AND current_credential_version=$2`, view.ConnectionID, view.CredentialVersion).
		Scan(&sealed.Ciphertext, &sealed.Nonce, &sealed.KeyVersion, &sealed.WrappedDataKey)
	if err != nil || len(sealed.WrappedDataKey) == 0 || strings.Contains(string(sealed.Ciphertext), "new-secret") {
		t.Fatalf("credential was not encrypted: %v", err)
	}
	secret, err := box.Open(context.Background(), ports.CredentialIdentity{
		OrganizationID: view.OrganizationID, CredentialRef: view.ConnectionID, CredentialVersion: view.CredentialVersion,
	}, sealed)
	if err != nil || secret != "new-secret" {
		t.Fatalf("rotated credential could not be resolved: %v", err)
	}
}

func TestProviderTransactionRollsBackInitialModelsAndCredential(t *testing.T) {
	repository := providerTestRepository(t)
	model := integrationModelRecord(t)
	connection := ports.ProviderConnectionRecord{
		RequestID: "rollback", RequestFingerprint: strings.Repeat("a", 64),
		ConnectionID: model.ProviderConnectionID, OrganizationID: model.OrganizationID,
		ProviderKey: "deepseek", DisplayName: "Provider", BaseURL: model.Revision.Snapshot().Model.BaseURL,
		CredentialMethod: "api_key", CredentialVersion: "credver_integration", CredentialRevision: 1,
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("sealed"), Nonce: []byte("nonce")},
		Enabled:          true, CreatedAt: model.CreatedAt, UpdatedAt: model.UpdatedAt,
	}
	_, err := repository.PutProviderConnection(context.Background(), connection, []ports.ModelProfileRecord{model, model})
	if !errors.Is(err, ports.ErrRequestConflict) {
		t.Fatalf("expected duplicate model rollback: %v", err)
	}
	assertProviderCounts(t, repository, 0, 0)
	var receipts int
	if err := repository.pool.QueryRow(context.Background(), `SELECT count(*) FROM agent_controller.catalog_requests`).Scan(&receipts); err != nil || receipts != 0 {
		t.Fatalf("failed transaction kept a replay receipt: count=%d error=%v", receipts, err)
	}
}

func TestConcurrentProviderRequestsConverge(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	service := fixtureCatalogService(repository, box, providerTestClock{})
	ctx := context.Background()
	input := providerTestInput("concurrent", "org")
	const clients = 4
	results := make(chan error, clients)
	var workers sync.WaitGroup
	for range clients {
		workers.Go(func() {
			_, err := service.CreateProviderConnection(ctx, input)
			results <- err
		})
	}
	workers.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent create replay: %v", err)
		}
	}
	assertProviderCounts(t, repository, 1, 2)
	connections, err := service.ListProviderConnections(ctx, application.ListCatalogInput{OrganizationID: "org"})
	if err != nil || len(connections.Items) != 1 {
		t.Fatalf("connections after replay: %v", err)
	}
	connection := connections.Items[0]
	rotate := application.RotateProviderCredentialInput{RequestID: "rotate", OrganizationID: "org", ConnectionID: connection.ConnectionID,
		ExpectedVersion: connection.CredentialVersion, Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "next"}}
	if _, err := service.RotateProviderCredential(ctx, rotate); err != nil {
		t.Fatal(err)
	}
	rotate.RequestID = "stale"
	if _, err := service.RotateProviderCredential(ctx, rotate); !errors.Is(err, ports.ErrConcurrentChange) {
		t.Fatalf("stale rotation accepted: %v", err)
	}
	assertProviderCounts(t, repository, 1, 2)
	assertConcurrentProviderRotation(t, service, connection.ConnectionID)
	assertProviderCounts(t, repository, 1, 2)
}

func assertConcurrentProviderRotation(t *testing.T, service *application.CatalogService, connectionID string) {
	t.Helper()
	connection, err := service.GetProviderConnection(context.Background(), "org", connectionID)
	if err != nil {
		t.Fatal(err)
	}
	results := make(chan error, 2)
	var workers sync.WaitGroup
	for _, requestID := range []string{"rotate-a", "rotate-b"} {
		workers.Go(func() {
			_, err := service.RotateProviderCredential(context.Background(), application.RotateProviderCredentialInput{
				RequestID: requestID, OrganizationID: "org", ConnectionID: connectionID,
				ExpectedVersion: connection.CredentialVersion, Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: requestID},
			})
			results <- err
		})
	}
	workers.Wait()
	close(results)
	successes, conflicts := 0, 0
	for err := range results {
		switch {
		case err == nil:
			successes++
		case errors.Is(err, ports.ErrConcurrentChange):
			conflicts++
		default:
			t.Fatalf("concurrent rotation failed: %v", err)
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent rotation overwrote another update: success=%d conflict=%d", successes, conflicts)
	}
}

func assertProviderCounts(t *testing.T, repository *Repository, connections, models int) {
	t.Helper()
	for table, want := range map[string]int{
		"provider_connections": connections, "model_profiles": models,
		"agents": 0, "agent_templates": 0,
	} {
		var count int
		if err := repository.pool.QueryRow(context.Background(), "SELECT count(*) FROM agent_controller."+table).Scan(&count); err != nil || count != want {
			t.Fatalf("%s count=%d want=%d error=%v", table, count, want, err)
		}
	}
	var mixed bool
	if err := repository.pool.QueryRow(context.Background(), `SELECT EXISTS (
SELECT 1 FROM agent_controller.model_profiles WHERE model ? 'base_url' OR model ? 'credential'
)`).Scan(&mixed); err != nil || mixed {
		t.Fatalf("model parameters contain connection configuration: %v", err)
	}
}

func providerTestRepository(t *testing.T) *Repository {
	t.Helper()
	databaseURL := os.Getenv("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("ANTNEST_AGENT_CONTROLLER_TEST_DATABASE_URL is not set")
	}
	repository, err := Open(context.Background(), databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(repository.Close)
	resetCatalogSchema(t, context.Background(), repository)
	if err := repository.Migrate(context.Background()); err != nil {
		t.Fatal(err)
	}
	return repository
}

func providerTestInput(requestID, organizationID string) application.CreateProviderConnectionInput {
	model := domain.ModelParameters{Model: "first", ContextWindow: 8192, MaxOutputTokens: 1024, SupportsImages: true}
	second := model
	second.Model = "second"
	return application.CreateProviderConnectionInput{
		RequestID: requestID, OrganizationID: organizationID, ProviderKey: "deepseek", DisplayName: "Provider",
		BaseURL: "https://api.deepseek.com", Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "initial-secret"},
		Models: []application.ProviderModelInput{
			{ProfileKey: "first", DisplayName: "First", Model: model},
			{ProfileKey: "second", DisplayName: "Second", Model: second},
		},
	}
}

type providerTestClock struct{}

func (providerTestClock) Now() time.Time { return time.Unix(1, 123456789).UTC() }

type storedCredentialLister struct{ secrets []string }

func (lister *storedCredentialLister) ListModels(_ context.Context, _ ports.ProviderDiscoveryConnection, secret string) ([]ports.DiscoveredModel, error) {
	lister.secrets = append(lister.secrets, secret)
	return []ports.DiscoveredModel{{ModelID: "fixture-model", DisplayName: "Fixture model"}}, nil
}
