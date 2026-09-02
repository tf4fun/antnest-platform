package server

import (
	"encoding/json"
	"fmt"
)

// Browser projections are allowlists. Adding a field to an internal RPC
// response never makes it public until the BFF deliberately projects it.
type directorySource struct {
	Users []struct {
		User struct {
			ID         string `json:"id"`
			SystemRole string `json:"system_role"`
			Active     bool   `json:"active"`
			CreatedAt  string `json:"created_at"`
			UpdatedAt  string `json:"updated_at"`
		} `json:"user"`
		Membership struct {
			ID             string `json:"id"`
			OrganizationID string `json:"organization_id"`
			UserID         string `json:"user_id"`
			Email          string `json:"email"`
			DisplayName    string `json:"display_name"`
			Role           string `json:"role"`
			Source         string `json:"source"`
			Active         bool   `json:"active"`
			CreatedAt      string `json:"created_at"`
			UpdatedAt      string `json:"updated_at"`
		} `json:"membership"`
	} `json:"users"`
	Groups []struct {
		ID          string `json:"id"`
		DisplayName string `json:"display_name"`
		Active      bool   `json:"active"`
	} `json:"groups"`
}

type modelProfileSource struct {
	ModelProfileID string          `json:"model_profile_id"`
	OrganizationID string          `json:"organization_id"`
	ProfileKey     string          `json:"profile_key"`
	DisplayName    string          `json:"display_name"`
	RevisionID     string          `json:"revision_id"`
	Revision       int64           `json:"revision"`
	Enabled        bool            `json:"enabled"`
	Model          json.RawMessage `json:"model"`
	CreatedAt      string          `json:"created_at"`
	UpdatedAt      string          `json:"updated_at"`
}

type modelProfileListSource struct {
	Items       []modelProfileSource `json:"items"`
	NextAfterID *string              `json:"next_after_id"`
}

type templateSource struct {
	TemplateID             string          `json:"template_id"`
	OrganizationID         string          `json:"organization_id"`
	TemplateKey            string          `json:"template_key"`
	Name                   string          `json:"name"`
	Revision               int64           `json:"revision"`
	ModelProfileRevisionID string          `json:"model_profile_revision_id"`
	SystemPrompt           string          `json:"system_prompt"`
	MaxModelRequests       int             `json:"max_model_requests"`
	ContextPolicyVersion   string          `json:"context_policy_version"`
	Runtime                json.RawMessage `json:"runtime"`
	SkillRefs              []string        `json:"skill_refs"`
	Enabled                bool            `json:"enabled"`
	CreatedAt              string          `json:"created_at"`
	UpdatedAt              string          `json:"updated_at"`
}

type templateListSource struct {
	Items       []templateSource `json:"items"`
	NextAfterID *string          `json:"next_after_id"`
}

type runtimeProjectionSource struct {
	RuntimeRevision string `json:"runtime_revision"`
}

type agentProjectionSource struct {
	AgentID                     string                   `json:"agent_id"`
	OrganizationID              string                   `json:"organization_id"`
	OwnerUserID                 string                   `json:"owner_user_id"`
	Name                        string                   `json:"name"`
	DesiredState                string                   `json:"desired_state"`
	LifecycleState              string                   `json:"lifecycle_state"`
	ExecutableExecutionRevision string                   `json:"executable_execution_revision,omitempty"`
	Runtime                     *runtimeProjectionSource `json:"runtime,omitempty"`
	ActiveOperationRequestID    string                   `json:"active_operation_request_id,omitempty"`
	FailureStage                string                   `json:"failure_stage,omitempty"`
	FailureCode                 string                   `json:"failure_code,omitempty"`
	AggregateSequence           int64                    `json:"aggregate_sequence"`
	CreatedAt                   string                   `json:"created_at"`
	UpdatedAt                   string                   `json:"updated_at"`
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
	AdmissionID        string `json:"admission_id,omitempty"`
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

func projectModelProfile(payload []byte) ([]byte, error) {
	return projectPayload[modelProfileSource](payload)
}

func projectModelProfileList(payload []byte) ([]byte, error) {
	return projectPayload[modelProfileListSource](payload)
}

func projectTemplate(payload []byte) ([]byte, error) {
	return projectPayload[templateSource](payload)
}

func projectTemplateList(payload []byte) ([]byte, error) {
	return projectPayload[templateListSource](payload)
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
	projected, err := json.Marshal(source)
	if err != nil {
		return nil, fmt.Errorf("encode browser response: %w", err)
	}
	return projected, nil
}
