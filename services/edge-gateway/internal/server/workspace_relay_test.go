package server

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/telemetry"
)

type relayIdentity struct {
	identityServiceStub
	mu        sync.Mutex
	principal identity.Principal
	failure   error
	calls     int
	blocked   bool
}

func (service *relayIdentity) Resolve(ctx context.Context, token string) (identity.Principal, error) {
	service.mu.Lock()
	service.calls++
	principal, failure, blocked := service.principal, service.failure, service.blocked
	service.mu.Unlock()
	if token != "original-browser-token" {
		return identity.Principal{}, errors.New("unexpected credential")
	}
	if blocked {
		<-ctx.Done()
		return identity.Principal{}, ctx.Err()
	}
	return principal, failure
}

func (service *relayIdentity) reject(principal identity.Principal, failure error, blocked bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	service.principal, service.failure, service.blocked = principal, failure, blocked
}

type relayFixture struct {
	client        *websocket.Conn
	identity      *relayIdentity
	received      chan []byte
	closed        chan struct{}
	upstreamClose chan int
	cancel        context.CancelFunc
}

func newRelayFixture(t *testing.T, version string, configure ...func(*handler)) *relayFixture {
	t.Helper()
	return newRelayFixtureWithExchange(t, version, nil, configure...)
}

func newRelayFixtureWithExchange(t *testing.T, version string, exchange func(*websocket.Conn), configure ...func(*handler)) *relayFixture {
	t.Helper()
	fixture := &relayFixture{
		identity: &relayIdentity{principal: ordinaryPrincipal()},
		received: make(chan []byte, 8), closed: make(chan struct{}), upstreamClose: make(chan int, 1),
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	acp := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/"+version+"/acp" || request.Header.Get("X-Antnest-Agent-Id") != "agent-1" || request.Header.Get("X-Antnest-Principal-Id") != "user-admin" || request.Header.Get(HeaderOrganizationID) != "org-1" || request.Header.Get(HeaderAgentAccessSubject) != "" ||
			request.Header.Get("Cookie") != "" || request.Header.Get("Authorization") != "" {
			t.Error("incorrect upstream route or credential boundary")
		}
		connection, err := upgrader.Upgrade(response, request, nil)
		if err != nil {
			return
		}
		defer close(fixture.closed)
		defer func() { _ = connection.Close() }()
		if exchange != nil {
			exchange(connection)
			return
		}
		for {
			kind, message, readErr := connection.ReadMessage()
			if readErr != nil {
				var closeErr *websocket.CloseError
				if errors.As(readErr, &closeErr) {
					fixture.upstreamClose <- closeErr.Code
				} else {
					fixture.upstreamClose <- 0
				}
				return
			}
			fixture.received <- message
			if err := connection.WriteMessage(kind, message); err != nil {
				return
			}
		}
	}))
	sessions, err := session.NewManager(session.Config{CSRFKey: []byte(testCSRFKey)})
	if err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	app, err := NewHandler(Config{
		AdminConsoleURL: acp.URL, AgentUIURL: acp.URL, AgentACPURL: acp.URL, IdentityURL: acp.URL,
		RequestTimeout: 200 * time.Millisecond,
	}, Dependencies{
		Execution: &executionServiceStub{}, Identity: fixture.identity, Agents: &agentServiceStub{listErr: context.DeadlineExceeded}, Sessions: sessions, HTTPClient: &http.Client{Transport: telemetry.NewHTTPTransport(acp.Client().Transport)}, Logger: logger,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, apply := range configure {
		apply(app.(*handler))
	}
	ctx, cancel := context.WithCancel(context.Background())
	fixture.cancel = cancel
	edge := httptest.NewUnstartedServer(telemetry.HTTPHandler(app, logger))
	edge.Config.BaseContext = func(net.Listener) context.Context { return ctx }
	edge.Start()
	t.Cleanup(func() {
		cancel()
		if fixture.client != nil {
			_ = fixture.client.Close()
		}
		edge.Close()
		acp.Close()
	})
	fixture.client, _, err = websocket.DefaultDialer.Dial(
		strings.Replace(edge.URL, "http://", "ws://", 1)+"/api/app/agents/agent-1/"+version+"/acp",
		http.Header{
			"Origin": {edge.URL}, "Cookie": {session.AccessTokenCookieName + "=original-browser-token; " + session.CSRFCookieName + "=csrf"},
			HeaderAgentAccessSubject: {"forged"}, "Authorization": {"Bearer forged"},
		})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func (fixture *relayFixture) roundTrip(t *testing.T, payload string) {
	t.Helper()
	if err := fixture.client.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.client.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	kind, echoed, err := fixture.client.ReadMessage()
	if err != nil || kind != websocket.TextMessage || string(echoed) != payload {
		t.Fatalf("opaque relay failed: kind=%d err=%v", kind, err)
	}
	<-fixture.received
}

func TestWorkspaceRelayRevalidatesEveryMessage(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			fixture := newRelayFixture(t, version)
			fixture.roundTrip(t, `{"jsonrpc":"2.0","id":1,"method":"session/list"}`)
			fixture.roundTrip(t, `not JSON: still opaque to Gateway`)
			fixture.identity.mu.Lock()
			calls := fixture.identity.calls
			fixture.identity.mu.Unlock()
			if calls != 3 {
				t.Fatalf("Identity calls=%d; want handshake and each message", calls)
			}
		})
	}
}

func TestWorkspaceRelayRejectsChangedSessionBeforeForwarding(t *testing.T) {
	for _, reason := range []string{"revoked", "inactive", "user", "organization", "membership", "unavailable", "timeout"} {
		t.Run(reason, func(t *testing.T) {
			fixture := newRelayFixture(t, "v1")
			fixture.roundTrip(t, "admitted")
			principal := ordinaryPrincipal()
			var failure error
			wantClose := websocket.ClosePolicyViolation
			switch reason {
			case "revoked":
				failure = &identity.RemoteError{StatusCode: 401, Code: "unauthenticated"}
			case "inactive":
				principal.Active = false
			case "user":
				principal.UserID = "other-user"
			case "organization":
				principal.OrganizationID = "other-organization"
			case "membership":
				principal.MembershipID = "other-membership"
			case "unavailable", "timeout":
				failure = errors.New("private dependency failure")
				wantClose = websocket.CloseTryAgainLater
			}
			fixture.identity.reject(principal, failure, reason == "timeout")
			if err := fixture.client.WriteMessage(websocket.TextMessage, []byte("must-not-forward")); err != nil {
				t.Fatal(err)
			}
			_, _, err := fixture.client.ReadMessage()
			if !websocket.IsCloseError(err, wantClose) {
				t.Fatalf("close=%v; want %d", err, wantClose)
			}
			select {
			case <-fixture.closed:
			case <-time.After(3 * time.Second):
				t.Fatal("upstream was not closed")
			}
			if len(fixture.received) != 0 {
				t.Fatal("rejected message reached ACP")
			}
		})
	}
}

func TestWorkspaceRelayClosesIdleSocketsOnShutdown(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			fixture := newRelayFixture(t, version)
			fixture.roundTrip(t, "admitted")
			fixture.cancel()
			if _, _, err := fixture.client.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseGoingAway) {
				t.Fatalf("shutdown must send going-away before socket close: %v", err)
			}
			select {
			case code := <-fixture.upstreamClose:
				if code != websocket.CloseGoingAway {
					t.Fatalf("upstream shutdown close=%d; want going-away", code)
				}
			case <-time.After(3 * time.Second):
				t.Fatal("shutdown leaked upstream")
			}
		})
	}
}

func TestWorkspaceRelayChecksAfterFinalFragmentAndDropsPipelinedMessages(t *testing.T) {
	fixture := newRelayFixture(t, "v2")
	fixture.roundTrip(t, "admitted")
	writer, err := fixture.client.NextWriter(websocket.TextMessage)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := writer.Write([]byte(strings.Repeat("a", 8192))); err != nil {
		t.Fatal(err)
	}
	fixture.identity.reject(ordinaryPrincipal(), &identity.RemoteError{Code: "unauthenticated"}, false)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	_ = fixture.client.WriteMessage(websocket.TextMessage, []byte("also-denied"))
	if _, _, err := fixture.client.ReadMessage(); !websocket.IsCloseError(err, websocket.ClosePolicyViolation) {
		t.Fatalf("fragmented rejection=%v", err)
	}
	select {
	case <-fixture.closed:
	case <-time.After(3 * time.Second):
		t.Fatal("upstream was not closed")
	}
	if len(fixture.received) != 0 {
		t.Fatal("partial or queued message reached ACP")
	}
}

func TestWorkspaceRelayCapacityWaitDoesNotAuthorizeOrForward(t *testing.T) {
	fixture := newRelayFixture(t, "v1", func(h *handler) {
		h.acpMessages = make(chan struct{}, 1)
		h.acpMessages <- struct{}{}
	})
	if err := fixture.client.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := fixture.client.WriteMessage(websocket.TextMessage, []byte("capacity-denied")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := fixture.client.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseTryAgainLater) {
		t.Fatalf("capacity rejection=%v", err)
	}
	fixture.identity.mu.Lock()
	calls := fixture.identity.calls
	fixture.identity.mu.Unlock()
	if calls != 1 || len(fixture.received) != 0 {
		t.Fatalf("capacity rejection performed work: calls=%d", calls)
	}
}

func TestWorkspaceRelayPreservesBinaryAndEmptyMessages(t *testing.T) {
	fixture := newRelayFixture(t, "v2")
	for _, payload := range [][]byte{{0, 255, 1}, {}} {
		if err := fixture.client.WriteMessage(websocket.BinaryMessage, payload); err != nil {
			t.Fatal(err)
		}
		if err := fixture.client.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			t.Fatal(err)
		}
		kind, echoed, err := fixture.client.ReadMessage()
		if err != nil || kind != websocket.BinaryMessage || string(echoed) != string(payload) {
			t.Fatalf("binary relay changed message: kind=%d err=%v", kind, err)
		}
		<-fixture.received
	}
}

func TestWorkspaceRelayConnectionCapacityRejectsBeforeIdentity(t *testing.T) {
	var gateway *handler
	fixture := newRelayFixture(t, "v1", func(h *handler) {
		h.acpConnections = make(chan struct{}, 1)
		gateway = h
	})
	request := httptest.NewRequest(http.MethodGet, "http://gateway.test/api/app/agents/agent-1/v1/acp", nil)
	request.Header.Set("Origin", "http://gateway.test")
	request.Header.Set("Connection", "Upgrade")
	request.Header.Set("Upgrade", "websocket")
	response := httptest.NewRecorder()
	gateway.ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("capacity status=%d", response.Code)
	}
	fixture.identity.mu.Lock()
	defer fixture.identity.mu.Unlock()
	if fixture.identity.calls != 1 {
		t.Fatal("capacity denial consumed Identity resources")
	}
}
