package agentcontroller

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const readyWorkspaceJSON = `{"agent_id":"agent-1","availability":"ready","access_allowed":true,"agent_revision":3,"active_session_id":null}`
const busyWorkspaceJSON = `{"agent_id":"agent-1","availability":"busy","access_allowed":true,"agent_revision":3,"active_session_id":"session-1"}`
const revokedWorkspaceJSON = `{"agent_id":"agent-1","availability":"offline","access_allowed":false,"agent_revision":3,"active_session_id":null}`

type stateTransport func(*http.Request) (*http.Response, error)

func (f stateTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func stateClient(t *testing.T, status int, kind, body string) *Client {
	t.Helper()
	client, err := NewClient("http://controller.internal", &http.Client{Transport: stateTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Query().Get("organization_id") != "org-1" || r.URL.Query().Get("principal_id") != "user-1" || !strings.HasPrefix(r.URL.Path, "/internal/workspace/agents/agent-1/state") || r.Method != http.MethodGet {
			t.Errorf("upstream scope=%s %s", r.Method, r.URL)
		}
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {kind}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	})})
	if err != nil {
		t.Fatal(err)
	}
	return client
}

func stateScope() WorkspaceStateInput {
	return WorkspaceStateInput{AgentID: "agent-1", OrganizationID: "org-1", PrincipalID: "user-1"}
}

func TestWorkspaceStateClientValidatesSnapshot(t *testing.T) {
	t.Parallel()
	state, err := stateClient(t, 200, "application/json", busyWorkspaceJSON).GetWorkspaceState(context.Background(), stateScope())
	if err != nil || !state.AccessAllowed || state.ActiveSessionID == nil || *state.ActiveSessionID != "session-1" {
		t.Fatalf("state=%+v error=%v", state, err)
	}
	_, err = stateClient(t, 404, "application/json", `{"secret":"not exposed"}`).GetWorkspaceState(context.Background(), stateScope())
	if !errors.Is(err, ErrAgentNotFound) || strings.Contains(err.Error(), "not exposed") {
		t.Fatalf("not found error=%v", err)
	}
}

func TestWorkspaceStateClientRejectsMalformedSnapshots(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`{}`, `null`, readyWorkspaceJSON + "{}", strings.Replace(readyWorkspaceJSON, "agent-1", "other", 1),
		strings.Replace(readyWorkspaceJSON, "ready", "broken", 1), strings.Replace(readyWorkspaceJSON, `"access_allowed":true,`, "", 1),
		strings.Replace(readyWorkspaceJSON, `,"active_session_id":null`, "", 1),
		strings.Replace(readyWorkspaceJSON, `"agent_revision":3`, `"agent_revision":0`, 1),
		strings.Replace(revokedWorkspaceJSON, `"active_session_id":null`, `"active_session_id":"private"`, 1),
		strings.Replace(readyWorkspaceJSON, "}", `,"agent_access_subject":"private"}`, 1),
	} {
		_, err := stateClient(t, 200, "application/json", body).GetWorkspaceState(context.Background(), stateScope())
		if err == nil || strings.Contains(err.Error(), "private") {
			t.Fatalf("invalid snapshot accepted or leaked: %v", err)
		}
	}
}

func TestWorkspaceStateClientEmitsCompleteFramesAndStopsAtRevocation(t *testing.T) {
	t.Parallel()
	body := ": comment\r\nevent: workspace_state\r\ndata: " + readyWorkspaceJSON + "\r\n\r\nevent: workspace_state\ndata: " + busyWorkspaceJSON + "\n\nevent: workspace_state\ndata: " + revokedWorkspaceJSON + "\n\nevent: workspace_state\ndata: " + readyWorkspaceJSON + "\n\n"
	var states []WorkspaceState
	err := stateClient(t, 200, "text/event-stream", body).WatchWorkspaceState(context.Background(), stateScope(), func(s WorkspaceState) error { states = append(states, s); return nil })
	if err != nil || len(states) != 3 || states[2].AccessAllowed {
		t.Fatalf("states=%+v error=%v", states, err)
	}
}

func TestWorkspaceStateClientRejectsInvalidStreams(t *testing.T) {
	t.Parallel()
	for _, body := range []string{"", "event: workspace_state\ndata: " + readyWorkspaceJSON, "event: private\ndata: " + readyWorkspaceJSON + "\n\n", "id: 3\nevent: workspace_state\ndata: " + readyWorkspaceJSON + "\n\n", "event: workspace_state\ndata: {}\n\n", "event: workspace_state\ndata: " + strings.Repeat("x", 70<<10) + "\n\n"} {
		emits := 0
		err := stateClient(t, 200, "text/event-stream", body).WatchWorkspaceState(context.Background(), stateScope(), func(WorkspaceState) error { emits++; return nil })
		if err == nil || emits != 0 {
			t.Fatalf("emits=%d error=%v", emits, err)
		}
	}
}
