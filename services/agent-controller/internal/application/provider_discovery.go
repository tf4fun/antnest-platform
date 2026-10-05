package application

import (
	"context"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type CatalogOption func(*CatalogService)

func WithSkillVersionResolver(resolver ports.SkillVersionResolver) CatalogOption {
	return func(service *CatalogService) { service.skillResolver = resolver }
}

func WithProviderCredentialReader(reader ports.ProviderAccessReader, opener ports.CredentialOpener) CatalogOption {
	return func(service *CatalogService) { service.accessReader, service.opener = reader, opener }
}

func WithProviderDiscovery(validator ports.ProviderEndpointValidator, lister ports.ProviderModelLister) CatalogOption {
	return func(service *CatalogService) { service.providerValidator, service.providerLister = validator, lister }
}

func WithProviderRequestTimeout(timeout time.Duration) CatalogOption {
	return func(service *CatalogService) {
		if timeout > 0 {
			service.providerTimeout = timeout
		}
	}
}

type ProviderDiscoveryResult struct {
	Models []ports.DiscoveredModel `json:"models"`
}

type DraftProviderDiscoveryInput struct {
	OrganizationID string                  `json:"organization_id"`
	ProviderKey    string                  `json:"provider_key"`
	BaseURL        string                  `json:"base_url"`
	Credential     ProviderCredentialInput `json:"credential"`
}

func (service *CatalogService) DiscoverProviderModels(ctx context.Context, organizationID, connectionID string) (ProviderDiscoveryResult, error) {
	if !validIdentifier(organizationID) || !validIdentifier(connectionID) {
		return ProviderDiscoveryResult{}, ErrInvalidInput
	}
	if service.opener == nil || service.accessReader == nil || service.providerValidator == nil || service.providerLister == nil {
		return ProviderDiscoveryResult{}, ErrDependencyUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, service.providerTimeout)
	defer cancel()
	connection, err := service.accessReader.GetProviderAccess(ctx, organizationID, connectionID)
	if err != nil {
		return ProviderDiscoveryResult{}, err
	}
	if connection.OrganizationID != organizationID || connection.ConnectionID != connectionID {
		return ProviderDiscoveryResult{}, ports.ErrNotFound
	}
	if !connection.Enabled {
		return ProviderDiscoveryResult{}, ports.ErrDisabledReference
	}
	if err := service.providerValidator.ValidateEndpoint(ctx, connection.BaseURL); err != nil {
		return ProviderDiscoveryResult{}, err
	}
	secret, err := service.opener.Open(ctx, ports.CredentialIdentity{
		OrganizationID: organizationID, CredentialRef: connectionID, CredentialVersion: connection.CredentialVersion,
	}, connection.SealedCredential)
	if err != nil {
		return ProviderDiscoveryResult{}, ErrDependencyUnavailable
	}
	return service.discoverModels(ctx, ports.ProviderDiscoveryConnection{ProviderKey: connection.ProviderKey, BaseURL: connection.BaseURL}, secret)
}

func (service *CatalogService) DiscoverDraftProviderModels(ctx context.Context, input DraftProviderDiscoveryInput) (ProviderDiscoveryResult, error) {
	if !validIdentifier(input.OrganizationID) || !validAPIKey(input.Credential) || strings.TrimSpace(input.BaseURL) == "" ||
		(input.ProviderKey != "deepseek" && input.ProviderKey != "openrouter" && input.ProviderKey != "openai_compatible") {
		return ProviderDiscoveryResult{}, ErrInvalidInput
	}
	if service.providerValidator == nil || service.providerLister == nil {
		return ProviderDiscoveryResult{}, ErrDependencyUnavailable
	}
	ctx, cancel := context.WithTimeout(ctx, service.providerTimeout)
	defer cancel()
	if err := service.providerValidator.ValidateEndpoint(ctx, input.BaseURL); err != nil {
		return ProviderDiscoveryResult{}, err
	}
	return service.discoverModels(ctx, ports.ProviderDiscoveryConnection{ProviderKey: input.ProviderKey, BaseURL: input.BaseURL}, input.Credential.APIKey)
}

func (service *CatalogService) discoverModels(ctx context.Context, connection ports.ProviderDiscoveryConnection, secret string) (ProviderDiscoveryResult, error) {
	models, err := service.providerLister.ListModels(ctx, connection, secret)
	if err != nil {
		return ProviderDiscoveryResult{}, err
	}
	if models == nil {
		return ProviderDiscoveryResult{}, ports.ErrProviderDiscoveryFailed
	}
	return ProviderDiscoveryResult{Models: models}, nil
}
