package postgres

import (
	"testing"

	"github.com/stretchr/testify/require"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/application"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/outbound"
	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func TestExecutionCredentialResolutionReadsSealedProviderAccess(t *testing.T) {
	repository := providerTestRepository(t)
	box, err := credentials.NewSecretBox(make([]byte, 32))
	require.NoError(t, err)
	catalog := application.NewCatalogService(repository, box, providerTestClock{},
		application.WithProviderCredentialReader(repository, box),
		application.WithProviderDiscovery(outbound.NewPolicy(false), nil))
	input := providerTestInput("execution-credential-create", "org")
	input.Credential.APIKey = "synthetic-execution-secret"
	connection, err := catalog.CreateProviderConnection(t.Context(), input)
	require.NoError(t, err)
	metadata, err := repository.GetProviderConnection(t.Context(), "org", connection.ConnectionID)
	require.NoError(t, err)
	require.Empty(t, metadata.SealedCredential, "catalog metadata must not carry credentials")
	request := ports.ExecutionCredentialRequest{OrganizationID: "org", ConnectionID: connection.ConnectionID,
		CredentialVersion: connection.CredentialVersion}
	resolved, err := catalog.ResolveExecutionCredential(t.Context(), request)
	require.NoError(t, err)
	require.Equal(t, input.Credential.APIKey, resolved.Secret)
	require.Equal(t, request.CredentialVersion, resolved.CredentialVersion)
	rotated, err := catalog.RotateProviderCredential(t.Context(), application.RotateProviderCredentialInput{
		RequestID: "execution-credential-rotate", OrganizationID: "org", ConnectionID: connection.ConnectionID,
		ExpectedVersion: request.CredentialVersion,
		Credential:      application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic-rotated-secret"},
	})
	require.NoError(t, err)
	resolved, err = catalog.ResolveExecutionCredential(t.Context(), request)
	require.ErrorIs(t, err, ports.ErrConcurrentChange)
	require.Empty(t, resolved)
	request.CredentialVersion = rotated.CredentialVersion
	resolved, err = catalog.ResolveExecutionCredential(t.Context(), request)
	require.NoError(t, err)
	require.Equal(t, "synthetic-rotated-secret", resolved.Secret)
	request.OrganizationID = "foreign-org"
	resolved, err = catalog.ResolveExecutionCredential(t.Context(), request)
	require.ErrorIs(t, err, ports.ErrNotFound)
	require.Empty(t, resolved)
}
