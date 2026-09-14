package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestACPHTTPRoutesWithoutControllerAndOverwritesIdentity(t *testing.T) {
	t.Parallel()
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodDelete} {
		t.Run(method, func(t *testing.T) {
			agents := &agentServiceStub{listErr: context.DeadlineExceeded}
			calls := 0
			expected := `{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"Agent unavailable"}}`
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/v1/acp" || r.Method != method {
					t.Errorf("unexpected transport: %s %s", r.Method, r.URL.Path)
				}
				principal := ordinaryPrincipal()
				for header, value := range map[string]string{
					"X-Antnest-Organization-Id": principal.OrganizationID,
					"X-Antnest-Principal-Id":    principal.UserID,
					"X-Antnest-Agent-Id":        "agent-unavailable",
					"Acp-Connection-Id":         "connection-1", "Acp-Session-Id": "session-1",
				} {
					if r.Header.Get(header) != value || len(r.Header.Values(header)) != 1 {
						t.Errorf("%s=%q", header, r.Header.Values(header))
					}
				}
				for _, header := range []string{"X-Antnest-Agent-Access-Subject", "X-Antnest-User-Id", "Cookie", "Authorization"} {
					if r.Header.Get(header) != "" {
						t.Errorf("untrusted %s forwarded", header)
					}
				}
				if method == http.MethodPost {
					body, err := io.ReadAll(r.Body)
					if err != nil || string(body) != `{"jsonrpc":"2.0","id":1,"method":"session/prompt"}` {
						t.Errorf("protocol payload changed: %s %v", body, err)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				w.Header().Set("Acp-Connection-Id", "connection-1")
				_, _ = io.WriteString(w, expected)
			})
			h := newTestHandlerWithAgents(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}, agents, upstream, time.Now(), Config{})
			r := httptest.NewRequest(method, "/api/app/agents/agent-unavailable/v1/acp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"session/prompt"}`))
			addSessionCookies(r, "token-1", "csrf-1")
			r.Header.Set("X-Antnest-CSRF-Token", "csrf-1")
			r.Header.Set("Content-Type", "application/json")
			for _, header := range []string{"X-Antnest-Organization-Id", "X-Antnest-Principal-Id", "X-Antnest-Agent-Id", "X-Antnest-User-Id", "X-Antnest-Agent-Access-Subject"} {
				r.Header.Add(header, "forged")
				r.Header.Add(header, "duplicate-forged")
			}
			r.Header.Set("Authorization", "Bearer forbidden-browser-token")
			r.Header.Set("Acp-Connection-Id", "connection-1")
			r.Header.Set("Acp-Session-Id", "session-1")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != http.StatusOK || w.Body.String() != expected || calls != 1 {
				t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body)
			}
			if agents.input.RequestID != "" {
				t.Fatal("protocol routing queried Controller")
			}
		})
	}
}

func TestACPRelayPreservesApprovalCancelAndStreamingSequence(t *testing.T) {
	t.Parallel()
	const prompt = `{"jsonrpc":"2.0","id":"prompt-1","method":"session/prompt","params":{"sessionId":"session-1","prompt":[{"type":"text","text":"hello"}]}}`
	const ack = `{"jsonrpc":"2.0","id":"prompt-1","result":{}}`
	const permission = `{"jsonrpc":"2.0","id":"approval-1","method":"session/request_permission","params":{"sessionId":"session-1","toolCall":{"toolCallId":"tool-1","title":"Read"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"}]}}`
	const approval = `{"jsonrpc":"2.0","id":"approval-1","result":{"outcome":{"outcome":"selected","optionId":"allow"}}}`
	const update = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Working"}}}}`
	const cancel = `{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}`
	const follow = `{"jsonrpc":"2.0","id":"list-2","method":"session/list","params":{}}`
	const listed = `{"jsonrpc":"2.0","id":"list-2","result":{"sessions":[]}}`
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			terminal := `{"jsonrpc":"2.0","id":"prompt-1","result":{"stopReason":"cancelled"}}`
			if version == "v2" {
				terminal = `{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"session-1","update":{"sessionUpdate":"state_update","state":"idle","stopReason":"cancelled"}}}`
			}
			fixture := newRelayFixtureWithExchange(t, version, func(peer *websocket.Conn) {
				receiveACPFrame(t, peer, prompt)
				if version == "v2" {
					sendACPFrame(t, peer, ack)
				}
				sendACPFrame(t, peer, permission)
				receiveACPFrame(t, peer, approval)
				sendACPFrame(t, peer, update)
				receiveACPFrame(t, peer, cancel)
				sendACPFrame(t, peer, terminal)
				receiveACPFrame(t, peer, follow)
				sendACPFrame(t, peer, listed)
			})
			sendACPFrame(t, fixture.client, prompt)
			if version == "v2" {
				receiveACPFrame(t, fixture.client, ack)
			}
			receiveACPFrame(t, fixture.client, permission)
			sendACPFrame(t, fixture.client, approval)
			receiveACPFrame(t, fixture.client, update)
			sendACPFrame(t, fixture.client, cancel)
			receiveACPFrame(t, fixture.client, terminal)
			sendACPFrame(t, fixture.client, follow)
			receiveACPFrame(t, fixture.client, listed)
		})
	}
}

func sendACPFrame(t *testing.T, connection *websocket.Conn, payload string) {
	t.Helper()
	if err := connection.SetWriteDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := connection.WriteMessage(websocket.TextMessage, []byte(payload)); err != nil {
		t.Fatal(err)
	}
}
func receiveACPFrame(t *testing.T, connection *websocket.Conn, expected string) {
	t.Helper()
	if err := connection.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	kind, payload, err := connection.ReadMessage()
	if err != nil || kind != websocket.TextMessage || string(payload) != expected {
		t.Fatalf("expected=%s received=%s error=%v", expected, payload, err)
	}
}

func TestACPHTTPPreservesUpstreamRejectionForReusedConnectionScope(t *testing.T) {
	t.Parallel()
	for _, kind := range []string{"organization", "principal", "agent"} {
		t.Run(kind, func(t *testing.T) {
			principal := ordinaryPrincipal()
			target := "agent-1"
			switch kind {
			case "organization":
				principal.OrganizationID = "other-org"
			case "principal":
				principal.UserID = "other-user"
			case "agent":
				target = "other-agent"
			}
			calls := 0
			expected := `{"jsonrpc":"2.0","id":"prompt-1","error":{"code":-32000,"message":"Connection scope rejected"}}`
			upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Header.Get(HeaderOrganizationID) != principal.OrganizationID || r.Header.Get(HeaderPrincipalID) != principal.UserID || r.Header.Get(HeaderAgentID) != target {
					t.Error("route/identity scope changed")
				}
				if r.Header.Get("Acp-Connection-Id") != "connection-1" || r.Header.Get("Acp-Session-Id") != "session-1" {
					t.Error("opaque transport IDs changed")
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				if _, err := io.WriteString(w, expected); err != nil {
					t.Error(err)
				}
			})
			h := newTestHandlerWithAgents(t, &identityServiceStub{resolvePrincipal: principal}, &agentServiceStub{listErr: context.DeadlineExceeded}, upstream, time.Now(), Config{})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, workspaceHTTPRequest(http.MethodPost, "/api/app/agents/"+target+"/v1/acp"))
			if w.Code != http.StatusForbidden || w.Body.String() != expected || calls != 1 {
				t.Fatalf("response=%d %s calls=%d", w.Code, w.Body, calls)
			}
		})
	}
}
