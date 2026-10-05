package ports

import (
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

var executionIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_./:-]{1,200}$`)

func (snapshot ExecutionSnapshot) Validate() error {
	if !executionIdentifier.MatchString(snapshot.OrganizationID) || !executionRevision(snapshot.Revision) ||
		snapshot.Providers == nil || snapshot.Models == nil || snapshot.Agents == nil {
		return ErrInvalidExecutionConfiguration
	}
	providers := make(map[string]ExecutionProvider, len(snapshot.Providers))
	for _, provider := range snapshot.Providers {
		if _, duplicate := providers[provider.ConnectionID]; duplicate || !provider.valid() {
			return ErrInvalidExecutionConfiguration
		}
		providers[provider.ConnectionID] = provider
	}
	models := make(map[string]bool, len(snapshot.Models))
	for _, model := range snapshot.Models {
		provider, found := providers[model.ConnectionID]
		if !found || models[model.ModelProfileID] || !model.valid(provider.BaseURL) {
			return ErrInvalidExecutionConfiguration
		}
		models[model.ModelProfileID] = true
	}
	agents := make(map[string]bool, len(snapshot.Agents))
	for _, agent := range snapshot.Agents {
		if agents[agent.AgentID] || !models[agent.DefaultModelProfileID] || !agent.valid() {
			return ErrInvalidExecutionConfiguration
		}
		if domain.ValidateModelFallback(agent.DefaultModelProfileID, agent.FallbackModelProfileIDs) != nil {
			return ErrInvalidExecutionConfiguration
		}
		for _, id := range agent.FallbackModelProfileIDs {
			if !models[id] {
				return ErrInvalidExecutionConfiguration
			}
		}
		agents[agent.AgentID] = true
	}
	return nil
}

func (provider ExecutionProvider) valid() bool {
	support, ok := domain.SupportedProvider(provider.ProviderKey)
	if !ok || !executionIdentifier.MatchString(provider.ConnectionID) || provider.RequestProtocol != support.RequestProtocol || !executionEndpoint(provider.BaseURL) {
		return false
	}
	if provider.Credential == nil {
		return !provider.Enabled && provider.CredentialRevision == ""
	}
	return executionIdentifier.MatchString(provider.CredentialRevision) && provider.Credential.Method == support.CredentialMethod && provider.Credential.Secret != ""
}

func (model ExecutionModel) valid(baseURL string) bool {
	return executionIdentifier.MatchString(model.ModelProfileID) && executionText(model.DisplayName) && executionText(model.Model) &&
		int64(model.ContextWindow) <= MaximumExecutionRevision && int64(model.MaxOutputTokens) <= MaximumExecutionRevision &&
		domain.ValidateModelSpec(model.WithEndpoint(baseURL)) == nil
}

func (agent ExecutionAgent) valid() bool {
	return agent.validAccess() && agent.validConfiguration() && agent.validRuntime()
}

func (agent ExecutionAgent) validConfiguration() bool {
	if !executionRevision(agent.AuthorizationRevision) || agent.DefaultAuthorization.Validate() != nil ||
		len(agent.DefaultAuthorization.ToolRules) > 128 || agent.DefaultAuthorization.ToolRules == nil ||
		agent.ContextPolicyVersion != domain.ContextPolicyV1 || agent.MaxModelRequests < 1 || agent.MaxModelRequests > 128 ||
		agent.SkillInstructions == nil || len(agent.SkillInstructions) != 0 {
		return false
	}
	return optionalExecutionID(agent.AgentSpecRevision) && optionalExecutionID(agent.ExecutionRevision)
}

func (agent ExecutionAgent) validAccess() bool {
	if !executionIdentifier.MatchString(agent.AgentID) || !executionIdentifier.MatchString(agent.AccessRevision) || agent.PrincipalIDs == nil || !optionalExecutionID(agent.OperationID) {
		return false
	}
	principals := make(map[string]bool, len(agent.PrincipalIDs))
	for _, id := range agent.PrincipalIDs {
		if !executionIdentifier.MatchString(id) || principals[id] {
			return false
		}
		principals[id] = true
	}
	return true
}

func (agent ExecutionAgent) validRuntime() bool {
	if agent.UnavailableReason != nil && !executionText(*agent.UnavailableReason) {
		return false
	}
	if agent.Runtime != nil && !agent.Runtime.valid() {
		return false
	}
	return !agent.AcceptingRuns || (agent.Runtime != nil && agent.AgentSpecRevision != nil && agent.ExecutionRevision != nil && agent.UnavailableReason == nil)
}

func (runtime ExecutionRuntime) valid() bool {
	return executionIdentifier.MatchString(runtime.RuntimeRevision) && executionIdentifier.MatchString(runtime.RuntimeExecutionID) &&
		len(runtime.MCPEndpoint) <= MaximumExecutionEndpointBytes && executionEndpoint(runtime.MCPEndpoint) &&
		(runtime.ConnectionID == "" || runtimeConnectionID.MatchString(runtime.ConnectionID)) &&
		(runtime.Credential == nil || runtime.Credential.Valid())
}

func (request AgentSettlementRequest) Validate() error {
	if !executionIdentifier.MatchString(request.OrganizationID) || !executionIdentifier.MatchString(request.AgentID) ||
		!executionIdentifier.MatchString(request.OperationID) || !executionRevision(request.MinimumRevision) ||
		(request.Mode != "wait" && request.Mode != "cancel") || request.DeadlineAt.IsZero() || request.DeadlineAt.UTC().Year() < 0 || request.DeadlineAt.UTC().Year() > 9999 {
		return ErrInvalidExecutionConfiguration
	}
	return nil
}

func executionRevision(value int64) bool { return value > 0 && value <= MaximumExecutionRevision }
func executionText(value string) bool {
	if value == "" || !utf8.ValidString(value) {
		return false
	}
	units := 0
	for _, character := range value {
		units++
		if character > 0xffff {
			units++
		}
		if units > MaximumExecutionTextUnits {
			return false
		}
	}
	return true
}
func optionalExecutionID(value *string) bool {
	return value == nil || executionIdentifier.MatchString(*value)
}
func executionEndpoint(value string) bool {
	endpoint, err := url.Parse(value)
	if err != nil || endpoint.Hostname() == "" || endpoint.User != nil || endpoint.Fragment != "" || (endpoint.Scheme != "http" && endpoint.Scheme != "https") {
		return false
	}
	if strings.HasPrefix(endpoint.Host, "[") || strings.Contains(endpoint.Hostname(), ":") {
		address, err := netip.ParseAddr(endpoint.Hostname())
		if err != nil || !address.Is6() || address.Zone() != "" || !strings.HasPrefix(endpoint.Host, "[") {
			return false
		}
	} else if numericHost(endpoint.Hostname()) {
		address, err := netip.ParseAddr(endpoint.Hostname())
		if err != nil || !address.Is4() {
			return false
		}
	}
	if endpoint.Port() != "" {
		if _, err := strconv.ParseUint(endpoint.Port(), 10, 16); err != nil {
			return false
		}
	}
	return true
}

func numericHost(host string) bool {
	labels := strings.Split(strings.TrimSuffix(host, "."), ".")
	last := labels[len(labels)-1]
	if last != "" && strings.Trim(last, "0123456789") == "" {
		return true
	}
	return len(last) > 2 && strings.EqualFold(last[:2], "0x") && strings.Trim(last[2:], "0123456789abcdefABCDEF") == ""
}
