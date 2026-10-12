package identity

import (
	"context"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"
)

func TestResolveValidatesServerScopeWithCacheDisabled(t *testing.T) {
	for _, ttl := range []time.Duration{0, 10 * time.Second} {
		t.Run(ttl.String(), func(t *testing.T) {
			var calls atomic.Int64
			client := cachedTestClient(t, ttl, 10, func(request *http.Request) (*http.Response, error) {
				calls.Add(1)
				return cacheTestResponse(cacheTestPayload(request)), nil
			})
			defer client.Close()
			client.SessionFeedCaughtUp(time.Now())
			if principal, err := client.Resolve(WithResolution(t.Context(), "workspace", "agent-1"), "token"); err != nil || !principal.Active || calls.Load() != 1 {
				t.Fatalf("valid scope failed to reach Identity: %v", err)
			}
			for _, selection := range []struct{ profile, agent string }{
				{"workspace", "agent/1"}, {"session", "agent-1"}, {"unknown", "agent-1"},
			} {
				if principal, err := client.Resolve(WithResolution(t.Context(), selection.profile, selection.agent), "token"); err == nil || principal.Active {
					t.Fatal("invalid server-owned scope admitted")
				}
			}
			if calls.Load() != 1 {
				t.Fatal("invalid server-owned scope reached Identity")
			}
		})
	}
}

func TestResolveCacheRejectsIncompleteRolesAndInvalidPublicIDs(t *testing.T) {
	for _, field := range []string{"system_role", "organization_role", "user_id", "organization_id", "membership_id"} {
		values := []any{nil, "", "unknown-role"}
		if strings.HasSuffix(field, "_id") {
			values = []any{nil, "", "id:legacy", "-leading", "白", strings.Repeat("a", 201)}
		}
		for index, value := range append(values, "missing") {
			t.Run(field+"/"+string(rune('a'+index)), func(t *testing.T) {
				synctest.Test(t, func(t *testing.T) {
					var calls atomic.Int64
					client := cachedTestClient(t, 10*time.Second, 10, func(request *http.Request) (*http.Response, error) {
						calls.Add(1)
						payload := cacheTestPayload(request)
						principal := payload["principal"].(map[string]any)
						if value == "missing" {
							delete(principal, field)
						} else {
							principal[field] = value
						}
						return cacheTestResponse(payload), nil
					})
					defer client.Close()
					client.SessionFeedCaughtUp(time.Now())
					for range 2 {
						if principal, err := client.Resolve(context.Background(), "token"); err == nil || principal.Active || principal.ResolveCacheHit {
							t.Error("malformed authority was admitted or retained")
						}
					}
					if calls.Load() != 2 {
						t.Error("malformed principal became a positive cache entry")
					}
				})
			})
		}
	}
}
