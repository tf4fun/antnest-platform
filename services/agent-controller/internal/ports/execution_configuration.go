package ports

import (
	"context"
	"errors"
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"
)

var ErrInvalidExecutionConfiguration = errors.New("invalid execution configuration")

const MaximumExecutionRevision int64 = 1<<53 - 1

// ExecutionSource is one consistent view of Controller-owned current records.
// Credentials are still sealed; no Session/Run selection enters this contract.
type ExecutionSource struct {
	OrganizationID       string
	Revision             int64
	Providers            []ProviderConnectionRecord
	ProviderObservations []domain.ProviderObservationSet
	Models               []ModelProfileRecord
	Agents               []ExecutionAgentSource
	OrganizationBudget   *domain.OrganizationBudget
}

type ExecutionAgentSource struct {
	OwnerAccessGranted    bool
	Agent                 AgentRecord
	Spec                  AgentSpecRecord
	RetainedSpec          AgentSpecRecord
	Authorization         domain.Authorization
	AuthorizationRevision int64
}

type ExecutionSnapshot struct {
	OrganizationID     string                     `json:"organization_id"`
	SchemaVersion      int                        `json:"schema_version,omitempty"`
	Revision           int64                      `json:"revision"`
	OrganizationBudget *domain.OrganizationBudget `json:"organization_budget,omitempty"`
	Providers          []ExecutionProvider        `json:"providers"`
	Models             []ExecutionModel           `json:"models"`
	Agents             []ExecutionAgent           `json:"agents"`
}

type ExecutionCredential struct {
	Method  string `json:"method,omitempty"`
	Secret  string `json:"secret,omitempty"`
	Ref     string `json:"ref,omitempty"`
	Version string `json:"version,omitempty"`
}

type ExecutionProvider struct {
	ConnectionID       string               `json:"connection_id"`
	ProviderKey        string               `json:"provider_key"`
	RequestProtocol    string               `json:"request_protocol"`
	BaseURL            string               `json:"base_url"`
	Enabled            bool                 `json:"enabled"`
	CredentialRevision string               `json:"credential_revision,omitempty"`
	Credential         *ExecutionCredential `json:"credential,omitempty"`
}

type ExecutionModel struct {
	domain.ModelParameters
	ModelProfileID      string                      `json:"model_profile_id"`
	ConnectionID        string                      `json:"connection_id"`
	DisplayName         string                      `json:"display_name"`
	Enabled             bool                        `json:"enabled"`
	ProviderTokenLimits *domain.ProviderTokenLimits `json:"provider_token_limits,omitempty"`
	SupportsTools       *bool                       `json:"supports_tools,omitempty"`
}

type ExecutionRuntime struct {
	RuntimeRevision    string             `json:"runtime_revision"`
	RuntimeExecutionID string             `json:"runtime_execution_id"`
	MCPEndpoint        string             `json:"mcp_endpoint"`
	ConnectionID       string             `json:"connection_id,omitempty"`
	Credential         *RuntimeCredential `json:"credential,omitempty"`
}

type ExecutionAgent struct {
	AgentID                 string                   `json:"agent_id"`
	PrincipalIDs            []string                 `json:"principal_ids"`
	AccessRevision          string                   `json:"access_revision"`
	AcceptingRuns           bool                     `json:"accepting_runs"`
	UnavailableReason       *string                  `json:"unavailable_reason"`
	OperationID             *string                  `json:"operation_id"`
	DefaultModelProfileID   string                   `json:"default_model_profile_id"`
	FallbackModelProfileIDs []string                 `json:"fallback_model_profile_ids,omitempty"`
	DefaultAuthorization    domain.Authorization     `json:"default_authorization"`
	AuthorizationRevision   int64                    `json:"authorization_revision"`
	AgentSpecRevision       *string                  `json:"agent_spec_revision"`
	ExecutionRevision       *string                  `json:"execution_revision"`
	SystemPrompt            string                   `json:"system_prompt"`
	ContextPolicyVersion    string                   `json:"context_policy_version"`
	SkillInstructions       []ExecutionSkill         `json:"skill_instructions"`
	MaxModelRequests        int                      `json:"max_model_requests"`
	Runtime                 *ExecutionRuntime        `json:"runtime"`
	ModelRetry              *domain.ModelRetryPolicy `json:"model_retry,omitempty"`
	Failover                string                   `json:"failover,omitempty"`
	RunBudget               *domain.RunBudget        `json:"run_budget,omitempty"`
}

type ExecutionSkill struct {
	SkillKey     string `json:"skill_key"`
	Version      string `json:"version"`
	Instructions string `json:"instructions"`
}

type ExecutionAcknowledgement struct {
	OrganizationID  string `json:"organization_id"`
	AppliedRevision int64  `json:"applied_revision"`
}

type AgentSettlementRequest struct {
	OrganizationID  string    `json:"organization_id"`
	AgentID         string    `json:"agent_id"`
	MinimumRevision int64     `json:"minimum_revision"`
	OperationID     string    `json:"operation_id"`
	Mode            string    `json:"mode"`
	DeadlineAt      time.Time `json:"deadline_at"`
}

type AgentSettlementResult struct {
	AppliedRevision int64  `json:"applied_revision"`
	Outcome         string `json:"outcome"`
}

const (
	ExecutionSettled                = "settled"
	ExecutionNotSettled             = "not_settled"
	ExecutionRuntimeBarrierRequired = "runtime_barrier_required"
)

type ExecutionClient interface {
	ApplyExecutionSnapshot(context.Context, ExecutionSnapshot) (ExecutionAcknowledgement, error)
	SettleAgent(context.Context, AgentSettlementRequest) (AgentSettlementResult, error)
}

type ExecutionV2Client interface {
	GetExecutionDigest(context.Context, string) (ExecutionDigest, error)
	ApplyExecutionDelta(context.Context, ExecutionDelta) (ExecutionAcknowledgement, error)
}
