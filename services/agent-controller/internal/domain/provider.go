package domain

import (
	"fmt"
	"strings"
)

type ProviderSupport struct {
	CredentialMethod string
	RequestProtocol  string
}

func SupportedProvider(key string) (ProviderSupport, bool) {
	switch key {
	case "deepseek":
		return ProviderSupport{CredentialMethod: "api_key", RequestProtocol: "openai_chat_completions"}, true
	default:
		return ProviderSupport{}, false
	}
}

type ProviderExecution struct {
	ConnectionID     string `json:"connection_id"`
	ProviderKey      string `json:"provider_key"`
	CredentialMethod string `json:"credential_method"`
	RequestProtocol  string `json:"request_protocol"`
}

func (provider ProviderExecution) Validate() error {
	support, ok := SupportedProvider(provider.ProviderKey)
	if !ok || strings.TrimSpace(provider.ConnectionID) == "" ||
		provider.CredentialMethod != support.CredentialMethod || provider.RequestProtocol != support.RequestProtocol {
		return fmt.Errorf("unsupported Provider execution configuration")
	}
	return nil
}
