package application

import "soft/antnest-platform/services/agent-controller/internal/domain"

type providerSupport struct {
	requestProtocol  string
	credentialMethod string
}

func supportedProvider(key string) (providerSupport, bool) {
	support, ok := domain.SupportedProvider(key)
	return providerSupport{requestProtocol: support.RequestProtocol, credentialMethod: support.CredentialMethod}, ok
}
