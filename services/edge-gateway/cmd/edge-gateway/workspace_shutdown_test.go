package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"soft/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"soft/antnest-platform/services/edge-gateway/internal/identity"
	"soft/antnest-platform/services/edge-gateway/internal/server"
	"soft/antnest-platform/services/edge-gateway/internal/session"
	"soft/antnest-platform/services/edge-gateway/internal/telemetry"
)

func TestWorkspaceWatchStopsBeforeGatewayTelemetryShutdown(t *testing.T) {
	testReceiveShutdown(t, "/api/app/agents/agent-1/state/watch")
}

func TestHTTPReceiveStreamsStopBeforeGatewayTelemetryShutdown(t *testing.T) {
	for _, path := range []string{
		"/api/app/agents/agent-1/v1/acp",
		"/api/app/agents/agent-1/acp",
		"/api/admin/agents/agent-1/events/watch",
	} {
		t.Run(path, func(t *testing.T) { testReceiveShutdown(t, path) })
	}
}

func testReceiveShutdown(t *testing.T, path string) {
	t.Helper()
	upstreamStopped := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rpc/identity/resolve-access-token" {
			if _, err := io.WriteString(w, `{"principal":{"user_id":"user-1","organization_id":"org-1","membership_id":"member-1","system_role":"admin","active":true}}`); err != nil {
				t.Error(err)
			}
			return
		}
		if r.URL.Path == "/rpc/agent-controller/list-workspace-agents" {
			if _, err := io.WriteString(w, `{"agents":[{"agent_id":"agent-1","name":"One","availability":"ready","agent_access_subject":"test-subject"}],"next_cursor":null}`); err != nil {
				t.Error(err)
			}
			return
		}
		defer close(upstreamStopped)
		w.Header().Set("Content-Type", "text/event-stream")
		if _, err := io.WriteString(w, "event: workspace_state\ndata: {\"agent_id\":\"agent-1\",\"availability\":\"ready\",\"access_allowed\":true,\"agent_revision\":3,\"active_session_id\":null}\n\n"); err != nil {
			return
		}
		if err := http.NewResponseController(w).Flush(); err != nil {
			return
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	agents, err := agentcontroller.NewClient(upstream.URL, upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	identities, err := identity.NewClient(upstream.URL, upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.NewManager(session.Config{})
	if err != nil {
		t.Fatal(err)
	}
	h, err := server.NewHandler(server.Config{AdminConsoleURL: upstream.URL, AgentUIURL: upstream.URL, AgentACPURL: upstream.URL, IdentityURL: upstream.URL}, server.Dependencies{Identity: identities, Agents: agents, Sessions: sessions, HTTPClient: upstream.Client(), Logger: logger})
	if err != nil {
		t.Fatal(err)
	}
	handlerFinished := make(chan struct{})
	observed := telemetry.HTTPHandler(h, logger)
	lifecycle := newStreamLifecycle(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer close(handlerFinished)
		observed.ServeHTTP(w, r)
	}), logger)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	httpServer := &http.Server{Handler: lifecycle, ReadHeaderTimeout: time.Second}
	defer func() {
		if err := httpServer.Close(); err != nil {
			t.Error(err)
		}
	}()
	done := make(chan error, 1)
	go func() { done <- serveHTTP(ctx, httpServer, listener, lifecycle, time.Second) }()
	r, err := http.NewRequest(http.MethodGet, "http://"+listener.Addr().String()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(&http.Cookie{Name: session.AccessTokenCookieName, Value: "test-token"})
	r.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: "test-csrf"})
	r.Header.Set("Accept", "text/event-stream")
	r.Header.Set("Acp-Connection-Id", "test-connection")
	client := &http.Client{Timeout: 3 * time.Second}
	response, err := client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	if response.StatusCode != 200 {
		t.Fatalf("status=%d", response.StatusCode)
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("unclean shutdown: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("watch prevented shutdown")
	}
	select {
	case <-handlerFinished:
	default:
		t.Fatal("handler/trace not drained")
	}
	select {
	case <-upstreamStopped:
	case <-time.After(time.Second):
		t.Fatal("Controller receive not cancelled")
	}
}
