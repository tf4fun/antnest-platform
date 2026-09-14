package agentacp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

const readyWorkspaceJSON = `{"agent_id":"agent-1","availability":"ready","access_allowed":true,"configuration_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","unavailable_reason":null,"active_session_id":null}`
const busyWorkspaceJSON = `{"agent_id":"agent-1","availability":"busy","access_allowed":true,"configuration_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","unavailable_reason":null,"active_session_id":"session-1"}`
const revokedWorkspaceJSON = `{"agent_id":"agent-1","availability":"offline","access_allowed":false,"configuration_revision":null,"unavailable_reason":"access_denied","active_session_id":null}`

type stateTransport func(*http.Request) (*http.Response, error)

func (f stateTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func stateClient(t *testing.T, status int, kind, body string) *Client {
	t.Helper()
	client, err := NewClient("http://acp.internal", &http.Client{Transport: stateTransport(func(r *http.Request) (*http.Response, error) {
		requestBody, err := io.ReadAll(r.Body)
		if err != nil || string(requestBody) != "{}" || r.Method != http.MethodPost || r.URL.RawQuery != "" ||
			(r.URL.Path != "/rpc/agent-acp/get-agent-execution-state" && r.URL.Path != "/rpc/agent-acp/watch-agent-execution-state") {
			t.Errorf("upstream request=%s %s body=%s error=%v", r.Method, r.URL, requestBody, err)
		}
		for header, expected := range map[string]string{"X-Antnest-Agent-Id": "agent-1", "X-Antnest-Organization-Id": "org-1", "X-Antnest-Principal-Id": "user-1", "Content-Type": "application/json"} {
			if r.Header.Get(header) != expected || len(r.Header.Values(header)) != 1 {
				t.Errorf("scope %s=%q", header, r.Header.Values(header))
			}
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
	if !errors.Is(err, ErrInvalidWorkspaceState) || strings.Contains(err.Error(), "not exposed") {
		t.Fatalf("not found error=%v", err)
	}
}

func TestWorkspaceStateClientRejectsMalformedSnapshots(t *testing.T) {
	t.Parallel()
	for _, body := range []string{
		`{}`, `null`, readyWorkspaceJSON + "{}", strings.Replace(readyWorkspaceJSON, "agent-1", "other", 1),
		strings.Replace(readyWorkspaceJSON, "ready", "broken", 1), strings.Replace(readyWorkspaceJSON, `"access_allowed":true,`, "", 1),
		strings.Replace(readyWorkspaceJSON, `,"active_session_id":null`, "", 1),
		strings.Replace(readyWorkspaceJSON, `"configuration_revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"`, `"configuration_revision":null`, 1),
		strings.Replace(readyWorkspaceJSON, `,"unavailable_reason":null`, "", 1),
		strings.Replace(readyWorkspaceJSON, `"unavailable_reason":null`, `"unavailable_reason":"agent_unavailable"`, 1),
		strings.Replace(busyWorkspaceJSON, `"unavailable_reason":null`, `"unavailable_reason":"runtime_barrier_required"`, 1),
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

func TestWorkspaceStateAcceptsInitialDeniedSnapshot(t *testing.T) {
	t.Parallel()
	state, err := stateClient(t, 200, "application/json", revokedWorkspaceJSON).GetWorkspaceState(context.Background(), stateScope())
	if err != nil || state.AccessAllowed {
		t.Fatalf("state=%+v err=%v", state, err)
	}
	count := 0
	err = stateClient(t, 200, "text/event-stream", "event: workspace_state\ndata: "+revokedWorkspaceJSON+"\n\n").WatchWorkspaceState(context.Background(), stateScope(), func(s WorkspaceState) error {
		count++
		if s.AccessAllowed {
			t.Error("denied snapshot changed")
		}
		return nil
	})
	if err != nil || count != 1 {
		t.Fatalf("count=%d err=%v", count, err)
	}
}

func TestWorkspaceStateSourceFailureNeverEmitsIdle(t *testing.T) {
	t.Parallel()
	for _, prefix := range []string{"", "event: workspace_state\ndata: " + busyWorkspaceJSON + "\n\n"} {
		count := 0
		err := stateClient(t, 200, "text/event-stream", prefix+"event: workspace_error\ndata: {\"code\":\"execution_state_unavailable\",\"message\":\"private storage detail\",\"retryable\":true}\n\n").WatchWorkspaceState(context.Background(), stateScope(), func(s WorkspaceState) error {
			count++
			if s.Availability != "busy" {
				t.Errorf("failure invented state: %+v", s)
			}
			return nil
		})
		want := 0
		if prefix != "" {
			want = 1
		}
		if err == nil || count != want || strings.Contains(err.Error(), "private") {
			t.Fatalf("count=%d err=%v", count, err)
		}
	}
}

func TestWorkspaceScopeUsesHeaderSafeOpaqueIdentifiers(t *testing.T) {
	t.Parallel()
	for _, identifier := range []string{"agent+1", "user@example.org", "namespace/agent:1", strings.Repeat("a", 200)} {
		for _, field := range []string{"agent", "organization", "principal"} {
			scope := stateScope()
			switch field {
			case "agent":
				scope.AgentID = identifier
			case "organization":
				scope.OrganizationID = identifier
			case "principal":
				scope.PrincipalID = identifier
			}
			calls := 0
			client, err := NewClient("http://acp.internal", &http.Client{Transport: stateTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Header.Get("X-Antnest-Agent-Id") != scope.AgentID || r.Header.Get("X-Antnest-Organization-Id") != scope.OrganizationID || r.Header.Get("X-Antnest-Principal-Id") != scope.PrincipalID {
					t.Error("scope changed")
				}
				return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(strings.ReplaceAll(readyWorkspaceJSON, "agent-1", scope.AgentID)))}, nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.GetWorkspaceState(context.Background(), scope)
			if err != nil || calls != 1 {
				t.Fatalf("%s %q calls=%d error=%v", field, identifier, calls, err)
			}
		}
	}
}

func TestWorkspaceStateAcceptsAllProducerViews(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		availability    string
		session, reason *string
		allowed         bool
	}{
		{"ready", nil, nil, true},
		{"busy", stringValue("session-1"), nil, true},
		{"busy", nil, nil, true},
		{"busy", nil, stringValue("agent_unavailable"), true},
		{"busy", stringValue("session-1"), stringValue("agent_unavailable"), true},
		{"offline", nil, stringValue("agent_unavailable"), true},
		{"offline", nil, stringValue("runtime_barrier_required"), true},
		{"offline", nil, stringValue("access_denied"), false},
	} {
		revision := stringValue(strings.Repeat("a", 64))
		if !tc.allowed {
			revision = nil
		}
		expected := WorkspaceState{AgentID: "agent-1", Availability: tc.availability, AccessAllowed: tc.allowed, ConfigurationRevision: revision, ActiveSessionID: tc.session, UnavailableReason: tc.reason}
		encoded, err := json.Marshal(expected)
		if err != nil {
			t.Fatal(err)
		}
		state, err := stateClient(t, 200, "application/json", string(encoded)).GetWorkspaceState(context.Background(), stateScope())
		if err != nil {
			t.Fatalf("view=%s error=%v", encoded, err)
		}
		actual, err := json.Marshal(state)
		if err != nil || string(actual) != string(encoded) {
			t.Fatalf("state changed: %s err=%v", actual, err)
		}
		count := 0
		err = stateClient(t, 200, "text/event-stream", "event: workspace_state\ndata: "+string(encoded)+"\n\nevent: workspace_state\ndata: "+revokedWorkspaceJSON+"\n\n").WatchWorkspaceState(context.Background(), stateScope(), func(s WorkspaceState) error {
			if count == 0 {
				first, encodeErr := json.Marshal(s)
				if encodeErr != nil || string(first) != string(encoded) {
					t.Errorf("stream changed view: %s %v", first, encodeErr)
				}
			}
			count++
			return nil
		})
		want := 2
		if !tc.allowed {
			want = 1
		}
		if err != nil || count != want {
			t.Fatalf("view=%s frames=%d err=%v", encoded, count, err)
		}
	}
}

func TestWorkspaceScopeRejectsUnsafeHeadersBeforeSending(t *testing.T) {
	t.Parallel()
	for _, id := range []string{"", strings.Repeat("a", 201), " line", "line ", "line\nnext", "line\rnext", "line\x00next", "line\x1fnext", "line\x7fnext"} {
		for field := range 3 {
			scope := stateScope()
			switch field {
			case 0:
				scope.AgentID = id
			case 1:
				scope.OrganizationID = id
			case 2:
				scope.PrincipalID = id
			}
			client, err := NewClient("http://acp.internal", &http.Client{Transport: stateTransport(func(*http.Request) (*http.Response, error) {
				t.Error("invalid scope reached transport")
				return nil, errors.New("must not send")
			})})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.GetWorkspaceState(context.Background(), scope)
			if !errors.Is(err, ErrInvalidWorkspaceScope) {
				t.Fatalf("id=%q err=%v", id, err)
			}
		}
	}
}

func stringValue(value string) *string { return &value }
