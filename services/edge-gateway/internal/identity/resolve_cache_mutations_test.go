package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveCacheLocalMutationsEvictBeforeReturning(t *testing.T) {
	for _, operation := range []string{"logout", "already_invalid", "password", "revoke_all", "revoke_others", "unbind_other", "unbind_current", "activity"} {
		t.Run(operation, func(t *testing.T) {
			synctest.Test(t, func(t *testing.T) {
				var calls atomic.Int64
				var authority Principal
				client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
					if request.URL.Path == "/rpc/identity/resolve-access-token" {
						calls.Add(1)
						return cacheTestResponse(cacheMutationPayload(request)), nil
					}
					return cacheTestResponse(cacheMutationReply(operation, authority)), nil
				})
				defer client.Close()
				client.SessionFeedCaughtUp(time.Now())
				scopes := []struct{ token, profile, agent string }{
					{"alice", "console", ""}, {"alice", "workspace", "agent-A"}, {"alice", "acp", "agent-A"},
					{"alice", "session", ""}, {"alice-org-B", "workspace", ""}, {"bob", "workspace", ""},
				}
				for _, scope := range scopes {
					principal, err := client.Resolve(WithResolution(context.Background(), scope.profile, scope.agent), scope.token)
					if err != nil {
						t.Fatal(err)
					}
					if scope.token == "alice" && scope.profile == "console" {
						authority = principal
					}
				}
				if err := cacheMutation(client, operation, authority); err != nil {
					t.Fatal(err)
				}
				userWide := operation != "logout" && operation != "already_invalid" && operation != "activity"
				for _, scope := range scopes {
					principal, err := client.Resolve(WithResolution(context.Background(), scope.profile, scope.agent), scope.token)
					wantHit := scope.token == "bob" || scope.token == "alice-org-B" && !userWide
					if err != nil || principal.ResolveCacheHit != wantHit {
						t.Errorf("post-mutation scope %s/%s hit=%v want=%v err=%v", scope.token, scope.profile, principal.ResolveCacheHit, wantHit, err)
					}
				}
				wantCalls := int64(10)
				if userWide {
					wantCalls++
				}
				if calls.Load() != wantCalls {
					t.Errorf("mutation did not evict exact token/SID or all trusted-user organizations: calls=%d want=%d", calls.Load(), wantCalls)
				}
			})
		})
	}
}

func TestResolveCacheActivityPreservesKnownSIDReadersAndOtherUsers(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		var releaseOnce sync.Once
		var hold atomic.Bool
		var authority Principal
		client := cachedTestClient(t, 10*time.Second, 100, func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/rpc/identity/resolve-access-token" {
				return cacheTestResponse(cacheMutationReply("activity", authority)), nil
			}
			payload := cacheMutationPayload(request)
			if hold.Load() {
				select {
				case <-gate:
				case <-request.Context().Done():
					return nil, request.Context().Err()
				}
			}
			return cacheTestResponse(payload), nil
		})
		defer client.Close()
		defer releaseOnce.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now())
		var err error
		authority, err = client.Resolve(context.Background(), "alice")
		if err != nil {
			t.Fatal(err)
		}
		hold.Store(true)
		alice, bob := make(chan cacheResolveResult, 1), make(chan cacheResolveResult, 1)
		go func() {
			p, err := client.Resolve(WithResolution(context.Background(), "console", ""), "alice")
			alice <- cacheResolveResult{p, err}
		}()
		go func() { p, err := client.Resolve(context.Background(), "bob"); bob <- cacheResolveResult{p, err} }()
		synctest.Wait()
		if err := cacheMutation(client, "activity", authority); err != nil {
			t.Fatal(err)
		}
		releaseOnce.Do(func() { close(gate) })
		if result := <-alice; result.err != nil || !result.principal.Active || result.principal.ResolveCacheHit || !result.principal.IdleExpiresAt.Equal(authority.IdleExpiresAt) {
			t.Errorf("activity cancelled or renewed a still-valid known-SID live reader: %v", result.err)
		}
		if result := <-bob; result.err != nil || !result.principal.Active {
			t.Errorf("activity invalidated an unrelated user's in-flight result: %v", result.err)
		}
		if result, err := client.Resolve(context.Background(), "bob"); err != nil || !result.ResolveCacheHit {
			t.Errorf("activity discarded an unrelated user entry: %v", err)
		}
		if result, err := client.Resolve(WithResolution(context.Background(), "console", ""), "alice"); err != nil || result.ResolveCacheHit {
			t.Errorf("obsolete activity result was cached: %v", err)
		}
	})
}

// Alice's second session belongs to another Organization; unbinding still
// invalidates all of this trusted User's observations when current_revoked=false.
func cacheMutationPayload(request *http.Request) map[string]any {
	payload := cacheTestPayload(request)
	principal := payload["principal"].(map[string]any)
	issuer, err := parseIssuerContext(payload["caller_context"].(string))
	if err != nil {
		panic(err)
	}
	if issuer.sessionID == cacheTestSID("bob") {
		principal["user_id"] = "bob"
	} else if issuer.sessionID == cacheTestSID("alice-org-B") {
		principal["organization_id"] = "org-B"
		principal["membership_id"] = "membership-B"
	}
	encoded, err := base64.RawURLEncoding.DecodeString(strings.Split(payload["caller_context"].(string), ".")[1])
	if err != nil {
		panic(err)
	}
	var claims map[string]any
	if err := json.Unmarshal(encoded, &claims); err != nil {
		panic(err)
	}
	claims["sub"], claims["org"], claims["mbr"] = principal["user_id"], principal["organization_id"], principal["membership_id"]
	payload["caller_context"] = cacheTestCCT(claims)
	return payload
}

func cacheMutationReply(operation string, authority Principal) map[string]any {
	switch operation {
	case "logout":
		return map[string]any{"status": "revoked"}
	case "already_invalid":
		return map[string]any{"status": "already_invalid"}
	case "activity":
		return map[string]any{"expires_at": authority.ExpiresAt, "idle_expires_at": authority.IdleExpiresAt.Add(5 * time.Second), "activity_interval_ms": 1000}
	case "password":
		return map[string]any{"status": "changed", "principal": authority, "token_id": "replacement-session", "access_token": "replacement-token",
			"expires_at": authority.ExpiresAt, "idle_expires_at": authority.IdleExpiresAt, "activity_interval_ms": 1000}
	default:
		return map[string]any{"revoked_count": 1, "current_revoked": operation == "revoke_all" || operation == "unbind_current"}
	}
}

func cacheMutation(client *Client, operation string, authority Principal) error {
	ctx := WithPrincipal(context.Background(), authority)
	var err error
	switch operation {
	case "logout", "already_invalid":
		_, err = client.RevokeByAccessToken(ctx, "alice")
	case "activity":
		_, err = client.TouchSession(ctx)
	case "password":
		_, err = client.ChangePassword(ctx, PasswordInput{RequestID: "change-request", CurrentPassword: "old", NewPassword: "new-secret-password"})
	case "unbind_current", "unbind_other":
		_, err = client.UnbindExternalIdentity(ctx, ExternalIdentityUnbindInput{RequestID: "unbind-request", BindingID: "binding"})
	default:
		mode := "all"
		if operation == "revoke_others" {
			mode = "others"
		}
		_, err = client.RevokeSessions(ctx, SessionRevokeInput{RequestID: "revoke-request", Mode: mode})
	}
	return err
}

// Ensure private provenance never becomes part of public mutation results.
func TestResolveCacheProvenanceIsNotBrowserJSON(t *testing.T) {
	now := time.Now()
	encoded, err := json.Marshal(Principal{ResolveStartedAt: now, ResolveCompletedAt: now, ResolveValidUntil: now, ResolveCacheHit: true})
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"ResolveStartedAt", "ResolveCompletedAt", "ResolveValidUntil", "ResolveCacheHit", "resolve_started_at", "resolve_completed_at", "valid_until", "cache_hit"} {
		if _, exists := fields[field]; exists {
			t.Errorf("private resolution metadata leaked: %s", field)
		}
	}
}

func TestResolveCacheActivityAllowsConservativeColdObservationUntilItsOriginalDeadline(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		gate := make(chan struct{})
		var releaseOnce sync.Once
		var hold, touched atomic.Bool
		originalIdle := time.Now().Add(2 * time.Second)
		var authority Principal
		transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
			if request.URL.Path != "/rpc/identity/resolve-access-token" {
				touched.Store(true)
				return cacheTestResponse(cacheMutationReply("activity", authority)), nil
			}
			payload := cacheMutationPayload(request)
			payload["idle_expires_at"] = originalIdle
			if touched.Load() {
				payload["idle_expires_at"] = originalIdle.Add(5 * time.Second)
			}
			if hold.Load() {
				select {
				case <-gate:
				case <-request.Context().Done():
					return nil, request.Context().Err()
				}
			}
			return cacheTestResponse(payload), nil
		})
		// Model authority obtained on another replica: this client has no SID
		// index when the concurrent cold Resolve begins.
		external, err := NewClient("http://identity.internal", &http.Client{Transport: transport})
		if err != nil {
			t.Fatal(err)
		}
		authority, err = external.Resolve(context.Background(), "alice")
		if err != nil {
			t.Fatal(err)
		}
		client := cachedTestClient(t, 10*time.Second, 10, transport)
		defer client.Close()
		defer releaseOnce.Do(func() { close(gate) })
		client.SessionFeedCaughtUp(time.Now())
		hold.Store(true)
		done := make(chan cacheResolveResult, 1)
		go func() { p, err := client.Resolve(context.Background(), "alice"); done <- cacheResolveResult{p, err} }()
		synctest.Wait()
		if err := cacheMutation(client, "activity", authority); err != nil {
			t.Fatal(err)
		}
		releaseOnce.Do(func() { close(gate) })
		result := <-done
		if result.err != nil || !result.principal.IdleExpiresAt.Equal(originalIdle) || result.principal.CallerContext != authority.CallerContext || !result.principal.ResolveValidUntil.Equal(originalIdle) {
			t.Fatalf("cold observation was invalidated or patched with newer authority: %v", result.err)
		}
		time.Sleep(2 * time.Second)
		fresh, err := client.Resolve(context.Background(), "alice")
		if err != nil || fresh.ResolveCacheHit || !fresh.IdleExpiresAt.Equal(originalIdle.Add(5*time.Second)) {
			t.Fatalf("original idle deadline did not force a live read of the extension: %v", err)
		}
	})
}
