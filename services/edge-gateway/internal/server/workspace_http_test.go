package server

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/agentcontroller"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestWorkspaceHTTPForwardsOfficialTransportWithoutCredentials(t *testing.T) {
	for _, suffix := range []string{"acp", "v1/acp"} {
		for _, method := range []string{http.MethodPost, http.MethodGet, http.MethodDelete} {
			t.Run(suffix+"/"+method, func(t *testing.T) {
				calls := 0
				upstream := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.URL.Path != "/v1/acp" || r.URL.RawQuery != "" || r.Method != method {
						t.Errorf("upstream = %s %s", r.Method, r.URL)
					}
					if r.Header.Get("X-Antnest-Agent-Id") != "agent-1" || r.Header.Get("X-Antnest-Principal-Id") != "user-admin" || r.Header.Get(HeaderOrganizationID) != "org-1" {
						t.Error("missing trusted identity")
					}
					for _, name := range []string{"Cookie", "Authorization", session.CSRFHeaderName, HeaderUserID, HeaderAgentAccessSubject, "X-Forged-Extra"} {
						if r.Header.Get(name) != "" {
							t.Errorf("forwarded private header %s", name)
						}
					}
					if r.Header.Get("Acp-Connection-Id") != "connection-1" || r.Header.Get("Acp-Session-Id") != "session-1" {
						t.Error("lost ACP routing headers")
					}
					if method == http.MethodPost {
						body, err := io.ReadAll(r.Body)
						if err != nil || string(body) != `{"opaque":"payload"}` {
							t.Errorf("body=%s err=%v", body, err)
						}
					}
					w.Header().Set("Acp-Connection-Id", "connection-1")
					w.Header().Set("Acp-Session-Id", "session-1")
					w.WriteHeader(http.StatusAccepted)
				})
				h := newWorkspaceHTTPHandler(t, upstream)
				r := workspaceHTTPRequest(method, "/api/app/agents/agent-1/"+suffix+"?token=not-forwarded")
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				if w.Code != http.StatusAccepted || calls != 1 {
					t.Fatalf("status=%d calls=%d body=%s", w.Code, calls, w.Body.String())
				}
				if w.Header().Get("Acp-Connection-Id") != "connection-1" || w.Header().Get("Acp-Session-Id") != "session-1" {
					t.Error("lost response routing headers")
				}
			})
		}
	}
}

func TestWorkspaceHTTPRejectsRequestsBeforeForwarding(t *testing.T) {
	for _, tc := range []struct {
		name, method, path string
		mutate             func(*http.Request)
		status             int
	}{
		{"missing cookie", "POST", "v1/acp", func(r *http.Request) { r.Header.Del("Cookie") }, 401},
		{"missing csrf", "POST", "v1/acp", func(r *http.Request) { r.Header.Del(session.CSRFHeaderName) }, 403},
		{"delete csrf", "DELETE", "v1/acp", func(r *http.Request) { r.Header.Del(session.CSRFHeaderName) }, 403},
		{"cross origin", "GET", "v1/acp", func(r *http.Request) { r.Header.Set("Origin", "https://evil.test") }, 403},
		{"v2 HTTP", "POST", "v2/acp", func(*http.Request) {}, 404},
		{"oversized body", "POST", "v1/acp", func(r *http.Request) { r.ContentLength = maximumACPMessageBytes + 1 }, 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newWorkspaceHTTPHandler(t, http.HandlerFunc(func(http.ResponseWriter, *http.Request) { t.Error("rejected request reached upstream") }))
			r := workspaceHTTPRequest(tc.method, "/api/app/agents/agent-1/"+tc.path)
			tc.mutate(r)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", w.Code, tc.status, w.Body.String())
			}
			if strings.Contains(tc.name, "csrf") && !strings.Contains(w.Body.String(), `"code":"csrf_failed"`) {
				t.Fatalf("CSRF assertion was masked by another rejection: %s", w.Body.String())
			}
		})
	}
}

func TestWorkspaceHTTPReceiveDoesNotConsumeMessageAdmission(t *testing.T) {
	h := newWorkspaceHTTPHandler(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(202) })).(*handler)
	for len(h.acpConnections) < cap(h.acpConnections) {
		h.acpConnections <- struct{}{}
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, workspaceHTTPRequest("POST", "/api/app/agents/agent-1/v1/acp"))
	if w.Code != 202 {
		t.Fatalf("receive streams blocked a message: %d", w.Code)
	}
}

func TestWorkspaceHTTPRevalidatesIdentityOnEveryRequest(t *testing.T) {
	identityService := &identityServiceStub{resolvePrincipal: ordinaryPrincipal()}
	calls := 0
	h := newTestHandlerWithAgents(t, identityService,
		&agentServiceStub{agents: []agentcontroller.WorkspaceAgent{{AgentID: "agent-1"}}},
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls++; w.WriteHeader(202) }), time.Now(), Config{})
	w := httptest.NewRecorder()
	h.ServeHTTP(w, workspaceHTTPRequest("POST", "/api/app/agents/agent-1/v1/acp"))
	if w.Code != 202 {
		t.Fatalf("initial request: %d", w.Code)
	}
	identityService.resolvePrincipal.Active = false
	for _, method := range []string{"POST", "GET", "DELETE"} {
		w = httptest.NewRecorder()
		h.ServeHTTP(w, workspaceHTTPRequest(method, "/api/app/agents/agent-1/v1/acp"))
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("%s after revocation: %d", method, w.Code)
		}
	}
	if calls != 1 {
		t.Fatalf("revoked identity forwarded %d requests", calls)
	}
}

func TestWorkspaceHTTPSSEFlushesBeforeUpstreamCloses(t *testing.T) {
	reader, writer := io.Pipe()
	received := make(chan context.Context, 1)
	h := newWorkspaceHTTPHandler(t, http.NotFoundHandler()).(*handler)
	h.httpClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		received <- r.Context()
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": {"text/event-stream"}}, Body: reader, Request: r}, nil
	})
	edge := httptest.NewServer(h)
	defer edge.Close()
	defer func() {
		if err := reader.Close(); err != nil {
			t.Error(err)
		}
	}()
	defer func() {
		if err := writer.Close(); err != nil {
			t.Error(err)
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	r := workspaceHTTPRequest("GET", edge.URL+"/api/app/agents/agent-1/v1/acp").WithContext(ctx)
	r.RequestURI = ""
	response, err := edge.Client().Do(r)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := response.Body.Close(); err != nil {
			t.Error(err)
		}
	}()
	done := make(chan error, 1)
	go func() { _, err := io.WriteString(writer, "data: first\n\n"); done <- err }()
	body := make([]byte, len("data: first\n\n"))
	if _, err = io.ReadFull(response.Body, body); err != nil || string(body) != "data: first\n\n" {
		t.Fatalf("body=%q err=%v", body, err)
	}
	if err = <-done; err != nil {
		t.Fatal(err)
	}
	upstream := <-received
	cancel()
	select {
	case <-upstream.Done():
	case <-time.After(time.Second):
		t.Fatal("client disconnect left upstream open")
	}
}

func newWorkspaceHTTPHandler(t *testing.T, upstream http.Handler) http.Handler {
	t.Helper()
	return newTestHandlerWithAgents(t, &identityServiceStub{resolvePrincipal: ordinaryPrincipal()},
		&agentServiceStub{agents: []agentcontroller.WorkspaceAgent{{AgentID: "agent-1"}}}, upstream, time.Now(), Config{})
}

func workspaceHTTPRequest(method, path string) *http.Request {
	r := newBrowserRequest(method, path, strings.NewReader(`{"opaque":"payload"}`))
	addSessionCookies(r, "token-1", "csrf-1")
	r.Header.Set(session.CSRFHeaderName, "csrf-1")
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Accept", "text/event-stream")
	r.Header.Set("Acp-Connection-Id", "connection-1")
	r.Header.Set("Acp-Session-Id", "session-1")
	r.Header.Set(HeaderAgentAccessSubject, "forged")
	r.Header.Set(HeaderUserID, "forged-user")
	r.Header.Set("Authorization", "Bearer forged")
	r.Header.Set("X-Forged-Extra", "forged")
	return r
}
