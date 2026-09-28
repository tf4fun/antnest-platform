package server

import "encoding/json"

type auditExecutionSnapshot struct {
	ProviderConnectionID     string              `json:"providerConnectionId,omitempty"`
	ModelProfileID           string              `json:"modelProfileId,omitempty"`
	ConfigurationRevision    *int64              `json:"configurationRevision,omitempty"`
	AgentSpecRevision        string              `json:"agentSpecRevision,omitempty"`
	ExecutionRevision        string              `json:"executionRevision,omitempty"`
	DeadlineAt               *string             `json:"deadlineAt,omitempty"`
	AgentExecutionSpecDigest string              `json:"agentExecutionSpecDigest,omitempty"`
	ExecutionSpec            *auditExecutionSpec `json:"executionSpec,omitempty"`
}

type auditExecutionSpec struct {
	SystemPrompt         *string                    `json:"systemPrompt,omitempty"`
	ContextPolicyVersion string                     `json:"contextPolicyVersion,omitempty"`
	MaxModelRequests     *int64                     `json:"maxModelRequests,omitempty"`
	Model                *auditModelSpec            `json:"model,omitempty"`
	Configuration        *auditSessionConfiguration `json:"configuration,omitempty"`
}

type auditModelSpec struct {
	Model           string             `json:"model,omitempty"`
	ContextWindow   *int64             `json:"contextWindow,omitempty"`
	MaxOutputTokens *int64             `json:"maxOutputTokens,omitempty"`
	Temperature     *float64           `json:"temperature,omitempty"`
	SupportsImages  *bool              `json:"supportsImages,omitempty"`
	SupportsAudio   *bool              `json:"supportsAudio,omitempty"`
	SupportsPDF     *bool              `json:"supportsPdf,omitempty"`
	Pricing         *auditModelPricing `json:"pricing,omitempty"`
}

type auditModelPricing struct {
	Currency             string   `json:"currency,omitempty"`
	InputPerMillion      *float64 `json:"inputPerMillion,omitempty"`
	OutputPerMillion     *float64 `json:"outputPerMillion,omitempty"`
	CacheReadPerMillion  *float64 `json:"cacheReadPerMillion,omitempty"`
	CacheWritePerMillion *float64 `json:"cacheWritePerMillion,omitempty"`
}

type auditSessionConfiguration struct {
	ModelProfileID        string              `json:"modelProfileId,omitempty"`
	AuthorizationRevision *int64              `json:"authorizationRevision,omitempty"`
	Authorization         *auditAuthorization `json:"authorization,omitempty"`
}

type auditAuthorization struct {
	Mode      string          `json:"mode"`
	ToolRules []auditToolRule `json:"toolRules"`
}

type auditToolRule struct {
	Source   string `json:"source"`
	SourceID string `json:"sourceId"`
	ToolName string `json:"toolName"`
	Decision string `json:"decision"`
}

func projectAuditExecutionSnapshot(payload []byte) ([]byte, error) {
	var snapshot *auditExecutionSnapshot
	if err := json.Unmarshal(payload, &snapshot); err != nil {
		return nil, err
	}
	return json.Marshal(snapshot)
}
