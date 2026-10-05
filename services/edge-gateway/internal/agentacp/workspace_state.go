package agentacp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maximumWorkspaceStateBytes = 64 << 10

var (
	ErrInvalidWorkspaceState = errors.New("invalid workspace state response")
	ErrInvalidWorkspaceScope = errors.New("invalid workspace scope")
	configurationRevision    = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

type WorkspaceStateInput struct{ AgentID, OrganizationID, PrincipalID string }

type WorkspaceState struct {
	AgentID               string  `json:"agent_id"`
	Availability          string  `json:"availability"`
	AccessAllowed         bool    `json:"access_allowed"`
	ConfigurationRevision *string `json:"configuration_revision"`
	UnavailableReason     *string `json:"unavailable_reason"`
	ActiveSessionID       *string `json:"active_session_id"`
}

type WorkspaceStateEmitter func(WorkspaceState) error

func (client *Client) GetWorkspaceState(ctx context.Context, input WorkspaceStateInput) (state WorkspaceState, resultErr error) {
	response, err := client.workspaceStateRequest(ctx, input, false)
	if err != nil {
		return state, err
	}
	defer func() { _ = response.Body.Close() }()
	payload, err := io.ReadAll(io.LimitReader(response.Body, maximumWorkspaceStateBytes+1))
	if err != nil {
		return state, fmt.Errorf("read workspace state: %w", err)
	}
	return decodeWorkspaceState(payload, input.AgentID)
}

func (client *Client) WatchWorkspaceState(ctx context.Context, input WorkspaceStateInput, emit WorkspaceStateEmitter) (resultErr error) {
	if emit == nil {
		return fmt.Errorf("workspace state emitter is required")
	}
	response, err := client.workspaceStateRequest(ctx, input, true)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	return readWorkspaceStates(response.Body, input.AgentID, emit)
}

func (client *Client) workspaceStateRequest(ctx context.Context, input WorkspaceStateInput, watch bool) (*http.Response, error) {
	if !validWorkspaceIdentifier(input.AgentID) || !validWorkspaceIdentifier(input.OrganizationID) || !validWorkspaceIdentifier(input.PrincipalID) {
		return nil, ErrInvalidWorkspaceScope
	}
	path := "/rpc/agent-acp/get-agent-execution-state"
	kind := "application/json"
	if watch {
		path = "/rpc/agent-acp/watch-agent-execution-state"
		kind = "text/event-stream"
	}
	target := client.base.ResolveReference(&url.URL{Path: path})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), strings.NewReader("{}"))
	if err != nil {
		return nil, fmt.Errorf("create workspace state request: %w", err)
	}
	request.Header.Set("Accept", kind)
	request.Header.Set("Content-Type", "application/json")
	identity.ForwardCallerContext(ctx, request.Header)
	request.Header.Set("X-Antnest-Organization-Id", input.OrganizationID)
	request.Header.Set("X-Antnest-Principal-Id", input.PrincipalID)
	request.Header.Set("X-Antnest-Agent-Id", input.AgentID)
	transport := *client.httpClient
	transport.Jar = nil
	transport.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := transport.Do(request)
	if err != nil {
		return nil, fmt.Errorf("workspace state unavailable: %w", err)
	}
	if response.StatusCode == http.StatusOK {
		mediaType, _, err := mime.ParseMediaType(response.Header.Get("Content-Type"))
		if err == nil && mediaType == kind {
			return response, nil
		}
	}
	_ = response.Body.Close()
	return nil, ErrInvalidWorkspaceState
}

func decodeWorkspaceState(payload []byte, agentID string) (WorkspaceState, error) {
	var wire struct {
		AgentID               string          `json:"agent_id"`
		Availability          string          `json:"availability"`
		AccessAllowed         *bool           `json:"access_allowed"`
		ConfigurationRevision json.RawMessage `json:"configuration_revision"`
		ActiveSessionID       json.RawMessage `json:"active_session_id"`
		UnavailableReason     json.RawMessage `json:"unavailable_reason"`
	}
	if len(payload) > maximumWorkspaceStateBytes {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	if decoder.Decode(&struct{}{}) != io.EOF || wire.AgentID != agentID || wire.AccessAllowed == nil {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	state := WorkspaceState{AgentID: wire.AgentID, Availability: wire.Availability, AccessAllowed: *wire.AccessAllowed}
	for _, field := range []struct {
		raw    json.RawMessage
		target **string
	}{
		{wire.ConfigurationRevision, &state.ConfigurationRevision},
		{wire.ActiveSessionID, &state.ActiveSessionID},
		{wire.UnavailableReason, &state.UnavailableReason},
	} {
		if len(field.raw) == 0 || json.Unmarshal(field.raw, field.target) != nil {
			return WorkspaceState{}, ErrInvalidWorkspaceState
		}
	}
	if !validWorkspaceState(state) {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	return state, nil
}

func validWorkspaceState(state WorkspaceState) bool {
	if !state.AccessAllowed {
		return state.Availability == "offline" && state.ActiveSessionID == nil && state.ConfigurationRevision == nil &&
			state.UnavailableReason != nil && *state.UnavailableReason == "access_denied"
	}
	if state.ConfigurationRevision == nil || !configurationRevision.MatchString(*state.ConfigurationRevision) {
		return false
	}
	if state.ActiveSessionID != nil && (strings.TrimSpace(*state.ActiveSessionID) == "" || len(*state.ActiveSessionID) > 200) {
		return false
	}
	switch state.Availability {
	case "ready":
		return state.ActiveSessionID == nil && state.UnavailableReason == nil
	case "busy":
		return state.UnavailableReason == nil || *state.UnavailableReason == "agent_unavailable"
	case "offline":
		return state.ActiveSessionID == nil && state.UnavailableReason != nil &&
			(*state.UnavailableReason == "agent_unavailable" || *state.UnavailableReason == "runtime_barrier_required")
	default:
		return false
	}
}

type workspaceStateFrame struct {
	event string
	data  []byte
}

func (frame *workspaceStateFrame) add(line string) error {
	if strings.HasPrefix(line, ":") {
		return nil
	}
	field, value, ok := strings.Cut(line, ":")
	if !ok {
		return ErrInvalidWorkspaceState
	}
	value = strings.TrimPrefix(value, " ")
	switch field {
	case "event":
		if frame.event != "" || (value != "workspace_state" && value != "workspace_error") {
			return ErrInvalidWorkspaceState
		}
		frame.event = value
	case "data":
		if len(frame.data)+len(value)+1 > maximumWorkspaceStateBytes {
			return ErrInvalidWorkspaceState
		}
		frame.data = append(frame.data, value...)
		frame.data = append(frame.data, '\n')
	default:
		return ErrInvalidWorkspaceState
	}
	return nil
}

func readWorkspaceStates(reader io.Reader, agentID string, emit WorkspaceStateEmitter) error {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4096), maximumWorkspaceStateBytes)
	frame := workspaceStateFrame{}
	for scanner.Scan() {
		if line := scanner.Text(); line != "" {
			if err := frame.add(line); err != nil {
				return err
			}
			continue
		}
		if frame.event == "" && len(frame.data) == 0 {
			continue
		}
		if frame.event != "workspace_state" {
			return ErrInvalidWorkspaceState
		}
		state, err := decodeWorkspaceState(frame.data, agentID)
		if err != nil {
			return err
		}
		if err := emit(state); err != nil {
			return err
		}
		if !state.AccessAllowed {
			return nil
		}
		frame = workspaceStateFrame{}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read workspace stream: %w", err)
	}
	return io.ErrUnexpectedEOF
}

func validWorkspaceIdentifier(value string) bool {
	if value == "" || utf8.RuneCountInString(value) > 200 || !utf8.ValidString(value) || strings.TrimSpace(value) != value {
		return false
	}
	for _, char := range value {
		if char < 0x20 || char == 0x7f {
			return false
		}
	}
	return true
}
