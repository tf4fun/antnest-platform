package server

import (
	"encoding/json"
	"fmt"
)

type auditExecutionSnapshot struct {
	ProviderConnectionID     string              `json:"providerConnectionId,omitempty"`
	ModelProfileID           string              `json:"modelProfileId,omitempty"`
	ModelProfileRevision     *int64              `json:"modelProfileRevision,omitempty"`
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
	FallbackModels       []auditModelCandidate      `json:"fallbackModels,omitempty"`
	CompactionModel      *auditModelCandidate       `json:"compactionModel,omitempty"`
	Configuration        *auditSessionConfiguration `json:"configuration,omitempty"`
}

type auditModelCandidate struct {
	ModelProfileID       string          `json:"modelProfileId,omitempty"`
	ProviderConnectionID string          `json:"providerConnectionId,omitempty"`
	ModelProfileRevision *int64          `json:"modelProfileRevision,omitempty"`
	Model                *auditModelSpec `json:"model,omitempty"`
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
	if snapshot == nil {
		return json.Marshal(snapshot)
	}
	if !validOptionalModelRevision(snapshot.ModelProfileRevision) {
		return nil, fmt.Errorf("invalid model profile revision")
	}
	if snapshot.ExecutionSpec != nil {
		for _, candidate := range snapshot.ExecutionSpec.FallbackModels {
			if !validOptionalModelRevision(candidate.ModelProfileRevision) {
				return nil, fmt.Errorf("invalid model profile revision")
			}
		}
		if snapshot.ExecutionSpec.CompactionModel != nil &&
			!validOptionalModelRevision(snapshot.ExecutionSpec.CompactionModel.ModelProfileRevision) {
			return nil, fmt.Errorf("invalid model profile revision")
		}
	}
	return json.Marshal(snapshot)
}

func validOptionalModelRevision(revision *int64) bool {
	return revision == nil || (*revision >= 1 && *revision <= maximumSafeJSONInteger)
}
