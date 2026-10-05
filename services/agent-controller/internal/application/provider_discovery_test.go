package application

import (
	"context"
	"errors"
	"testing"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type providerEndpointStub struct {
	err   error
	calls int
}

func (stub *providerEndpointStub) ValidateEndpoint(context.Context, string) error {
	stub.calls++
	return stub.err
}

type providerListerStub struct {
	calls []string
	err   error
}

func (stub *providerListerStub) ListModels(_ context.Context, connection ports.ProviderDiscoveryConnection, secret string) ([]ports.DiscoveredModel, error) {
	stub.calls = append(stub.calls, secret)
	return []ports.DiscoveredModel{{ModelID: "synthetic-model", DisplayName: "Synthetic"}}, stub.err
}

func TestDiscoveryReadsCurrentCredentialOnlyInsideController(t *testing.T) {
	store := &providerStoreStub{connection: ports.ProviderConnectionRecord{
		ConnectionID: "connection", OrganizationID: "org", ProviderKey: "deepseek", Enabled: true,
		BaseURL: "https://provider.example", CredentialVersion: "new-version", CredentialMethod: "api_key",
	}}
	opener := &executionCredentialOpener{}
	lister := &providerListerStub{}
	service := NewCatalogService(store, nil, fixedClock{}, WithProviderCredentialReader(store, opener), WithProviderDiscovery(&providerEndpointStub{}, lister))
	for range 2 {
		view, err := service.DiscoverProviderModels(t.Context(), "org", "connection")
		if err != nil || len(view.Models) != 1 || view.Models[0].ModelID != "synthetic-model" {
			t.Fatalf("discovery failed: %v", err)
		}
	}
	if store.writes != 0 || len(opener.calls) != 2 || opener.calls[1].CredentialVersion != "new-version" || len(lister.calls) != 2 || lister.calls[1] != "synthetic-current-secret" {
		t.Fatal("discovery wrote data or reused stale credentials")
	}
}

func TestDiscoveryRejectsScopeDisabledAndForbiddenBeforeOpeningSecret(t *testing.T) {
	for _, scenario := range []struct {
		name, organization string
		enabled            bool
		policyErr          error
	}{
		{"scope", "other", true, nil}, {"disabled", "org", false, nil},
		{"private", "org", true, ports.ErrProviderEndpointForbidden}, {"DNS", "org", true, ports.ErrProviderEndpointUnavailable},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			store := &providerStoreStub{connection: ports.ProviderConnectionRecord{ConnectionID: "connection", OrganizationID: "org", BaseURL: "https://provider.example", Enabled: scenario.enabled}}
			opener, lister := &executionCredentialOpener{}, &providerListerStub{}
			service := NewCatalogService(store, nil, fixedClock{}, WithProviderCredentialReader(store, opener), WithProviderDiscovery(&providerEndpointStub{err: scenario.policyErr}, lister))
			_, err := service.DiscoverProviderModels(t.Context(), scenario.organization, "connection")
			if err == nil || len(opener.calls) != 0 || len(lister.calls) != 0 || store.writes != 0 {
				t.Fatalf("rejected discovery performed work: %v", err)
			}
		})
	}
}

func TestDraftDiscoveryUsesEphemeralCredentialAndNeverLoadsStoredCredentials(t *testing.T) {
	store, lister := &providerStoreStub{}, &providerListerStub{}
	service := NewCatalogService(store, nil, fixedClock{}, WithProviderDiscovery(&providerEndpointStub{}, lister))
	result, err := service.DiscoverDraftProviderModels(t.Context(), DraftProviderDiscoveryInput{OrganizationID: "org", ProviderKey: "openai_compatible", BaseURL: "https://provider.example/v1", Credential: ProviderCredentialInput{Method: "api_key", APIKey: "draft-secret"}})
	if err != nil || len(result.Models) != 1 || len(lister.calls) != 1 || lister.calls[0] != "draft-secret" || store.writes != 0 {
		t.Fatalf("draft credential leaked into persistence: %v", err)
	}
}

func TestProviderCreationChecksDestinationBeforeSealingButReplaysWithoutDNS(t *testing.T) {
	for _, denial := range []error{ports.ErrProviderEndpointForbidden, ports.ErrProviderEndpointUnavailable} {
		store, sealer, policy := &providerStoreStub{}, &sealerStub{}, &providerEndpointStub{err: denial}
		service := NewCatalogService(store, sealer, fixedClock{}, WithProviderDiscovery(policy, nil))
		if _, err := service.CreateProviderConnection(t.Context(), providerCreateInput()); !errors.Is(err, denial) || sealer.calls != 0 || store.writes != 0 {
			t.Fatalf("destination failure had side effects: %v", err)
		}
		store.replayFound = true
		store.replay = ports.ProviderConnectionRecord{ConnectionID: "existing", OrganizationID: "org"}
		view, err := service.CreateProviderConnection(t.Context(), providerCreateInput())
		if err != nil || view.ConnectionID != "existing" || policy.calls != 1 {
			t.Fatalf("accepted replay unnecessarily depended on DNS: %v", err)
		}
	}
}

func TestDiscoveryAndCreationFailClosedWithoutDestinationPolicy(t *testing.T) {
	service := NewCatalogService(&providerStoreStub{}, &sealerStub{}, fixedClock{})
	if _, err := service.CreateProviderConnection(t.Context(), providerCreateInput()); !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("missing policy accepted create: %v", err)
	}
	if _, err := service.DiscoverProviderModels(t.Context(), "org", "connection"); !errors.Is(err, ErrDependencyUnavailable) {
		t.Fatalf("missing discovery accepted: %v", err)
	}
	if _, err := service.DiscoverProviderModels(t.Context(), "", "connection"); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid identity: %v", err)
	}
}

func (store *providerStoreStub) GetProviderAccess(ctx context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	return store.GetProviderConnection(ctx, organizationID, connectionID)
}
