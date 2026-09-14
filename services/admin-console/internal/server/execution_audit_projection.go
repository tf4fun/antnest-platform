package server

import (
	"encoding/json"
	"fmt"
	"time"
)

type executionAuditSummary struct {
	RunID       string `json:"run_id"`
	SessionID   string `json:"session_id"`
	AgentID     string `json:"agent_id"`
	PrincipalID string `json:"principal_id"`
	State       string `json:"state"`
	CreatedAt   string `json:"created_at"`
	UpdatedAt   string `json:"updated_at"`
}

type executionAuditDetail struct {
	executionAuditSummary
	Input               json.RawMessage   `json:"input"`
	ExecutionSnapshot   json.RawMessage   `json:"execution_snapshot"`
	TerminalClass       *string           `json:"terminal_class"`
	ExecutorState       *string           `json:"executor_state"`
	ToolEffectState     *string           `json:"tool_effect_state"`
	StopReason          *string           `json:"stop_reason"`
	ErrorClass          *string           `json:"error_class"`
	UnknownEffectSource *string           `json:"unknown_effect_source,omitempty"`
	UsageMeasurements   []json.RawMessage `json:"usage_measurements"`
}

type executionAuditMessage struct {
	ID        string          `json:"id"`
	Sequence  int64           `json:"sequence"`
	Kind      string          `json:"kind"`
	Visible   *bool           `json:"visible"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"created_at"`
}

type executionAuditPermission struct {
	ToolCallID string          `json:"tool_call_id"`
	Request    json.RawMessage `json:"request"`
	Decision   *string         `json:"decision"`
	Reason     *string         `json:"reason"`
	CreatedAt  string          `json:"created_at"`
	DecidedAt  *string         `json:"decided_at"`
}

func (permission *executionAuditPermission) UnmarshalJSON(payload []byte) error {
	if err := requireAuditFields(payload, "decision", "reason", "decided_at"); err != nil {
		return err
	}
	type record executionAuditPermission
	return json.Unmarshal(payload, (*record)(permission))
}

func requireAuditFields(payload []byte, names ...string) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(payload, &fields); err != nil {
		return err
	}
	for _, name := range names {
		if _, exists := fields[name]; !exists {
			return fmt.Errorf("missing audit field %s", name)
		}
	}
	return nil
}

type executionAuditPage[T any] struct {
	Stream     string          `json:"stream,omitempty"`
	Items      []T             `json:"items"`
	NextCursor json.RawMessage `json:"next_cursor"`
}

func readExecutionAuditPage[T any](payload []byte) (executionAuditPage[T], error) {
	var page executionAuditPage[T]
	if err := json.Unmarshal(payload, &page); err != nil {
		return page, err
	}
	var cursor *string
	if page.Items == nil || len(page.Items) > maximumBrowserPageSize || len(page.NextCursor) == 0 ||
		json.Unmarshal(page.NextCursor, &cursor) != nil || (cursor != nil && *cursor == "") {
		return page, fmt.Errorf("invalid execution audit page")
	}
	return page, nil
}

func validExecutionAuditSummary(summary executionAuditSummary) bool {
	return summary.RunID != "" && summary.SessionID != "" && summary.AgentID != "" && summary.PrincipalID != "" &&
		summary.State != "" && summary.CreatedAt != "" && summary.UpdatedAt != ""
}

func projectExecutionAuditList(payload []byte) ([]byte, error) {
	page, err := readExecutionAuditPage[executionAuditSummary](payload)
	if err != nil {
		return nil, err
	}
	for _, item := range page.Items {
		if !validExecutionAuditSummary(item) {
			return nil, fmt.Errorf("incomplete execution audit summary")
		}
	}
	page.Stream = ""
	return json.Marshal(page)
}

func projectExecutionAuditDetail(payload []byte) ([]byte, error) {
	if err := requireAuditFields(payload, "terminal_class", "executor_state", "tool_effect_state", "stop_reason", "error_class"); err != nil {
		return nil, err
	}
	var detail executionAuditDetail
	if err := json.Unmarshal(payload, &detail); err != nil {
		return nil, err
	}
	if !validExecutionAuditSummary(detail.executionAuditSummary) || len(detail.Input) == 0 ||
		len(detail.ExecutionSnapshot) == 0 || detail.UsageMeasurements == nil {
		return nil, fmt.Errorf("incomplete execution audit detail")
	}
	snapshot, err := projectAuditExecutionSnapshot(detail.ExecutionSnapshot)
	if err != nil {
		return nil, err
	}
	detail.ExecutionSnapshot = snapshot
	return json.Marshal(detail)
}

func projectExecutionAuditEvents(payload []byte) ([]byte, error) {
	var envelope struct {
		Stream string `json:"stream"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return nil, err
	}
	switch envelope.Stream {
	case "execution":
		return projectExecutionAuditMessages(payload)
	case "permissions":
		return projectExecutionAuditPermissions(payload)
	default:
		return nil, fmt.Errorf("unknown execution audit stream")
	}
}

func projectExecutionAuditMessages(payload []byte) ([]byte, error) {
	page, err := readExecutionAuditPage[executionAuditMessage](payload)
	if err != nil {
		return nil, err
	}
	for _, item := range page.Items {
		if item.ID == "" || item.Sequence < 1 || item.Kind == "" || item.Visible == nil || len(item.Payload) == 0 || item.CreatedAt == "" {
			return nil, fmt.Errorf("incomplete execution audit event")
		}
	}
	return json.Marshal(page)
}

func projectExecutionAuditPermissions(payload []byte) ([]byte, error) {
	page, err := readExecutionAuditPage[executionAuditPermission](payload)
	if err != nil {
		return nil, err
	}
	for _, item := range page.Items {
		if item.ToolCallID == "" || len(item.Request) == 0 || item.CreatedAt == "" {
			return nil, fmt.Errorf("incomplete execution permission record")
		}
	}
	return json.Marshal(page)
}

type executionSynchronizationState struct {
	Revision        int64      `json:"revision"`
	AppliedRevision *int64     `json:"applied_revision"`
	UpdatedAt       time.Time  `json:"updated_at"`
	AppliedAt       *time.Time `json:"applied_at"`
}

func projectExecutionSynchronization(organizationID string) payloadProjector {
	return func(payload []byte) ([]byte, error) {
		var envelope struct {
			OrganizationID  string          `json:"organization_id"`
			Synchronization json.RawMessage `json:"synchronization"`
		}
		if err := json.Unmarshal(payload, &envelope); err != nil {
			return nil, err
		}
		if envelope.OrganizationID != organizationID || len(envelope.Synchronization) == 0 {
			return nil, fmt.Errorf("invalid synchronization scope or missing record")
		}
		var state *executionSynchronizationState
		if err := json.Unmarshal(envelope.Synchronization, &state); err != nil {
			return nil, err
		}
		if state != nil && !validSynchronizationState(*state) {
			return nil, fmt.Errorf("invalid configuration synchronization")
		}
		if state != nil {
			if err := requireAuditFields(envelope.Synchronization, "applied_at"); err != nil {
				return nil, err
			}
		}
		return json.Marshal(struct {
			Synchronization *executionSynchronizationState `json:"synchronization"`
		}{Synchronization: state})
	}
}

func validSynchronizationState(state executionSynchronizationState) bool {
	if state.Revision < 1 || state.Revision > 9007199254740991 || state.AppliedRevision == nil || *state.AppliedRevision < 0 ||
		*state.AppliedRevision > state.Revision || state.UpdatedAt.IsZero() {
		return false
	}
	if *state.AppliedRevision == 0 {
		return state.AppliedAt == nil
	}
	return state.AppliedAt != nil && !state.AppliedAt.IsZero()
}
