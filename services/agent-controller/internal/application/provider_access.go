package application

import (
	"context"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/ports"
)

type ProviderAccess struct {
	Connection ProviderConnectionView  `json:"connection"`
	Credential ProviderCredentialInput `json:"credential"`
}

type CatalogOption func(*CatalogService)

func WithProviderCredentialReader(reader ports.ProviderAccessReader, opener ports.CredentialOpener) CatalogOption {
	return func(service *CatalogService) { service.accessReader, service.opener = reader, opener }
}

func (service *CatalogService) ResolveProviderAccess(ctx context.Context, organizationID, connectionID string) (ProviderAccess, error) {
	if !validIdentifier(organizationID) || !validIdentifier(connectionID) {
		return ProviderAccess{}, ErrInvalidInput
	}
	if service.opener == nil || service.accessReader == nil {
		return ProviderAccess{}, ErrDependencyUnavailable
	}
	connection, err := service.accessReader.GetProviderAccess(ctx, organizationID, connectionID)
	if err != nil {
		return ProviderAccess{}, err
	}
	if connection.OrganizationID != organizationID || connection.ConnectionID != connectionID {
		return ProviderAccess{}, ports.ErrNotFound
	}
	if !connection.Enabled {
		return ProviderAccess{}, ports.ErrDisabledReference
	}
	secret, err := service.opener.Open(ctx, ports.CredentialIdentity{
		OrganizationID: organizationID, CredentialRef: connectionID, CredentialVersion: connection.CredentialVersion,
	}, connection.SealedCredential)
	if err != nil {
		return ProviderAccess{}, fmt.Errorf("open provider credential: %w", err)
	}
	return ProviderAccess{Connection: providerConnectionView(connection),
		Credential: ProviderCredentialInput{Method: connection.CredentialMethod, APIKey: secret}}, nil
}
