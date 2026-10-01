package application

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestProviderCreationSharesOneCredentialAcrossInitialModels(t *testing.T) {
	store := &providerStoreStub{}
	sealer := &sealerStub{sealed: ports.SealedSecret{Ciphertext: []byte("sealed")}}
	service := NewCatalogService(store, sealer, fixedClock{now: time.Unix(1, 0).UTC()})
	input := providerCreateInput()
	input.Models = append(input.Models, input.Models[0])
	input.Models[1].ProfileKey = "second"
	input.Models[1].Model.Model = "another-model"
	view, err := service.CreateProviderConnection(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if sealer.calls != 1 || sealer.identity.CredentialRef != view.ConnectionID || len(store.initialModels) != 2 {
		t.Fatalf("creation did not share a sealed credential: seals=%d models=%d", sealer.calls, len(store.initialModels))
	}
	for _, model := range store.initialModels {
		if model.ProviderConnectionID != view.ConnectionID {
			t.Fatalf("model did not reference its connection: %+v", model)
		}
	}
}

func TestProviderRejectsUnsupportedOrDuplicateInputBeforeSealing(t *testing.T) {
	cases := map[string]func(*CreateProviderConnectionInput){
		"omitted models": func(input *CreateProviderConnectionInput) { input.Models = nil },
		"nonfinite parameter": func(input *CreateProviderConnectionInput) {
			value := math.NaN()
			input.Models[0].Model.Temperature = &value
		},
		"provider":         func(input *CreateProviderConnectionInput) { input.ProviderKey = "codex" },
		"method":           func(input *CreateProviderConnectionInput) { input.Credential.Method = "oauth" },
		"empty key":        func(input *CreateProviderConnectionInput) { input.Credential.APIKey = " " },
		"invalid endpoint": func(input *CreateProviderConnectionInput) { input.BaseURL = "file:///etc/passwd" },
		"invalid model":    func(input *CreateProviderConnectionInput) { input.Models[0].Model.ContextWindow = 0 },
		"duplicate model": func(input *CreateProviderConnectionInput) {
			input.Models = append(input.Models, input.Models[0])
			input.Models[1].ProfileKey = "other-key"
		},
		"duplicate key": func(input *CreateProviderConnectionInput) {
			input.Models = append(input.Models, input.Models[0])
			input.Models[1].Model.Model = "other-model"
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			store := &providerStoreStub{}
			sealer := &sealerStub{}
			input := providerCreateInput()
			change(&input)
			_, err := NewCatalogService(store, sealer, fixedClock{}).CreateProviderConnection(context.Background(), input)
			if !errors.Is(err, ErrInvalidInput) || sealer.calls != 0 || store.writes != 0 {
				t.Fatalf("invalid input had side effects: error=%v seals=%d writes=%d", err, sealer.calls, store.writes)
			}
		})
	}
}

func TestModelEditRejectsChangingAPIIdentityAndDisabledProvider(t *testing.T) {
	ctx := context.Background()
	store := &providerStoreStub{}
	service := NewCatalogService(store, &sealerStub{}, fixedClock{})
	input := providerCreateInput()
	connection, err := service.CreateProviderConnection(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	store.modelRecord = store.initialModels[0]
	parameters := input.Models[0].Model
	parameters.Model = "different-model"
	if _, err := service.ReviseModelProfile(ctx, ReviseModelProfileInput{
		ExpectedVersion: 1,
		RequestID:       "edit", OrganizationID: "org", ModelProfileID: store.modelRecord.ModelProfileID,
		DisplayName: "Model", Model: parameters,
	}); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("API model identity changed in place: %v", err)
	}
	store.connection.Enabled = false
	if _, err := service.CreateModelProfile(ctx, CreateModelProfileInput{
		RequestID: "add", OrganizationID: "org", ProviderConnectionID: connection.ConnectionID,
		ProfileKey: "new", DisplayName: "New", Model: parameters,
	}); !errors.Is(err, ports.ErrDisabledReference) {
		t.Fatalf("disabled connection accepted a model: %v", err)
	}
}

func TestProviderCredentialRotationIsIndependentAndReplayable(t *testing.T) {
	store := &providerStoreStub{}
	sealer := &sealerStub{}
	service := NewCatalogService(store, sealer, fixedClock{now: time.Unix(1, 0).UTC()})
	created, err := service.CreateProviderConnection(context.Background(), providerCreateInput())
	if err != nil {
		t.Fatal(err)
	}
	input := RotateProviderCredentialInput{
		RequestID: "rotate", OrganizationID: "org", ConnectionID: created.ConnectionID,
		ExpectedVersion: created.CredentialVersion, Credential: ProviderCredentialInput{Method: "api_key", APIKey: "new-key"},
	}
	rotated, err := service.RotateProviderCredential(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	if rotated.CredentialVersion == created.CredentialVersion || store.expectedVersion != created.CredentialVersion ||
		len(store.initialModels) != 1 || sealer.calls != 2 || store.modelRecord.ModelProfileID != "" {
		t.Fatal("credential rotation changed models or failed to advance its own version")
	}
	store.replay = store.connection
	store.replayFound = true
	replayed, err := service.RotateProviderCredential(context.Background(), input)
	if err != nil || replayed.CredentialVersion != rotated.CredentialVersion || sealer.calls != 2 {
		t.Fatalf("rotation was not replayed before sealing: %v", err)
	}
}

func TestProviderRotationRejectsCrossOrganizationAndStaleVersion(t *testing.T) {
	for _, organization := range []string{"other-org", "org"} {
		t.Run(organization, func(t *testing.T) {
			store := &providerStoreStub{connection: ports.ProviderConnectionRecord{
				ConnectionID: "connection", OrganizationID: "org", ProviderKey: "deepseek",
				CredentialMethod: "api_key", CredentialVersion: "current", Enabled: true,
			}}
			sealer := &sealerStub{}
			_, err := NewCatalogService(store, sealer, fixedClock{}).RotateProviderCredential(context.Background(), RotateProviderCredentialInput{
				RequestID: "rotate", OrganizationID: organization, ConnectionID: "connection", ExpectedVersion: "stale",
				Credential: ProviderCredentialInput{Method: "api_key", APIKey: "key"},
			})
			expectedSeals := 0
			if organization == "org" {
				expectedSeals = 1
				if !errors.Is(err, ports.ErrConcurrentChange) {
					t.Fatalf("stale version error = %v", err)
				}
			}
			if err == nil || sealer.calls != expectedSeals || store.writes != 0 {
				t.Fatalf("invalid rotation had side effects: %v", err)
			}
		})
	}
}

func providerCreateInput() CreateProviderConnectionInput {
	return CreateProviderConnectionInput{
		RequestID: "create", OrganizationID: "org", ProviderKey: "deepseek", DisplayName: "DeepSeek",
		BaseURL: "https://api.deepseek.com", Credential: ProviderCredentialInput{Method: "api_key", APIKey: "key"},
		Models: []ProviderModelInput{{ProfileKey: "model", DisplayName: "Model", Model: validModelInput().Parameters()}},
	}
}

type providerStoreStub struct {
	catalogStoreStub
	connection      ports.ProviderConnectionRecord
	initialModels   []ports.ModelProfileRecord
	replay          ports.ProviderConnectionRecord
	replayFound     bool
	expectedVersion string
	writes          int
}

func (store *catalogStoreStub) GetProviderConnection(_ context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	if store.provider.ConnectionID != "" {
		if store.provider.OrganizationID != organizationID || store.provider.ConnectionID != connectionID {
			return ports.ProviderConnectionRecord{}, ports.ErrNotFound
		}
		return store.provider, nil
	}
	return ports.ProviderConnectionRecord{
		ConnectionID: "provider-1", OrganizationID: organizationID, ProviderKey: "deepseek",
		BaseURL: validModelInput().BaseURL, CredentialMethod: "api_key", CredentialVersion: "credential-version-1",
		CredentialRevision: 1, Enabled: true,
	}, nil
}

func (store *providerStoreStub) ReplayProviderRequest(context.Context, ports.CatalogRequestKind, string, string) (ports.ProviderConnectionRecord, bool, error) {
	return store.replay, store.replayFound, nil
}

func (store *providerStoreStub) PutProviderConnection(_ context.Context, connection ports.ProviderConnectionRecord, models []ports.ModelProfileRecord) (ports.ProviderConnectionRecord, error) {
	store.connection, store.initialModels = connection, models
	store.writes++
	return connection, nil
}

func (store *providerStoreStub) RotateProviderCredential(_ context.Context, expected string, connection ports.ProviderConnectionRecord) (ports.ProviderConnectionRecord, error) {
	if store.connection.CredentialVersion != expected {
		return ports.ProviderConnectionRecord{}, ports.ErrConcurrentChange
	}
	store.expectedVersion, store.connection = expected, connection
	store.writes++
	return connection, nil
}

func (store *providerStoreStub) GetProviderConnection(_ context.Context, organization, id string) (ports.ProviderConnectionRecord, error) {
	if organization != store.connection.OrganizationID || id != store.connection.ConnectionID {
		return ports.ProviderConnectionRecord{}, ports.ErrNotFound
	}
	return store.connection, nil
}
