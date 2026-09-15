package application

import (
	"context"
	"errors"
	"testing"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

func TestProviderAccessReadsCurrentCredentialWithoutWriting(t *testing.T) {
	store := &providerStoreStub{connection: ports.ProviderConnectionRecord{
		ConnectionID: "connection", OrganizationID: "org", ProviderKey: "deepseek", Enabled: true,
		CredentialVersion: "new-version", CredentialMethod: "api_key",
	}}
	opener := &executionCredentialOpener{}
	service := NewCatalogService(store, nil, fixedClock{}, WithProviderCredentialReader(store, opener))
	for range 2 {
		view, err := service.ResolveProviderAccess(context.Background(), "org", "connection")
		if err != nil || view.Credential.APIKey != "synthetic-current-secret" || view.Connection.ConnectionID != "connection" {
			t.Fatalf("provider access failed: %v", err)
		}
	}
	if store.writes != 0 || len(opener.calls) != 2 || opener.calls[1].CredentialVersion != "new-version" {
		t.Fatal("access wrote data or reused stale credentials")
	}
}

func TestProviderAccessRejectsScopeAndDisabledBeforeOpeningSecret(t *testing.T) {
	for _, organization := range []string{"other", "org"} {
		store := &providerStoreStub{connection: ports.ProviderConnectionRecord{ConnectionID: "connection", OrganizationID: "org"}}
		opener := &executionCredentialOpener{}
		service := NewCatalogService(store, nil, fixedClock{}, WithProviderCredentialReader(store, opener))
		_, err := service.ResolveProviderAccess(context.Background(), organization, "connection")
		if err == nil || len(opener.calls) != 0 || store.writes != 0 {
			t.Fatalf("invalid access performed work: %v", err)
		}
	}
	service := NewCatalogService(&providerStoreStub{}, nil, fixedClock{})
	if _, err := service.ResolveProviderAccess(context.Background(), "", "connection"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid identity: %v", err)
	}
}

func (store *providerStoreStub) GetProviderAccess(ctx context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	return store.GetProviderConnection(ctx, organizationID, connectionID)
}
