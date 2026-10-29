package application

import (
	"context"
	"errors"
	"fmt"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func (service *CatalogService) ResolveExecutionCredential(ctx context.Context, input ports.ExecutionCredentialRequest) (ports.ResolvedExecutionCredential, error) {
	if !validIdentifier(input.OrganizationID) || !validIdentifier(input.ConnectionID) || !validIdentifier(input.CredentialVersion) {
		return ports.ResolvedExecutionCredential{}, ErrInvalidInput
	}
	connection, err := service.store.GetProviderConnection(ctx, input.OrganizationID, input.ConnectionID)
	if errors.Is(err, ports.ErrNotFound) {
		return ports.ResolvedExecutionCredential{}, ports.ErrNotFound
	}
	if err != nil {
		return ports.ResolvedExecutionCredential{}, fmt.Errorf("%w: read Provider connection", ErrDependencyUnavailable)
	}
	if connection.OrganizationID != input.OrganizationID || connection.ConnectionID != input.ConnectionID {
		return ports.ResolvedExecutionCredential{}, ports.ErrNotFound
	}
	support, ok := domain.SupportedProvider(connection.ProviderKey)
	if !connection.Enabled || connection.CredentialVersion != input.CredentialVersion ||
		!ok || connection.CredentialMethod != support.CredentialMethod {
		return ports.ResolvedExecutionCredential{}, ports.ErrConcurrentChange
	}
	if service.opener == nil {
		return ports.ResolvedExecutionCredential{}, fmt.Errorf("%w: execution credential opening is not configured", ErrDependencyUnavailable)
	}
	secret, err := service.opener.Open(ctx, ports.CredentialIdentity{
		OrganizationID: input.OrganizationID, CredentialRef: input.ConnectionID, CredentialVersion: input.CredentialVersion,
	}, connection.SealedCredential)
	if err != nil {
		if err := ctx.Err(); err != nil {
			return ports.ResolvedExecutionCredential{}, err
		}
		return ports.ResolvedExecutionCredential{}, fmt.Errorf("%w: open execution credential", ErrDependencyUnavailable)
	}
	if secret == "" {
		return ports.ResolvedExecutionCredential{}, fmt.Errorf("%w: open execution credential", ErrDependencyUnavailable)
	}
	if err := ctx.Err(); err != nil {
		return ports.ResolvedExecutionCredential{}, err
	}
	return ports.ResolvedExecutionCredential{OrganizationID: input.OrganizationID, ConnectionID: input.ConnectionID,
		CredentialVersion: input.CredentialVersion, Method: support.CredentialMethod, Secret: secret}, nil
}
