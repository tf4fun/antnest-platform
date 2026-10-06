package oidcflow

import (
	"bytes"
	"testing"

	secretencryption "github.com/tf4fun/antnest-platform/modules/secret-encryption"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
)

func TestMetadataUpdateRewrapsRetainedClientSecretToActiveKey(t *testing.T) {
	repository := newOIDCRepositoryStub(t)
	repository.principal = systemAdministrator()
	repository.provider = testProvider(t)
	federation := &federationStub{discovery: Discovery{Issuer: "https://id.example.com", AuthorizationEndpoint: "https://id.example.com/authorize", TokenEndpoint: "https://id.example.com/token", JWKSURI: "https://id.example.com/jwks", TokenEndpointAuthMethods: []string{"client_secret_basic"}, IDTokenSigningAlgs: []string{"RS256"}}}
	service := newTestService(t, repository, federation)
	box, err := credentials.NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"local-v1": bytes.Repeat([]byte{7}, 32), "kid2": bytes.Repeat([]byte{8}, 32)}})
	if err != nil {
		t.Fatal(err)
	}
	service.secretBox = box
	_, err = service.UpsertProvider(t.Context(), UpsertProviderInput{RequestID: "metadata", ActorPrincipalID: "admin", OrganizationID: "org-1", Name: "workforce", Issuer: "https://id.example.com", ClientID: "client-1", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	if repository.upsert.Provider.ClientSecret.KeyID != "kid2" {
		t.Fatal("metadata update wrote a decrypt-only key back")
	}
	retired, err := credentials.NewKeyring(secretencryption.Config{ActiveKID: "kid2", Keys: map[string][]byte{"kid2": bytes.Repeat([]byte{8}, 32)}})
	if err != nil {
		t.Fatal(err)
	}
	if value, err := retired.Open(repository.upsert.Provider.ClientSecret, ProviderSecretIdentity("org-1", "workforce")); err != nil || string(value) != "client-secret" {
		t.Fatalf("retained secret after retirement: %v", err)
	}
}
