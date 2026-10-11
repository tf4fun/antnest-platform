package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveCacheScopesAndClientOwnership(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		clients := []*Client{cachedTestClient(t, 10*time.Second, 100, transport), cachedTestClient(t, 10*time.Second, 100, transport)}
		for _, client := range clients {
			defer client.Close()
			client.SessionFeedCaughtUp(time.Now())
			for _, token := range []string{"token-A", "token-B"} {
				for _, profile := range []string{"workspace", "console", "acp", "session"} {
					for _, agent := range []string{"", "agent-A", "agent-B"} {
						if profile == "session" && agent != "" {
							continue
						}
						ctx := WithResolution(context.Background(), profile, agent)
						before := calls.Load()
						first, err := client.Resolve(ctx, token)
						if err != nil || first.ResolveCacheHit {
							t.Fatalf("cold exact scope did not resolve live: %v", err)
						}
						second, err := client.Resolve(ctx, token)
						if err != nil || !second.ResolveCacheHit || calls.Load() != before+1 || second.CallerContext != first.CallerContext || !second.ResolveStartedAt.Equal(first.ResolveStartedAt) {
							t.Fatalf("exact scope did not reuse immutable authority: %v", err)
						}
					}
				}
			}
			before := calls.Load()
			if result, err := client.Resolve(context.Background(), "token-A"); err != nil || !result.ResolveCacheHit || calls.Load() != before {
				t.Fatalf("missing selection did not use workspace/absent Agent: %v", err)
			}
			for _, invalid := range []struct{ profile, agent string }{
				{"", ""}, {" workspace", ""}, {"Workspace", ""}, {"unknown", ""}, {"session", "agent-A"},
				{"workspace", "-first"}, {"acp", "中"}, {"console", "a b"}, {"workspace", "a/b"}, {"acp", strings.Repeat("a", 201)},
			} {
				if _, err := client.Resolve(WithResolution(context.Background(), invalid.profile, invalid.agent), "token-A"); err == nil || calls.Load() != before {
					t.Fatal("invalid server scope reached lookup or Identity")
				}
			}
		}
		if calls.Load() != 40 {
			t.Fatalf("scope or issuer client isolation lost: calls=%d", calls.Load())
		}
	})
}

func TestResolveCacheEveryDeadlineExpiresAtEquality(t *testing.T) {
	for _, bound := range []string{"ttl", "idle", "absolute", "cct"} {
		t.Run(bound, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int64
				ttl := 10 * time.Second
				if bound == "ttl" {
					ttl = 2 * time.Second
				}
				client := cachedTestClient(t, ttl, 10, func(request *http.Request) (*http.Response, error) {
					calls.Add(1)
					payload := cacheTestPayload(request)
					deadline := time.Now().Add(2 * time.Second)
					switch bound {
					case "idle":
						payload["idle_expires_at"] = deadline
					case "absolute":
						payload["expires_at"], payload["idle_expires_at"] = deadline, deadline
					case "cct":
						parts := strings.Split(payload["caller_context"].(string), ".")
						encoded, _ := base64.RawURLEncoding.DecodeString(parts[1])
						var claims map[string]any
						_ = json.Unmarshal(encoded, &claims)
						claims["exp"] = deadline.Unix()
						payload["caller_context"] = cacheTestCCT(claims)
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				started := time.Now()
				client.SessionFeedCaughtUp(started)
				first, err := client.Resolve(context.Background(), "token")
				if err != nil || !first.ResolveValidUntil.Equal(started.Add(2*time.Second)) {
					t.Fatalf("wrong authority deadline: %v", err)
				}
				time.Sleep(2 * time.Second)
				client.SessionFeedCaughtUp(time.Now())
				second, err := client.Resolve(context.Background(), "token")
				if err != nil || second.ResolveCacheHit || calls.Load() != 2 || !second.ResolveStartedAt.Equal(time.Now()) {
					t.Fatalf("fresh feed proof reused expired %s snapshot: %v", bound, err)
				}
			})
		})
	}
}

func TestResolveCacheMissingAndStaleFeedRequireLiveRead(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			return cacheTestResponse(cacheTestPayload(request)), nil
		})
		defer client.Close()
		for range 2 {
			if result, err := client.Resolve(context.Background(), "token"); err != nil || result.ResolveCacheHit {
				t.Fatalf("missing feed proof admitted a cache hit: %v", err)
			}
		}
		client.SessionFeedCaughtUp(time.Now())
		time.Sleep(4 * time.Second)
		if _, err := client.Resolve(context.Background(), "new-token"); err != nil {
			t.Fatal(err)
		}
		time.Sleep(6 * time.Second)
		result, err := client.Resolve(context.Background(), "new-token")
		if err != nil || result.ResolveCacheHit || calls.Load() != 4 {
			t.Fatalf("stale proof reused a still-unexpired entry: %v", err)
		}
	})
}

func TestResolveCacheLatencyConsumesOriginalBudget(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, time.Second, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			payload := cacheTestPayload(request)
			time.Sleep(300 * time.Millisecond)
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		start := time.Now()
		client.SessionFeedCaughtUp(start)
		principal, err := client.Resolve(context.Background(), "token")
		if err != nil || !principal.ResolveStartedAt.Equal(start) || !principal.ResolveCompletedAt.Equal(start.Add(300*time.Millisecond)) || !principal.ResolveValidUntil.Equal(start.Add(time.Second)) {
			t.Fatalf("slow reply moved the authority origin: %v", err)
		}
		if hit, err := client.Resolve(context.Background(), "token"); err != nil || !hit.ResolveCacheHit || calls.Load() != 1 || !hit.ResolveCompletedAt.Equal(principal.ResolveCompletedAt) {
			t.Fatalf("hit changed actual RPC duration: %v", err)
		}
		encoded, _ := json.Marshal(principal)
		for _, private := range []string{"resolve_started_at", "resolve_completed_at", "valid_until", "cache_hit", "ResolveStartedAt", "ResolveCompletedAt", "ResolveValidUntil", "ResolveCacheHit"} {
			if strings.Contains(string(encoded), private) {
				t.Fatal("private cache provenance reached browser JSON")
			}
		}
	})
}

func TestResolveCacheNeverStoresFailureInactiveOrOversizedAuthority(t *testing.T) {
	for _, outcome := range []string{"transport", "unauthenticated", "inactive_principal", "malformed", "inactive", "oversized"} {
		t.Run(outcome, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int64
				client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
					calls.Add(1)
					if outcome == "transport" {
						return nil, errors.New("synthetic transport failure")
					}
					if outcome == "unauthenticated" || outcome == "inactive_principal" {
						return jsonResponse(401, `{"code":"`+outcome+`"}`), nil
					}
					if outcome == "malformed" {
						return jsonResponse(200, `{"principal":null}`), nil
					}
					payload := cacheTestPayload(request)
					principal := payload["principal"].(map[string]any)
					if outcome == "inactive" {
						principal["active"] = false
					} else {
						principal["organization_name"] = strings.Repeat("x", 17*1024)
					}
					return cacheTestResponse(payload), nil
				})
				defer client.Close()
				client.SessionFeedCaughtUp(time.Now())
				for range 2 {
					principal, err := client.Resolve(context.Background(), "token")
					if principal.ResolveCacheHit || (err == nil) != (outcome == "inactive" || outcome == "oversized") || outcome == "inactive" && principal.Active {
						t.Fatalf("changed live response semantics for %s: %v", outcome, err)
					}
				}
				if calls.Load() != 2 {
					t.Fatalf("cached %s response", outcome)
				}
			})
		})
	}
}

func TestResolveCacheZeroRetainsDirectCallsAndCallerDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		var calls atomic.Int64
		client := cachedTestClient(t, 0, 10, func(request *http.Request) (*http.Response, error) {
			calls.Add(1)
			if _, set := request.Context().Deadline(); set {
				t.Error("disabled cache imposed shared RPC deadline")
			}
			payload := cacheTestPayload(request)
			time.Sleep(6 * time.Second)
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		client.SessionFeedCaughtUp(time.Now())
		for range 2 {
			if principal, err := client.Resolve(context.Background(), "token"); err != nil || principal.ResolveCacheHit {
				t.Fatalf("disabled cache changed direct semantics: %v", err)
			}
		}
		if calls.Load() != 2 {
			t.Fatal("TTL zero retained cache or coalescing")
		}
	})
}
