package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestPublicProxyUpgradeKeepsGatewayHSTSPolicy(t *testing.T) {
	for _, origin := range []string{"https://antnest.example", "http://127.0.0.1:8090"} {
		t.Run(origin, func(t *testing.T) {
			upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				connection, err := upgrader.Upgrade(w, r, http.Header{"Strict-Transport-Security": []string{"max-age=0", "malicious"}})
				if err != nil {
					return
				}
				defer func() { _ = connection.Close() }()
				_ = connection.WriteMessage(websocket.TextMessage, []byte("proxied"))
			}))
			t.Cleanup(upstream.Close)
			sessions, err := session.NewManager(session.Config{Secure: true})
			if err != nil {
				t.Fatal(err)
			}
			h, err := NewHandler(Config{PublicOrigin: origin, AdminConsoleURL: upstream.URL, AgentUIURL: upstream.URL, AgentACPURL: upstream.URL, IdentityURL: upstream.URL}, Dependencies{Identity: &identityServiceStub{}, Agents: &agentServiceStub{}, Execution: &executionServiceStub{}, Sessions: sessions, HTTPClient: upstream.Client()})
			if err != nil {
				t.Fatal(err)
			}
			gateway := httptest.NewServer(h)
			t.Cleanup(gateway.Close)
			connection, response, err := websocket.DefaultDialer.Dial(strings.Replace(gateway.URL, "http:", "ws:", 1)+"/proxy-socket", nil)
			if response != nil && response.Body != nil {
				_ = response.Body.Close()
			}
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = connection.Close() }()
			values := response.Header.Values("Strict-Transport-Security")
			if strings.HasPrefix(origin, "https:") {
				if len(values) != 1 || values[0] != "max-age=31536000" {
					t.Fatalf("upgrade HSTS=%v", values)
				}
			} else if len(values) != 0 {
				t.Fatalf("HTTP upgrade inherited HSTS=%v", values)
			}
		})
	}
}
