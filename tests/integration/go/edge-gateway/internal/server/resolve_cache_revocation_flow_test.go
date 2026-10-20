package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestLogoutResolveOverlapsSessionRevocationThroughRealHTTP(t *testing.T) {
	for _, scenario := range []struct {
		name string
		ttl  time.Duration
		sid  string
		want int
	}{
		{"unrelated", 10 * time.Second, "another-session", 204},
		{"matching", 10 * time.Second, "token-1", 503},
		{"disabled-unrelated", 0, "another-session", 204},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			gate, entered := make(chan struct{}), make(chan struct{}, 1)
			var release sync.Once
			var requests sync.WaitGroup
			var issuer *identity.Client
			var edge, peer *httptest.Server
			transport := http.DefaultTransport.(*http.Transport).Clone()
			client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
			t.Cleanup(func() {
				cancel()
				release.Do(func() { close(gate) })
				requests.Wait()
				if issuer != nil {
					issuer.Close()
				}
				if edge != nil {
					edge.Close()
				}
				if peer != nil {
					peer.Close()
				}
				transport.CloseIdleConnections()
			})
			var resolves, revokes atomic.Int32
			now := time.Now()
			peer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				var input map[string]string
				if json.NewDecoder(r.Body).Decode(&input) != nil || input["access_token"] != "private-token" {
					t.Error("Identity received a different credential")
					w.WriteHeader(400)
					return
				}
				switch r.URL.Path {
				case "/rpc/identity/resolve-access-token":
					if resolves.Add(1) != 1 || input["profile"] != "session" || input["agent_id"] != "" {
						t.Error("logout retried Resolve or changed its trusted scope")
					}
					entered <- struct{}{}
					select {
					case <-gate:
					case <-r.Context().Done():
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{
						"principal": ordinaryPrincipal(), "caller_context": sessionFlowContext("token-1", now.Unix(), 1),
						"expires_at": now.Add(time.Hour), "idle_expires_at": now.Add(30 * time.Minute), "activity_interval_ms": 30000,
					})
				case "/rpc/identity/revoke-access-token":
					revokes.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]string{"status": "revoked"})
				default:
					t.Error("unexpected Identity operation")
					w.WriteHeader(404)
				}
			}))
			var err error
			issuer, err = identity.NewCachedClient(ctx, peer.URL, client, identity.ResolveCacheConfig{TTL: scenario.ttl, Size: 10, RequestTimeout: 5 * time.Second})
			if err != nil {
				t.Fatal(err)
			}
			manager, err := session.NewManager(session.Config{CSRFKey: []byte(testCSRFKey)})
			if err != nil {
				t.Fatal(err)
			}
			h, err := NewHandler(Config{AdminConsoleURL: peer.URL, AgentUIURL: peer.URL, IdentityURL: peer.URL, RequestTimeout: 5 * time.Second}, Dependencies{
				Identity: issuer, Sessions: manager, HTTPClient: client,
				Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
			})
			if err != nil {
				t.Fatal(err)
			}
			edge = httptest.NewServer(h)
			type reply struct {
				status  int
				cookies []*http.Cookie
				err     error
			}
			finished := make(chan reply, 1)
			requests.Go(func() {
				r, err := http.NewRequestWithContext(ctx, "DELETE", edge.URL+"/api/session", nil)
				if err != nil {
					finished <- reply{err: err}
					return
				}
				r.Header.Set("Origin", edge.URL)
				r.Header.Set(session.CSRFHeaderName, testCSRFToken)
				addSessionCookies(r, "private-token", testCSRFToken)
				response, err := client.Do(r)
				if err != nil {
					finished <- reply{err: err}
					return
				}
				_, err = io.Copy(io.Discard, response.Body)
				_ = response.Body.Close()
				finished <- reply{response.StatusCode, response.Cookies(), err}
			})
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("cold logout Resolve did not enter the actual Identity HTTP handler")
			}
			issuer.ApplySessionRevocation(identity.SessionRevocation{TokenID: scenario.sid})
			if revokes.Load() != 0 {
				t.Fatal("logout mutated Identity before its held Resolve completed")
			}
			release.Do(func() { close(gate) })
			var result reply
			select {
			case result = <-finished:
			case <-time.After(5 * time.Second):
				t.Fatal("logout did not complete")
			}
			if result.err != nil || result.status != scenario.want || resolves.Load() != 1 {
				t.Fatalf("first logout response: status=%d resolves=%d err=%v", result.status, resolves.Load(), result.err)
			}
			if scenario.want == 204 {
				if revokes.Load() != 1 || len(result.cookies) != 2 {
					t.Fatalf("logout did not revoke once and clear both Cookies: revokes=%d cookies=%d", revokes.Load(), len(result.cookies))
				}
				for _, cookie := range result.cookies {
					if cookie.MaxAge >= 0 || cookie.Value != "" {
						t.Fatal("successful logout retained a browser credential")
					}
				}
			} else if revokes.Load() != 0 || len(result.cookies) != 0 {
				t.Fatal("revocation-fenced Resolve performed logout or changed Cookies")
			}
		})
	}
}
