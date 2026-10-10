package identity

import (
	"encoding/json"
	"net/http"
	"testing"
)

func browserSessionResponse(t *testing.T) map[string]any {
	t.Helper()
	payload := organizationResponse(t)
	payload["expires_at"] = "2026-10-12T13:00:00Z"
	payload["idle_expires_at"] = "2026-10-12T01:30:00Z"
	payload["activity_interval_ms"] = 30000
	return payload
}

func TestBrowserSessionClientRequiresCompleteDeadlineMetadata(t *testing.T) {
	for _, method := range []string{"login", "resolve", "oidc", "oidc_replay"} {
		t.Run(method, func(t *testing.T) {
			if _, err := callOrganizationClient(t, method, browserSessionResponse(t)); err != nil {
				t.Fatalf("valid browser session rejected: %v", err)
			}
			for _, invalid := range []struct {
				name, field string
				value       any
			}{
				{"missing-absolute", "expires_at", nil},
				{"missing-idle", "idle_expires_at", nil},
				{"zero-absolute", "expires_at", "0001-01-01T00:00:00Z"},
				{"zero-idle", "idle_expires_at", "0001-01-01T00:00:00Z"},
				{"idle-after-absolute", "idle_expires_at", "2026-10-13T01:30:00Z"},
				{"missing-hint", "activity_interval_ms", nil},
				{"zero-hint", "activity_interval_ms", 0},
				{"negative-hint", "activity_interval_ms", -1},
				{"excessive-hint", "activity_interval_ms", 30001},
				{"fractional-hint", "activity_interval_ms", 1.5},
				{"string-hint", "activity_interval_ms", "30000"},
			} {
				t.Run(invalid.name, func(t *testing.T) {
					payload := browserSessionResponse(t)
					payload[invalid.field] = invalid.value
					if invalid.value == nil {
						delete(payload, invalid.field)
					}
					if _, err := callOrganizationClient(t, method, payload); err == nil || IsCode(err, "unauthenticated") {
						t.Fatal("incomplete Identity metadata must fail as unavailable")
					}
				})
			}
		})
	}
}

func TestBrowserSessionClientUsesSessionOnlyProfileWithoutAgent(t *testing.T) {
	for _, agent := range []string{"", "agent-forbidden"} {
		t.Run("agent="+agent, func(t *testing.T) {
			calls := 0
			client, err := NewClient("http://identity.internal", &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
				calls++
				var input map[string]string
				if err := json.NewDecoder(request.Body).Decode(&input); err != nil {
					t.Fatal(err)
				}
				if input["profile"] != "session" || input["agent_id"] != "" {
					t.Fatal("session-only profile accepted an Agent scope")
				}
				payload, _ := json.Marshal(browserSessionResponse(t))
				return jsonResponse(http.StatusOK, string(payload)), nil
			})})
			if err != nil {
				t.Fatal(err)
			}
			_, err = client.Resolve(WithResolution(t.Context(), "session", agent), "private-token")
			if agent == "" && (err != nil || calls != 1) {
				t.Fatalf("session profile not resolved: calls=%d error=%v", calls, err)
			}
			if agent != "" && (err == nil || calls != 0) {
				t.Fatal("Agent-bound session profile reached Identity")
			}
		})
	}
}
