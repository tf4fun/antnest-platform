package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/application"
)

func workspaceStateHandler(t *testing.T, queries AgentQueryService) http.Handler {
	t.Helper()
	endpoint, err := NewHandler(&catalogServiceStub{}, &lifecycleServiceStub{}, &runServiceStub{}, queries,
		&agentEventServiceStub{}, &networkPolicyServiceStub{}, func(context.Context) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	return endpoint
}

func TestWorkspaceStateHTTPContract(t *testing.T) {
	t.Parallel()
	queries := &agentQueryServiceStub{state: application.WorkspaceAgentState{AgentID: "agent-1", Availability: application.WorkspaceAgentBusy, AccessAllowed: true, AgentRevision: 3, ActiveSessionID: "session-1"}}
	endpoint := workspaceStateHandler(t, queries)
	compiler := compileControlSchema(t, filepath.Join(repositoryRoot(t), "contracts/agent-controller/control-api.schema.json"))
	schema, err := compiler.Compile(controlSchemaID + "#/$defs/workspace_agent_state")
	if err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{"", "/watch"} {
		response := httptest.NewRecorder()
		endpoint.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state"+suffix+"?organization_id=org-1&principal_id=user-1", nil))
		if response.Code != http.StatusOK {
			t.Fatalf("response=%d %s", response.Code, response.Body)
		}
		payload := response.Body.String()
		if suffix != "" {
			if strings.Contains(payload, "id:") || response.Header().Get("Content-Type") != "text/event-stream" {
				t.Fatalf("stream=%s headers=%v", payload, response.Header())
			}
			payload = strings.TrimSuffix(strings.TrimPrefix(payload, "event: workspace_state\ndata: "), "\n\n")
		}
		var value any
		if err := json.Unmarshal([]byte(payload), &value); err != nil {
			t.Fatal(err)
		}
		if err := schema.Validate(value); err != nil {
			t.Fatal(err)
		}
		if queries.stateInput != (application.WorkspaceStateInput{AgentID: "agent-1", OrganizationID: "org-1", PrincipalID: "user-1"}) {
			t.Fatalf("scope=%+v", queries.stateInput)
		}
	}
}

func TestWorkspaceStateHTTPRejectsInvalidScopeAndCursor(t *testing.T) {
	t.Parallel()
	for _, query := range []string{"", "organization_id=org-1", "organization_id=org-1&principal_id=", "organization_id=org-1&principal_id=user-1&principal_id=user-2", "organization_id=org-1&principal_id=user-1&after_sequence=1"} {
		for _, suffix := range []string{"", "/watch"} {
			queries := &agentQueryServiceStub{}
			response := httptest.NewRecorder()
			workspaceStateHandler(t, queries).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state"+suffix+"?"+query, nil))
			if response.Code != http.StatusBadRequest || queries.stateInput.AgentID != "" {
				t.Fatalf("query=%s response=%d scope=%+v", query, response.Code, queries.stateInput)
			}
		}
	}
}

func TestWorkspaceStateHTTPDoesNotCommitSuccessBeforeScopedRead(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		err    error
		status int
	}{{application.ErrAgentNotFound, http.StatusNotFound}, {errors.New("database unavailable"), http.StatusInternalServerError}} {
		response := httptest.NewRecorder()
		workspaceStateHandler(t, &agentQueryServiceStub{err: tc.err}).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state/watch?organization_id=org-1&principal_id=user-1", nil))
		if response.Code != tc.status || strings.Contains(response.Body.String(), "workspace_state") {
			t.Fatalf("response=%d %s", response.Code, response.Body)
		}
	}
}

func TestWorkspaceStateHTTPCancellationReleasesWatch(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	queries := &agentQueryServiceStub{watchState: func(ctx context.Context, emit application.WorkspaceStateEmitter) error {
		if err := emit(application.WorkspaceAgentState{AgentID: "agent-1", AccessAllowed: true, AgentRevision: 3, Availability: application.WorkspaceAgentReady}); err != nil {
			return err
		}
		cancel()
		<-ctx.Done()
		return ctx.Err()
	}}
	response := httptest.NewRecorder()
	workspaceStateHandler(t, queries).ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state/watch?organization_id=org-1&principal_id=user-1", nil).WithContext(ctx))
	if response.Code != http.StatusOK || strings.Count(response.Body.String(), "event: workspace_state") != 1 {
		t.Fatalf("response=%d %s", response.Code, response.Body)
	}
}

type workspaceFailWriter struct {
	*httptest.ResponseRecorder
	failure   string
	deadlines []time.Time
}

func (w *workspaceFailWriter) SetWriteDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	if w.failure == "deadline" && !deadline.IsZero() {
		return errors.New("deadline failed")
	}
	return nil
}

func (w *workspaceFailWriter) Write(payload []byte) (int, error) {
	if w.failure == "write" {
		return 0, errors.New("write failed")
	}
	return w.ResponseRecorder.Write(payload)
}

func (w *workspaceFailWriter) FlushError() error {
	if w.failure == "flush" {
		return errors.New("flush failed")
	}
	w.Flush()
	return nil
}

func TestWorkspaceStateHTTPWriteFailuresTerminateWithoutMixingProtocols(t *testing.T) {
	t.Parallel()
	for _, failure := range []string{"deadline", "write", "flush", "none"} {
		writer := &workspaceFailWriter{ResponseRecorder: httptest.NewRecorder(), failure: failure}
		emitterReturned := false
		queries := &agentQueryServiceStub{watchState: func(_ context.Context, emit application.WorkspaceStateEmitter) error {
			err := emit(application.WorkspaceAgentState{AgentID: "agent-1", Availability: application.WorkspaceAgentReady, AccessAllowed: true, AgentRevision: 3})
			emitterReturned = true
			if (err == nil) != (failure == "none") {
				t.Fatalf("%s error=%v", failure, err)
			}
			return err
		}}
		workspaceStateHandler(t, queries).ServeHTTP(writer, httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state/watch?organization_id=org-1&principal_id=user-1", nil))
		if !emitterReturned || len(writer.deadlines) < 2 || !writer.deadlines[0].IsZero() || writer.deadlines[1].IsZero() {
			t.Fatalf("%s deadlines=%v", failure, writer.deadlines)
		}
		if failure == "deadline" {
			if writer.Code != http.StatusInternalServerError {
				t.Fatalf("pre-write error status=%d", writer.Code)
			}
			continue
		}
		if strings.Contains(writer.Body.String(), "internal_error") {
			t.Fatalf("JSON appended to SSE: %s", writer.Body)
		}
		if failure == "none" && !writer.deadlines[len(writer.deadlines)-1].IsZero() {
			t.Fatal("idle deadline not reset")
		}
	}
}

func TestWorkspaceStateHTTPRejectsLastEventID(t *testing.T) {
	t.Parallel()
	response := httptest.NewRecorder()
	queries := &agentQueryServiceStub{}
	request := httptest.NewRequest(http.MethodGet, "/internal/workspace/agents/agent-1/state/watch?organization_id=org-1&principal_id=user-1", nil)
	request.Header.Set("Last-Event-ID", "3")
	workspaceStateHandler(t, queries).ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || queries.stateInput.AgentID != "" {
		t.Fatalf("response=%d scope=%+v", response.Code, queries.stateInput)
	}
}
