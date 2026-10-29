package application

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

type executionCredentialStoreStub struct {
	ports.CatalogStore
	connection ports.ProviderConnectionRecord
	err        error
	calls      int
}

func (store *executionCredentialStoreStub) GetProviderConnection(_ context.Context, organizationID, connectionID string) (ports.ProviderConnectionRecord, error) {
	store.calls++
	if store.err != nil {
		return ports.ProviderConnectionRecord{}, store.err
	}
	if store.connection.OrganizationID != organizationID || store.connection.ConnectionID != connectionID {
		return ports.ProviderConnectionRecord{}, ports.ErrNotFound
	}
	return store.connection, nil
}

var emptySecret = ""

func executionCredentialFixture() (ports.ProviderConnectionRecord, ports.ExecutionCredentialRequest) {
	connection := ports.ProviderConnectionRecord{OrganizationID: "org-1", ConnectionID: "provider-1",
		ProviderKey: "deepseek", CredentialMethod: "api_key", CredentialVersion: "credential-current",
		SealedCredential: ports.SealedSecret{Ciphertext: []byte("sealed"), Nonce: []byte("nonce")}, Enabled: true}
	return connection, ports.ExecutionCredentialRequest{OrganizationID: "org-1", ConnectionID: "provider-1", CredentialVersion: "credential-current"}
}

func TestResolveExecutionCredentialReturnsExactScopeSecret(t *testing.T) {
	connection, request := executionCredentialFixture()
	store := &executionCredentialStoreStub{connection: connection}
	opener := &executionCredentialOpener{}
	service := NewCatalogService(store, nil, fixedClock{now: time.Unix(1, 0).UTC()}, WithProviderCredentialReader(nil, opener))
	resolved, err := service.ResolveExecutionCredential(t.Context(), request)
	require.NoError(t, err)
	require.Equal(t, ports.ResolvedExecutionCredential{OrganizationID: "org-1", ConnectionID: "provider-1",
		CredentialVersion: "credential-current", Method: "api_key", Secret: "synthetic-current-secret"}, resolved)
	require.Equal(t, []ports.CredentialIdentity{{OrganizationID: "org-1", CredentialRef: "provider-1", CredentialVersion: "credential-current"}}, opener.calls)
	require.Equal(t, 1, store.calls)
}

func TestResolveExecutionCredentialRejectsScopeAndCurrentState(t *testing.T) {
	connection, request := executionCredentialFixture()
	for _, scenario := range []struct {
		name   string
		want   error
		mutate func(*executionCredentialStoreStub, *ports.ExecutionCredentialRequest)
	}{
		{"bad organization", ErrInvalidInput, func(_ *executionCredentialStoreStub, r *ports.ExecutionCredentialRequest) { r.OrganizationID = "" }},
		{"bad connection", ErrInvalidInput, func(_ *executionCredentialStoreStub, r *ports.ExecutionCredentialRequest) { r.ConnectionID = "../etc" }},
		{"bad version", ErrInvalidInput, func(_ *executionCredentialStoreStub, r *ports.ExecutionCredentialRequest) { r.CredentialVersion = "" }},
		{"missing connection", ports.ErrNotFound, func(s *executionCredentialStoreStub, r *ports.ExecutionCredentialRequest) {
			r.ConnectionID = "provider-other"
		}},
		{"foreign record", ports.ErrNotFound, func(s *executionCredentialStoreStub, _ *ports.ExecutionCredentialRequest) {
			s.connection.OrganizationID = "org-2"
		}},
		{"disabled", ports.ErrConcurrentChange, func(s *executionCredentialStoreStub, _ *ports.ExecutionCredentialRequest) {
			s.connection.Enabled = false
		}},
		{"rotated", ports.ErrConcurrentChange, func(s *executionCredentialStoreStub, _ *ports.ExecutionCredentialRequest) {
			s.connection.CredentialVersion = "credential-rotated"
		}},
		{"unsupported method", ports.ErrConcurrentChange, func(s *executionCredentialStoreStub, _ *ports.ExecutionCredentialRequest) {
			s.connection.CredentialMethod = "bearer"
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			store := &executionCredentialStoreStub{connection: connection}
			candidate := request
			scenario.mutate(store, &candidate)
			opener := &executionCredentialOpener{}
			service := NewCatalogService(store, nil, fixedClock{now: time.Unix(1, 0).UTC()}, WithProviderCredentialReader(nil, opener))
			resolved, err := service.ResolveExecutionCredential(t.Context(), candidate)
			require.ErrorIs(t, err, scenario.want)
			require.Empty(t, resolved)
			require.Empty(t, opener.calls, "rejected scope never decrypts")
		})
	}
}

func TestResolveExecutionCredentialHidesDependencyAndSecretFailures(t *testing.T) {
	connection, request := executionCredentialFixture()
	for _, scenario := range []struct {
		name   string
		opener *executionCredentialOpener
		store  *executionCredentialStoreStub
	}{
		{"store", &executionCredentialOpener{}, &executionCredentialStoreStub{connection: connection, err: errors.New("storage sk-canary")}},
		{"open", &executionCredentialOpener{err: errors.New("sealed sk-canary")}, &executionCredentialStoreStub{connection: connection}},
		{"unconfigured", nil, &executionCredentialStoreStub{connection: connection}},
		{"empty secret", &executionCredentialOpener{plaintext: &emptySecret}, &executionCredentialStoreStub{connection: connection}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var options []CatalogOption
			if scenario.opener != nil {
				options = append(options, WithProviderCredentialReader(nil, scenario.opener))
			}
			service := NewCatalogService(scenario.store, nil, fixedClock{now: time.Unix(1, 0).UTC()}, options...)
			resolved, err := service.ResolveExecutionCredential(t.Context(), request)
			require.ErrorIs(t, err, ErrDependencyUnavailable)
			require.NotContains(t, err.Error(), "sk-canary")
			require.Empty(t, resolved)
		})
	}
}
