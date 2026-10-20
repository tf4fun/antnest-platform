package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/server"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

func TestWorkspaceBridgeEventsStopBeforeGatewayTelemetryShutdown(t *testing.T) {
	// Exercise escaped routing with a public ID accepted by Identity. A decoded
	// slash is outside that contract and is rejected before a stream can open.
	for _, path := range []string{"/api/app/workspace/v1/agents/agent-1/events", "/api/app/workspace/v1/agents/agent%2D1/events"} {
		t.Run(path, func(t *testing.T) { testReceiveShutdown(t, path) })
	}
}

func TestHTTPReceiveStreamsStopBeforeGatewayTelemetryShutdown(t *testing.T) {
	for _, path := range []string{
		"/api/admin/agents/agent-1/events/watch",
	} {
		t.Run(path, func(t *testing.T) { testReceiveShutdown(t, path) })
	}
}

func testReceiveShutdown(t *testing.T, path string) {
	t.Helper()
	now := time.Now()
	expiresAt := now.Add(time.Hour).Format(time.RFC3339Nano)
	idleExpiresAt := now.Add(30 * time.Minute).Format(time.RFC3339Nano)
	parts := strings.Split(path, "/")
	agentIndex := 4
	if strings.HasPrefix(path, "/api/app/workspace/v1/") {
		agentIndex = 6
	}
	agentID, err := url.PathUnescape(parts[agentIndex])
	if err != nil {
		t.Fatal(err)
	}
	upstreamStopped := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/rpc/identity/resolve-access-token" {
			if _, err := io.WriteString(w, `{"caller_context":"`+testIssuerContext(t)+`","expires_at":"`+expiresAt+`","idle_expires_at":"`+idleExpiresAt+`","activity_interval_ms":30000,"principal":{"user_id":"user-1","organization_id":"org-1","organization_slug":"engineering","organization_name":"Engineering","membership_id":"member-1","system_role":"admin","active":true}}`); err != nil {
				t.Error(err)
			}
			return
		}
		defer close(upstreamStopped)
		w.Header().Set("Content-Type", "text/event-stream")
		if strings.HasPrefix(path, "/api/app/workspace/v1/") && r.Header.Get(server.HeaderAgentID) != agentID {
			t.Errorf("Bridge Agent scope=%q want=%q", r.Header.Get(server.HeaderAgentID), agentID)
		}
		if _, err := io.WriteString(w, "event: reset\ndata: {}\n\n"); err != nil {
			return
		}

		if err := http.NewResponseController(w).Flush(); err != nil {
			return
		}
		<-r.Context().Done()
	}))
	defer upstream.Close()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	identities, err := identity.NewClient(upstream.URL, upstream.Client())
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := session.NewManager(session.Config{CSRFKey: []byte("0123456789abcdef0123456789abcdef")})
	if err != nil {
		t.Fatal(err)
	}
	h, err := server.NewHandler(server.Config{AdminConsoleURL: upstream.URL, AgentUIURL: upstream.URL, IdentityURL: upstream.URL}, server.Dependencies{Identity: identities, Sessions: sessions, HTTPClient: upstream.Client(), Logger: logger})
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
	serverStopped := make(chan struct{})
	go func() {
		defer close(serverStopped)
		done <- serveHTTP(ctx, httpServer, listener, lifecycle, time.Second)
	}()
	defer func() { cancel(); _ = httpServer.Close(); awaitGatewaySignal(t, serverStopped) }()
	r, err := http.NewRequest(http.MethodGet, "http://"+listener.Addr().String()+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	r.AddCookie(&http.Cookie{Name: session.AccessTokenCookieName, Value: "test-token"})
	r.AddCookie(&http.Cookie{Name: session.CSRFCookieName, Value: "test-csrf"})
	r.Header.Set("Accept", "text/event-stream")
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
		t.Fatal("SSE upstream receive not cancelled")
	}
}

func testIssuerContext(t *testing.T) string {
	t.Helper()
	now := time.Now().Unix()
	body, _ := json.Marshal(map[string]any{"sid": "token-1", "iat": now, "exp": now + 60})
	return base64.RawURLEncoding.EncodeToString([]byte(`{"typ":"antnest-cct+jwt","alg":"EdDSA","kid":"test"}`)) + "." + base64.RawURLEncoding.EncodeToString(body) + "." + base64.RawURLEncoding.EncodeToString(make([]byte, 64))
}
