package rpc

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestSCIMLifecycleRPCAcceptsOnlyBoundedIntegerTTL(t *testing.T) {
	for _, tc := range []struct {
		name, fields string
		valid        bool
	}{
		{"omitted", "", true},
		{"minimum", `,"expires_in_days":1`, true},
		{"ordinary", `,"expires_in_days":30`, true},
		{"maximum", `,"expires_in_days":365`, true},
		{"zero", `,"expires_in_days":0`, false},
		{"negative", `,"expires_in_days":-1`, false},
		{"too-large", `,"expires_in_days":366`, false},
		{"overflow", `,"expires_in_days":999999999999999999999`, false},
		{"null", `,"expires_in_days":null`, false},
		{"fraction", `,"expires_in_days":1.5`, false},
		{"string", `,"expires_in_days":"90"`, false},
		{"boolean", `,"expires_in_days":true`, false},
		{"array", `,"expires_in_days":[90]`, false},
		{"object", `,"expires_in_days":{}`, false},
		{"client-issuer", `,"issued_by":"someone-else"`, false},
		{"client-expiry", `,"expires_at":"2099-01-01T00:00:00Z"`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h, deps, _, _, _ := browserRPC(t)
			_, cct, err := deps.CallerContext.Issue(t.Context(), "raw-credential", "console", "")
			if err != nil {
				t.Fatal(err)
			}
			service := &pairedTokenRPCService{}
			h.dependencies.SCIM = service
			body := `{"request_id":"lifecycle-token","actor_principal_id":"admin","organization_id":"org-1","name":"Directory","scopes":["scim:read","scim:write"]` + tc.fields + `}`
			response := browserRPCRequest(h, ContractRoutes["issue_scim_token"], body, consoleTestToken, cct)
			wantStatus, wantCalls := http.StatusBadRequest, 0
			if tc.valid {
				wantStatus, wantCalls = http.StatusOK, 1
			}
			if response.Code != wantStatus || service.calls != wantCalls {
				t.Fatalf("status=%d calls=%d want=%d/%d body=%s", response.Code, service.calls, wantStatus, wantCalls, response.Body.String())
			}
			if tc.valid {
				var input struct {
					ExpiresInDays *int `json:"expires_in_days"`
				}
				if err := json.Unmarshal([]byte(body), &input); err != nil {
					t.Fatal(err)
				}
				got := service.input.ExpiresInDays
				if (got == nil) != (input.ExpiresInDays == nil) || got != nil && *got != *input.ExpiresInDays {
					t.Fatalf("TTL presence or value changed before service: got=%v want=%v", got, input.ExpiresInDays)
				}
			}
		})
	}
}
