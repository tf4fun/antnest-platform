package server

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/identity"
	"github.com/tf4fun/antnest-platform/services/edge-gateway/internal/session"
)

func TestResolveCacheActivityOverlapsRealHTTPBootstrap(t *testing.T) {
	for _, ttl := range []time.Duration{0, 10 * time.Second} {
		t.Run(ttl.String(), func(t *testing.T) {
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
			var sessions, workspaces, touches, forwarded atomic.Int32
			now := time.Now()
			expires, idle := now.Add(time.Hour), now.Add(30*time.Minute)
			sessionCCT := sessionFlowContext("token-1", now.Unix(), 1)
			workspaceCCT := sessionFlowContext("token-1", now.Unix(), 2)
			peer = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/api/app/workspace/v1/bootstrap" {
					forwarded.Add(1)
					if r.Header.Get(identity.CallerContextHeader) != workspaceCCT || r.Header.Get("Cookie") != "" || r.Header.Get(session.CSRFHeaderName) != "" {
						t.Error("bootstrap forwarding lost trusted authority or leaked browser credentials")
					}
					_, _ = io.WriteString(w, `{"display":"actual-http-upstream"}`)
					return
				}
				var input map[string]string
				if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
					t.Errorf("invalid Identity request: %v", err)
					w.WriteHeader(400)
					return
				}
				switch r.URL.Path {
				case "/rpc/identity/resolve-access-token":
					if input["access_token"] != "private-token" || input["agent_id"] != "" {
						t.Error("Resolve changed its exact token/Agent scope")
					}
					cct := sessionCCT
					switch input["profile"] {
					case "session":
						sessions.Add(1)
					case "workspace":
						cct = workspaceCCT
						if workspaces.Add(1) == 1 {
							entered <- struct{}{}
							select {
							case <-gate:
							case <-r.Context().Done():
								return
							}
						}
					default:
						t.Error("unexpected Resolve profile")
						w.WriteHeader(400)
						return
					}
					_ = json.NewEncoder(w).Encode(map[string]any{"principal": ordinaryPrincipal(), "caller_context": cct, "expires_at": expires, "idle_expires_at": idle, "activity_interval_ms": 30000})
				case "/rpc/identity/touch-browser-session":
					touches.Add(1)
					if r.Header.Get(identity.CallerContextHeader) != sessionCCT || input["actor_principal_id"] != ordinaryPrincipal().UserID {
						t.Error("Touch did not use its verified session principal")
					}
					_ = json.NewEncoder(w).Encode(identity.SessionMetadata{ExpiresAt: expires, IdleExpiresAt: idle.Add(time.Minute), ActivityIntervalMS: 30000})
				default:
					t.Error("unexpected downstream route")
					w.WriteHeader(404)
				}
			}))
			var err error
			issuer, err = identity.NewCachedClient(ctx, peer.URL, client, identity.ResolveCacheConfig{TTL: ttl, Size: 100, RequestTimeout: 5 * time.Second})
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
			edge = httptest.NewServer(h) // Default HTTP transports remain intact on every hop.
			type reply struct {
				status  int
				body    string
				cookies int
				err     error
			}
			request := func(method, path, body string) reply {
				r, err := http.NewRequestWithContext(ctx, method, edge.URL+path, strings.NewReader(body))
				if err != nil {
					return reply{err: err}
				}
				r.Header.Set("Origin", edge.URL)
				r.Header.Set("Content-Type", "application/json")
				r.Header.Set(session.CSRFHeaderName, testCSRFToken)
				addSessionCookies(r, "private-token", testCSRFToken)
				response, err := client.Do(r)
				if err != nil {
					return reply{err: err}
				}
				payload, err := io.ReadAll(response.Body)
				_ = response.Body.Close()
				return reply{response.StatusCode, string(payload), len(response.Header.Values("Set-Cookie")), err}
			}
			issuer.SessionFeedCaughtUp(time.Now())
			if result := request("GET", "/api/session", ""); result.err != nil || result.status != 200 || result.cookies != 0 {
				t.Fatalf("session warmup failed: status=%d err=%v", result.status, result.err)
			}
			bootstrap := make(chan reply, 1)
			bootstrapStarted := time.Now()
			requests.Go(func() { bootstrap <- request("GET", "/api/app/workspace/v1/bootstrap", "") })
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("actual workspace Resolve never entered Identity")
			}
			if result := request("POST", "/api/session/activity", `{}`); result.err != nil || result.status != 200 || result.cookies != 0 {
				t.Fatalf("first activity response failed: status=%d err=%v", result.status, result.err)
			}
			if touches.Load() != 1 || forwarded.Load() != 0 {
				t.Fatal("activity did not complete while bootstrap Resolve remained held")
			}
			wantSessions := int32(1)
			if ttl == 0 {
				wantSessions = 2
			}
			if sessions.Load() != wantSessions || workspaces.Load() != 1 {
				t.Fatalf("unexpected pre-release Resolve counts: session=%d workspace=%d", sessions.Load(), workspaces.Load())
			}
			release.Do(func() { close(gate) })
			var first reply
			select {
			case first = <-bootstrap:
			case <-time.After(5 * time.Second):
				t.Fatal("bootstrap request did not finish")
			}
			if first.err != nil || first.status != 200 || first.cookies != 0 || first.body != `{"display":"actual-http-upstream"}` || forwarded.Load() != 1 || workspaces.Load() != 1 {
				t.Fatalf("first bootstrap failed after overlapping activity: status=%d forwarded=%d resolves=%d err=%v", first.status, forwarded.Load(), workspaces.Load(), first.err)
			}
			// A later independent read must not reuse the pre-Touch result.
			// Fresh proof and an unexpired original TTL exclude natural expiry
			// as an alternative reason for this second actual Resolve.
			issuer.SessionFeedCaughtUp(time.Now())
			if next := request("GET", "/api/app/workspace/v1/bootstrap", ""); next.err != nil || next.status != 200 || next.cookies != 0 || next.body != first.body || workspaces.Load() != 2 || forwarded.Load() != 2 {
				t.Fatalf("obsolete HTTP result was cached: status=%d resolves=%d err=%v", next.status, workspaces.Load(), next.err)
			}
			if ttl > 0 && time.Since(bootstrapStarted) >= ttl {
				t.Fatal("follow-on read did not witness the original unexpired TTL")
			}
		})
	}
}
