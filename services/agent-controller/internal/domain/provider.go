package domain

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
