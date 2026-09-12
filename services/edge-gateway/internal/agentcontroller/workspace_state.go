package agentcontroller

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const maximumWorkspaceStateBytes = 64 << 10

var (
	ErrAgentNotFound         = errors.New("agent was not found")
	ErrInvalidWorkspaceState = errors.New("invalid workspace state response")
	ErrInvalidWorkspaceScope = errors.New("invalid workspace scope")
	workspaceIdentifier      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
)

type WorkspaceStateInput struct{ AgentID, OrganizationID, PrincipalID string }

type WorkspaceState struct {
	AgentID         string  `json:"agent_id"`
	Availability    string  `json:"availability"`
	AccessAllowed   bool    `json:"access_allowed"`
	AgentRevision   int64   `json:"agent_revision"`
	ActiveSessionID *string `json:"active_session_id"`
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
	state, err = decodeWorkspaceState(payload, input.AgentID)
	if err == nil && !state.AccessAllowed {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	return state, err
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
	if !workspaceIdentifier.MatchString(input.AgentID) || !workspaceIdentifier.MatchString(input.OrganizationID) || !workspaceIdentifier.MatchString(input.PrincipalID) {
		return nil, ErrInvalidWorkspaceScope
	}
	path := "/internal/workspace/agents/" + input.AgentID + "/state"
	kind := "application/json"
	if watch {
		path += "/watch"
		kind = "text/event-stream"
	}
	target := client.base.ResolveReference(&url.URL{Path: path, RawQuery: url.Values{"organization_id": {input.OrganizationID}, "principal_id": {input.PrincipalID}}.Encode()})
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, fmt.Errorf("create workspace state request: %w", err)
	}
	request.Header.Set("Accept", kind)
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
	if response.StatusCode == http.StatusNotFound {
		return nil, ErrAgentNotFound
	}
	return nil, ErrInvalidWorkspaceState
}

func decodeWorkspaceState(payload []byte, agentID string) (WorkspaceState, error) {
	var wire struct {
		AgentID         string          `json:"agent_id"`
		Availability    string          `json:"availability"`
		AccessAllowed   *bool           `json:"access_allowed"`
		AgentRevision   *int64          `json:"agent_revision"`
		ActiveSessionID json.RawMessage `json:"active_session_id"`
	}
	if len(payload) > maximumWorkspaceStateBytes {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&wire); err != nil {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	if decoder.Decode(&struct{}{}) != io.EOF || wire.AgentID != agentID || wire.AccessAllowed == nil || wire.AgentRevision == nil || *wire.AgentRevision < 1 || len(wire.ActiveSessionID) == 0 {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	state := WorkspaceState{AgentID: wire.AgentID, Availability: wire.Availability, AccessAllowed: *wire.AccessAllowed, AgentRevision: *wire.AgentRevision}
	if err := json.Unmarshal(wire.ActiveSessionID, &state.ActiveSessionID); err != nil {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	if !validWorkspaceState(state) {
		return WorkspaceState{}, ErrInvalidWorkspaceState
	}
	return state, nil
}

func validWorkspaceState(state WorkspaceState) bool {
	if state.ActiveSessionID != nil && (strings.TrimSpace(*state.ActiveSessionID) == "" || len(*state.ActiveSessionID) > 200) {
		return false
	}
	if !state.AccessAllowed {
		return state.Availability == "offline" && state.ActiveSessionID == nil
	}
	switch state.Availability {
	case "ready":
		return state.ActiveSessionID == nil
	case "busy", "offline":
		return true
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
		if frame.event != "" || value != "workspace_state" {
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
	seen := false
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
		if !seen && !state.AccessAllowed {
			return ErrInvalidWorkspaceState
		}
		if err := emit(state); err != nil {
			return err
		}
		if !state.AccessAllowed {
			return nil
		}
		seen = true
		frame = workspaceStateFrame{}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("read workspace stream: %w", err)
	}
	return io.ErrUnexpectedEOF
}
