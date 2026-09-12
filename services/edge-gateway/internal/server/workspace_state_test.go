package server

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"soft/antnest-platform/services/edge-gateway/internal/telemetry"
)

func readyState() agentcontroller.WorkspaceState {
	return agentcontroller.WorkspaceState{AgentID: "agent-1", Availability: "ready", AccessAllowed: true, AgentRevision: 3}
}
func stateRequest(suffix string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/app/agents/agent-1/state"+suffix, nil)
	addSessionCookies(r, "token-1", "csrf-1")
	return r
}
func newStateHandler(t *testing.T, identity *identityServiceStub, agents *agentServiceStub, config Config) http.Handler {
	t.Helper()
	return newTestHandlerWithAgents(t, identity, agents, http.NotFoundHandler(), time.Now(), config)
}

func TestWorkspaceStateUsesAuthenticatedScope(t *testing.T) {
	t.Parallel()
	for _, suffix := range []string{"", "/watch"} {
		agents := &agentServiceStub{state: readyState()}
		principal := ordinaryPrincipal()
		h := newStateHandler(t, &identityServiceStub{resolvePrincipal: principal}, agents, Config{})
		r := stateRequest(suffix)
		r.Header.Set(HeaderUserID, "forged-user")
		r.Header.Set(HeaderOrganizationID, "forged-org")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 200 || agents.stateInput != (agentcontroller.WorkspaceStateInput{AgentID: "agent-1", OrganizationID: principal.OrganizationID, PrincipalID: principal.UserID}) {
			t.Fatalf("status=%d scope=%+v body=%s", w.Code, agents.stateInput, w.Body)
		}
		payload := w.Body.String()
		if suffix != "" {
			payload = strings.TrimSuffix(strings.TrimPrefix(payload, "event: workspace_state\ndata: "), "\n\n")
		}
		var fields map[string]any
		if err := json.Unmarshal([]byte(payload), &fields); err != nil || len(fields) != 5 {
			t.Fatalf("payload=%s error=%v", payload, err)
		}
	}
}

func TestWorkspaceStateRejectsBrowserScopeAndCrossOrigin(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"query", "origin", "cursor", "method"} {
		agents := &agentServiceStub{}
		r := stateRequest("/watch")
		switch kind {
		case "query":
			r.URL.RawQuery = "principal_id=other"
		case "origin":
			r.Header.Set("Origin", "https://evil.example")
		case "cursor":
			r.Header.Set("Last-Event-ID", "3")
		case "method":
			r.Method = http.MethodPost
		}
		w := httptest.NewRecorder()
		newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, Config{}).ServeHTTP(w, r)
		if w.Code < 400 || agents.stateInput.AgentID != "" {
			t.Fatalf("%s status=%d scope=%+v", kind, w.Code, agents.stateInput)
		}
	}
}

func TestWorkspaceStateAdmissionErrorsDoNotOpenStream(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"missing cookie", "inactive", "identity outage", "missing agent", "controller outage"} {
		id := &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}
		agents := &agentServiceStub{state: readyState()}
		r := stateRequest("/watch")
		status := http.StatusUnauthorized
		switch kind {
		case "missing cookie":
			r.Header.Del("Cookie")
		case "inactive":
			id.resolvePrincipal.Active = false
		case "identity outage":
			id.resolveErr = errors.New("private upstream detail")
			status = 503
		case "missing agent":
			agents.stateErr = agentcontroller.ErrAgentNotFound
			status = 404
		case "controller outage":
			agents.stateErr = errors.New("private upstream detail")
			status = 503
		}
		w := httptest.NewRecorder()
		newStateHandler(t, id, agents, Config{}).ServeHTTP(w, r)
		if w.Code != status || strings.Contains(w.Body.String(), "event:") || strings.Contains(w.Body.String(), "private") {
			t.Fatalf("%s response=%d %s", kind, w.Code, w.Body)
		}
		if kind == "identity outage" && len(w.Result().Cookies()) != 0 {
			t.Fatal("outage cleared cookies")
		}
	}
}

func TestWorkspaceStateRevalidatesIdentityBeforeForwardingUpdates(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"revoked", "different user", "different membership", "different organization", "outage"} {
		id := &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}
		agents := &agentServiceStub{watchState: func(_ context.Context, emit agentcontroller.WorkspaceStateEmitter) error {
			if err := emit(readyState()); err != nil {
				return err
			}
			switch kind {
			case "revoked":
				id.resolvePrincipal.Active = false
			case "different user":
				id.resolvePrincipal.UserID = "other"
			case "different membership":
				id.resolvePrincipal.MembershipID = "other"
			case "different organization":
				id.resolvePrincipal.OrganizationID = "other"
			case "outage":
				id.resolveErr = errors.New("unavailable")
			}
			state := readyState()
			state.Availability = "busy"
			return emit(state)
		}}
		w := httptest.NewRecorder()
		newStateHandler(t, id, agents, Config{}).ServeHTTP(w, stateRequest("/watch"))
		if w.Code != 200 || strings.Count(w.Body.String(), "event: workspace_state") != 1 || strings.Contains(w.Body.String(), "unavailable") {
			t.Fatalf("%s response=%d %s", kind, w.Code, w.Body)
		}
	}
}

func TestWorkspaceStateLeaseCancelsQuietUpstreamAndReleasesCapacity(t *testing.T) {
	t.Parallel()
	var deadline time.Time
	agents := &agentServiceStub{watchState: func(ctx context.Context, emit agentcontroller.WorkspaceStateEmitter) error {
		deadline, _ = ctx.Deadline()
		if err := emit(readyState()); err != nil {
			return err
		}
		<-ctx.Done()
		return ctx.Err()
	}}
	h := newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, Config{StreamLease: 30 * time.Millisecond}).(*handler)
	w := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(w, stateRequest("/watch"))
	if w.Code != 200 || deadline.IsZero() || time.Since(start) > time.Second || len(h.stateConnections) != 0 {
		t.Fatalf("response=%d deadline=%v capacity=%d", w.Code, deadline, len(h.stateConnections))
	}
}

func TestWorkspaceStateInitialSnapshotTimeoutIsBounded(t *testing.T) {
	t.Parallel()
	agents := &agentServiceStub{watchState: func(ctx context.Context, _ agentcontroller.WorkspaceStateEmitter) error {
		<-ctx.Done()
		return ctx.Err()
	}}
	h := newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, Config{}).(*handler)
	h.requestTimeout = 20 * time.Millisecond
	w := httptest.NewRecorder()
	start := time.Now()
	h.ServeHTTP(w, stateRequest("/watch"))
	if w.Code != 503 || time.Since(start) > time.Second || len(h.stateConnections) != 0 {
		t.Fatalf("status=%d capacity=%d", w.Code, len(h.stateConnections))
	}
}

func TestWorkspaceStateCapacityIsSeparateFromACP(t *testing.T) {
	t.Parallel()
	h := newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, &agentServiceStub{}, Config{}).(*handler)
	for range cap(h.stateConnections) {
		h.stateConnections <- struct{}{}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, stateRequest("/watch"))
	if w.Code != 503 || len(h.acpConnections) != 0 || len(h.acpMessages) != 0 {
		t.Fatalf("status=%d acp=%d messages=%d", w.Code, len(h.acpConnections), len(h.acpMessages))
	}
}

type failedStateFlush struct{ *httptest.ResponseRecorder }

func (*failedStateFlush) FlushError() error { return errors.New("socket flush failed") }

func TestWorkspaceStateObservedWriterPropagatesFlushFailure(t *testing.T) {
	t.Parallel()
	returned := false
	agents := &agentServiceStub{watchState: func(_ context.Context, emit agentcontroller.WorkspaceStateEmitter) error {
		err := emit(readyState())
		returned = true
		if err == nil {
			t.Error("trace response wrapper swallowed the flush error")
		}
		return err
	}}
	h := newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, Config{})
	w := &failedStateFlush{httptest.NewRecorder()}
	telemetry.HTTPHandler(h, slog.New(slog.NewTextHandler(io.Discard, nil))).ServeHTTP(w, stateRequest("/watch"))
	if !returned || strings.Contains(w.Body.String(), "workspace_unavailable") {
		t.Fatalf("returned=%t body=%s", returned, w.Body)
	}
}

func TestWorkspaceStateRejectsSameHostDifferentScheme(t *testing.T) {
	t.Parallel()
	for _, suffix := range []string{"", "/watch"} {
		for _, https := range []bool{false, true} {
			agents := &agentServiceStub{state: readyState()}
			r := stateRequest(suffix)
			origin := "https://" + r.Host
			if https {
				r.TLS = &tls.ConnectionState{}
				origin = "http://" + r.Host
			}
			r.Header.Set("Origin", origin)
			w := httptest.NewRecorder()
			newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, Config{}).ServeHTTP(w, r)
			if w.Code != 403 || agents.stateInput.AgentID != "" {
				t.Fatalf("origin=%s status=%d scope=%+v", origin, w.Code, agents.stateInput)
			}
		}
	}
}

func TestWorkspaceStateMachineContractMatchesPublicResponses(t *testing.T) {
	t.Parallel()
	payload, err := os.ReadFile("../../../../contracts/edge-gateway/session-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var contract struct {
		Version int `json:"version"`
		Routes  map[string]struct {
			Method   string   `json:"method"`
			Path     string   `json:"path"`
			Event    string   `json:"event"`
			Required []string `json:"response_required"`
		} `json:"routes"`
	}
	if err := json.Unmarshal(payload, &contract); err != nil {
		t.Fatal(err)
	}
	if contract.Version != 10 {
		t.Fatalf("version=%d", contract.Version)
	}
	for _, name := range []string{"workspace_state", "workspace_state_watch"} {
		route, ok := contract.Routes[name]
		if !ok || route.Method != http.MethodGet || len(route.Required) != 5 {
			t.Fatalf("missing state contract: %+v", route)
		}
		r := httptest.NewRequest(route.Method, strings.ReplaceAll(route.Path, "{agent_id}", "agent-1"), nil)
		addSessionCookies(r, "token-1", "csrf-1")
		w := httptest.NewRecorder()
		newStateHandler(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, &agentServiceStub{state: readyState()}, Config{}).ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("contract response=%d %s", w.Code, w.Body)
		}
		body := w.Body.String()
		if name == "workspace_state_watch" {
			if route.Event != "workspace_state" {
				t.Fatalf("event=%s", route.Event)
			}
			body = strings.TrimSuffix(strings.TrimPrefix(body, "event: "+route.Event+"\ndata: "), "\n\n")
		}
		var fields map[string]any
		if err := json.Unmarshal([]byte(body), &fields); err != nil {
			t.Fatal(err)
		}
		if len(fields) != len(route.Required) {
			t.Fatalf("response fields=%v", fields)
		}
		for _, key := range route.Required {
			if _, ok := fields[key]; !ok {
				t.Fatalf("missing field %s", key)
			}
		}
	}
}
