package providerdiscovery

import "github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"

type Connection = ports.ProviderDiscoveryConnection
type Model = ports.DiscoveredModel
type Pricing = ports.DiscoveredPricing

func Supports(providerKey string) bool {
	switch providerKey {
	case "deepseek", "openrouter", "openai_compatible":
		return true
	default:
		return false
	}
}
