package server

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// Browser projections are allowlists. Adding a field to an internal RPC
// response never makes it public until the BFF deliberately projects it.
type userSource struct {
	ID         string `json:"id"`
	SystemRole string `json:"system_role"`
	Active     bool   `json:"active"`
	CreatedAt  string `json:"created_at"`
	UpdatedAt  string `json:"updated_at"`
}

type membershipSource struct {
	ID          string `json:"id"`
	UserID      string `json:"user_id"`
	Email       string `json:"email"`
	DisplayName string `json:"display_name"`
	Role        string `json:"role"`
	Source      string `json:"source"`
	Active      bool   `json:"active"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type directoryMemberSource struct {
	User       userSource       `json:"user"`
	Membership membershipSource `json:"membership"`
}

type groupSource struct {
	DisplayName string `json:"display_name"`
	Source      string `json:"source"`
	Active      bool   `json:"active"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type directorySource struct {
	Users  []directoryMemberSource `json:"users"`
	Groups []groupSource           `json:"groups"`
}

type currentAccountSource struct {
	Email                  string `json:"email"`
	DisplayName            string `json:"display_name"`
	Source                 string `json:"source"`
	OrganizationSlug       string `json:"organization_slug"`
	OrganizationName       string `json:"organization_name"`
	LocalPasswordAvailable bool   `json:"local_password_available"`
}

type currentAccountResultSource struct {
	Account currentAccountSource `json:"account"`
}

type membershipResultSource struct {
	Membership membershipSource `json:"membership"`
}

type statusSource struct {
	Status string `json:"status"`
}

type oidcProviderSource struct {
	Name                    string   `json:"name"`
	DisplayName             string   `json:"display_name"`
	Issuer                  string   `json:"issuer"`
	ClientID                string   `json:"client_id"`
	Scopes                  []string `json:"scopes"`
	Enabled                 bool     `json:"enabled"`
	Revision                int64    `json:"revision"`
	AuthorizationEndpoint   string   `json:"authorization_endpoint"`
	TokenEndpoint           string   `json:"token_endpoint"`
	TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
	IDTokenSigningAlgs      []string `json:"id_token_signing_algs"`
	UserInfoEndpoint        string   `json:"userinfo_endpoint,omitempty"`
	JWKSURI                 string   `json:"jwks_uri"`
	CreatedAt               string   `json:"created_at"`
	UpdatedAt               string   `json:"updated_at"`
}

type oidcProviderListSource struct {
	Providers []oidcProviderSource `json:"providers"`
}

type oidcProviderResultSource struct {
	Provider oidcProviderSource `json:"provider"`
}

type scimTokenSource struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Scopes    []string `json:"scopes"`
	CreatedAt string   `json:"created_at"`
	RevokedAt string   `json:"revoked_at,omitempty"`
}

type scimTokenListSource struct {
	Tokens []scimTokenSource `json:"tokens"`
}

type scimTokenIssueSource struct {
	Token      scimTokenSource `json:"token"`
	Credential string          `json:"credential"`
}

type modelProfileSource struct {
	ProviderConnectionID string               `json:"provider_connection_id"`
	ModelProfileID       string               `json:"model_profile_id"`
	DisplayName          string               `json:"display_name"`
	RevisionID           string               `json:"revision_id"`
	Revision             int64                `json:"revision"`
	Enabled              bool                 `json:"enabled"`
	Model                agentModelSpecSource `json:"model"`
	CreatedAt            string               `json:"created_at"`
	UpdatedAt            string               `json:"updated_at"`
}

type modelCatalogEntrySource struct {
	Pricing         modelPricingSource `json:"pricing,omitzero"`
	ModelID         string             `json:"model_id"`
	DisplayName     string             `json:"display_name"`
	ContextWindow   int                `json:"context_window"`
	MaxOutputTokens int                `json:"max_output_tokens"`
	SupportsImages  bool               `json:"supports_images"`
	SupportsAudio   bool               `json:"supports_audio,omitempty"`
	SupportsPDF     bool               `json:"supports_pdf,omitempty"`
}

type modelProviderPresetSource struct {
	ProviderKey string                    `json:"provider_key"`
	DisplayName string                    `json:"display_name"`
	Description string                    `json:"description"`
	BaseURL     string                    `json:"base_url"`
	Custom      bool                      `json:"custom"`
	Models      []modelCatalogEntrySource `json:"models"`
}

type modelCatalogSource struct {
	Revision  string                      `json:"revision"`
	Providers []modelProviderPresetSource `json:"providers"`
}

type modelProfileListSource struct {
	Items       []modelProfileSource `json:"items"`
	NextAfterID *string              `json:"next_after_id"`
}

type templateSource struct {
	FallbackModelProfileIDs []string                           `json:"fallback_model_profile_ids,omitempty"`
	TemplateID              string                             `json:"template_id"`
	Name                    string                             `json:"name"`
	Revision                int64                              `json:"revision"`
	ModelProfileID          string                             `json:"model_profile_id"`
	SystemPrompt            string                             `json:"system_prompt"`
	MaxModelRequests        int                                `json:"max_model_requests"`
	ContextPolicyVersion    string                             `json:"context_policy_version"`
	Runtime                 templateRuntimeConfigurationSource `json:"runtime"`
	SkillRefs               []skillVersion                     `json:"skill_refs"`
	SkillSetDigest          string                             `json:"skill_set_digest,omitempty"`
	Enabled                 bool                               `json:"enabled"`
	CreatedAt               string                             `json:"created_at"`
	UpdatedAt               string                             `json:"updated_at"`
}

type templateListSource struct {
	Items       []templateSource `json:"items"`
	NextAfterID *string          `json:"next_after_id"`
}

type runtimeProjectionSource struct {
	RuntimeRevision string `json:"runtime_revision"`
}

type agentModelSpecSource struct {
	Pricing         modelPricingSource `json:"pricing,omitzero"`
	BaseURL         string             `json:"base_url"`
	Model           string             `json:"model"`
	ContextWindow   int                `json:"context_window"`
	MaxOutputTokens int                `json:"max_output_tokens"`
	Temperature     *float64           `json:"temperature,omitempty"`
	SupportsImages  bool               `json:"supports_images"`
	SupportsAudio   bool               `json:"supports_audio,omitempty"`
	SupportsPDF     bool               `json:"supports_pdf,omitempty"`
}

type agentRuntimeResourcesSource struct {
	MemoryBytes int64 `json:"memory_bytes"`
	PIDsLimit   int   `json:"pids_limit"`
	TmpfsBytes  int64 `json:"tmpfs_bytes"`
}

type runtimeConfigurationSource struct {
	ImageRef    string                      `json:"image_ref"`
	ImageSource string                      `json:"image_source,omitempty"`
	Resources   agentRuntimeResourcesSource `json:"resources"`
}

type managedMCPSummary struct {
	ID      string `json:"id"`
	Command string `json:"command"`
}

type managedMCPServer struct {
	ID        string                      `json:"id"`
	Command   string                      `json:"command"`
	Args      []string                    `json:"args"`
	Env       map[string]string           `json:"env"`
	SecretEnv map[string]managedMCPSecret `json:"secret_env,omitempty"`
}

type managedMCPSecret struct {
	Set         bool   `json:"set"`
	Fingerprint string `json:"fingerprint"`
}

var managedMCPFingerprint = regexp.MustCompile(`^hmac-sha256:[0-9a-f]{32}$`)

type templateRuntimeConfigurationSource struct {
	runtimeConfigurationSource
	MCPServers []managedMCPServer `json:"mcp_servers,omitempty"`
}

type agentRuntimeConfigurationSource struct {
	runtimeConfigurationSource
	MCPServers []managedMCPSummary `json:"mcp_servers,omitempty"`
}

type agentTemplateLineageSource struct {
	TemplateID string `json:"template_id"`
	Revision   int64  `json:"revision"`
	Name       string `json:"name"`
}

type agentModelProfileLineageSource struct {
	ModelProfileID string               `json:"model_profile_id"`
	RevisionID     string               `json:"revision_id"`
	Revision       int64                `json:"revision"`
	Name           string               `json:"name"`
	Model          agentModelSpecSource `json:"model"`
}

type agentConfigurationSource struct {
	Template             agentTemplateLineageSource      `json:"template"`
	ModelProfile         agentModelProfileLineageSource  `json:"model_profile"`
	MaxModelRequests     int                             `json:"max_model_requests"`
	ContextPolicyVersion string                          `json:"context_policy_version"`
	Runtime              agentRuntimeConfigurationSource `json:"runtime"`
}

type agentProjectionSource struct {
	AgentID                         string                    `json:"agent_id"`
	OwnerUserID                     string                    `json:"owner_user_id"`
	Name                            string                    `json:"name"`
	DesiredState                    string                    `json:"desired_state"`
	LifecycleState                  string                    `json:"lifecycle_state"`
	ActivationState                 string                    `json:"activation_state,omitempty"`
	RuntimeState                    string                    `json:"runtime_state"`
	RuntimeReason                   string                    `json:"runtime_reason,omitempty"`
	RuntimeDetail                   string                    `json:"runtime_detail,omitempty"`
	RuntimeObservedAt               string                    `json:"runtime_observed_at,omitempty"`
	AgentSpecRevision               string                    `json:"agent_spec_revision,omitempty"`
	LastSuccessfulExecutionRevision string                    `json:"last_successful_execution_revision,omitempty"`
	ExecutableExecutionRevision     string                    `json:"executable_execution_revision,omitempty"`
	Runtime                         *runtimeProjectionSource  `json:"runtime,omitempty"`
	ActiveOperationRequestID        string                    `json:"active_operation_request_id,omitempty"`
	FailureStage                    string                    `json:"failure_stage,omitempty"`
	FailureCode                     string                    `json:"failure_code,omitempty"`
	Configuration                   *agentConfigurationSource `json:"configuration,omitempty"`
	AggregateSequence               int64                     `json:"aggregate_sequence"`
	CreatedAt                       string                    `json:"created_at"`
	UpdatedAt                       string                    `json:"updated_at"`
}

type agentListSource struct {
	Items      []agentProjectionSource `json:"items"`
	NextCursor *string                 `json:"next_cursor"`
}

type operationProjectionSource struct {
	RequestID   string `json:"request_id"`
	AgentID     string `json:"agent_id"`
	Kind        string `json:"kind"`
	Phase       string `json:"phase"`
	State       string `json:"state"`
	ErrorCode   string `json:"error_code,omitempty"`
	ErrorDetail string `json:"error_detail,omitempty"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type agentSkillPreparationProgressSource struct {
	VerifiedPackages int   `json:"verified_packages"`
	VerifiedBytes    int64 `json:"verified_bytes"`
	TotalPackages    int   `json:"total_packages"`
	TotalBytes       int64 `json:"total_bytes"`
}

type agentSkillPreparationSource struct {
	RequestID  string                              `json:"request_id"`
	AgentID    string                              `json:"agent_id"`
	Kind       string                              `json:"kind"`
	State      string                              `json:"state"`
	Progress   agentSkillPreparationProgressSource `json:"progress"`
	RetryAfter *string                             `json:"retry_after,omitempty"`
	ErrorCode  string                              `json:"error_code,omitempty"`
	UpdatedAt  string                              `json:"updated_at"`
}

type createAgentSource struct {
	Agent     agentProjectionSource     `json:"agent"`
	Operation operationProjectionSource `json:"operation"`
}

type agentEventProjectionSource struct {
	EventID            string `json:"event_id"`
	GlobalSequence     int64  `json:"global_sequence"`
	AggregateSequence  int64  `json:"aggregate_sequence"`
	SchemaVersion      int    `json:"schema_version"`
	AgentID            string `json:"agent_id"`
	EventType          string `json:"event_type"`
	OperationRequestID string `json:"operation_request_id,omitempty"`
	TraceID            string `json:"trace_id,omitempty"`
	OccurredAt         string `json:"occurred_at"`
}

type agentEventListSource struct {
	Events       []agentEventProjectionSource `json:"events"`
	NextSequence int64                        `json:"next_sequence"`
}

type payloadProjector func([]byte) ([]byte, error)

func projectDirectory(payload []byte) ([]byte, error) {
	return projectPayload[directorySource](payload)
}

func projectCurrentAccount(payload []byte) ([]byte, error) {
	return projectPayload[currentAccountResultSource](payload)
}

func projectDirectoryMember(payload []byte) ([]byte, error) {
	return projectPayload[directoryMemberSource](payload)
}

func projectMembershipResult(payload []byte) ([]byte, error) {
	return projectPayload[membershipResultSource](payload)
}

func projectStatus(payload []byte) ([]byte, error) {
	return projectPayload[statusSource](payload)
}

func projectOIDCProviderList(payload []byte) ([]byte, error) {
	return projectPayload[oidcProviderListSource](payload)
}

func projectOIDCProviderResult(payload []byte) ([]byte, error) {
	return projectPayload[oidcProviderResultSource](payload)
}

func projectSCIMTokenList(payload []byte) ([]byte, error) {
	return projectPayload[scimTokenListSource](payload)
}

func projectSCIMTokenIssue(payload []byte) ([]byte, error) {
	return projectPayload[scimTokenIssueSource](payload)
}

func projectModelProfile(payload []byte) ([]byte, error) {
	return projectPayload[modelProfileSource](payload)
}

func projectModelProfileList(payload []byte) ([]byte, error) {
	return projectPayload[modelProfileListSource](payload)
}

func projectTemplate(payload []byte) ([]byte, error) {
	var result templateSource
	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, fmt.Errorf("decode template response: %w", err)
	}
	for index := range result.Runtime.MCPServers {
		server := &result.Runtime.MCPServers[index]
		if server.Args == nil {
			server.Args = []string{}
		}
		if server.Env == nil {
			server.Env = map[string]string{}
		}
		for _, secret := range server.SecretEnv {
			if !secret.Set || !managedMCPFingerprint.MatchString(secret.Fingerprint) {
				return nil, fmt.Errorf("invalid managed MCP secret descriptor")
			}
		}
	}
	return encodeBrowserResponse(result)
}

func projectTemplateList(payload []byte) ([]byte, error) {
	var result templateListSource
	if err := json.Unmarshal(payload, &result); err != nil {
		return nil, fmt.Errorf("decode template inventory: %w", err)
	}
	for index := range result.Items {
		result.Items[index].Runtime.MCPServers = nil
	}
	return encodeBrowserResponse(result)
}

func projectAgent(payload []byte) ([]byte, error) {
	return projectPayload[agentProjectionSource](payload)
}

func projectAgentList(payload []byte) ([]byte, error) {
	return projectPayload[agentListSource](payload)
}

func projectOperation(payload []byte) ([]byte, error) {
	return projectPayload[operationProjectionSource](payload)
}

func projectAgentSkillPreparation(payload []byte) ([]byte, error) {
	return projectPayload[agentSkillPreparationSource](payload)
}

func projectCreateAgent(payload []byte) ([]byte, error) {
	return projectPayload[createAgentSource](payload)
}

func projectAgentEvent(payload []byte) ([]byte, error) {
	return projectPayload[agentEventProjectionSource](payload)
}

func projectAgentEventList(payload []byte) ([]byte, error) {
	return projectPayload[agentEventListSource](payload)
}

func projectPayload[T any](payload []byte) ([]byte, error) {
	var source T
	if err := json.Unmarshal(payload, &source); err != nil {
		return nil, fmt.Errorf("decode internal response: %w", err)
	}
	return encodeBrowserResponse(source)
}

func encodeBrowserResponse(source any) ([]byte, error) {
	projected, err := json.Marshal(source)
	if err != nil {
		return nil, fmt.Errorf("encode browser response: %w", err)
	}
	return projected, nil
}
