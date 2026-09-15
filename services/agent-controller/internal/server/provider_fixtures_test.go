package server

import (
	"context"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
)

func (service *catalogServiceStub) ResolveProviderAccess(context.Context, string, string) (application.ProviderAccess, error) {
	return application.ProviderAccess{Connection: sampleProviderConnection(), Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic"}}, service.getModelErr
}

func sampleProviderConnection() application.ProviderConnectionView {
	return application.ProviderConnectionView{
		RequestProtocol: "openai_chat_completions", ConnectionID: "provider-1", OrganizationID: "org-1", ProviderKey: "deepseek", DisplayName: "DeepSeek",
		BaseURL: "https://api.deepseek.com", CredentialMethod: "api_key", CredentialVersion: "credential-version-1",
		CredentialRevision: 1, Enabled: true, CreatedAt: time.Unix(1, 0).UTC(), UpdatedAt: time.Unix(1, 0).UTC(),
	}
}

func (service *catalogServiceStub) CreateProviderConnection(context.Context, application.CreateProviderConnectionInput) (application.ProviderConnectionView, error) {
	return sampleProviderConnection(), service.getModelErr
}

func (service *catalogServiceStub) RotateProviderCredential(context.Context, application.RotateProviderCredentialInput) (application.ProviderConnectionView, error) {
	return sampleProviderConnection(), service.getModelErr
}

func (service *catalogServiceStub) GetProviderConnection(context.Context, string, string) (application.ProviderConnectionView, error) {
	return sampleProviderConnection(), service.getModelErr
}

func (service *catalogServiceStub) ListProviderConnections(context.Context, application.ListCatalogInput) (application.ProviderConnectionPage, error) {
	return application.ProviderConnectionPage{Items: []application.ProviderConnectionView{sampleProviderConnection()}}, service.getModelErr
}

func sampleCreateProviderRequest() createProviderConnectionRequest {
	return createProviderConnectionRequest{
		RequestID: "provider-create", OrganizationID: "org-1", ProviderKey: "deepseek", DisplayName: "DeepSeek",
		BaseURL: "https://api.deepseek.com", Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic"},
		Models: []application.ProviderModelInput{},
	}
}

func sampleRotateProviderRequest() rotateProviderCredentialRequest {
	return rotateProviderCredentialRequest{
		RequestID: "provider-rotate", OrganizationID: "org-1", ExpectedVersion: "credential-version-1",
		Credential: application.ProviderCredentialInput{Method: "api_key", APIKey: "synthetic"},
	}
}
