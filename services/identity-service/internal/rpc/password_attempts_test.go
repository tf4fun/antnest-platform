package rpc

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
)

func TestPasswordRPCRateLimitIsCanonicalAndBounded(t *testing.T) {
	for _, route := range []struct{ name, body string }{
		{"local_login", `{"request_id":"login-1","organization_slug":"engineering","email":"alice@example.com","password":"password value"}`},
		{"change_local_password", `{"request_id":"change-1","actor_principal_id":"admin","user_id":"admin","current_password":"current password value","new_password":"new password value"}`},
	} {
		for _, failure := range []struct {
			name  string
			err   error
			retry string
		}{
			{"fractional-second", domain.CredentialRateLimited(time.Second + time.Nanosecond), "2"},
			{"maximum", domain.CredentialRateLimited(15 * time.Minute), "900"},
			{"invalid-low", &domain.CredentialRateLimitError{RetryAfterSeconds: -1}, "1"},
			{"invalid-high", &domain.CredentialRateLimitError{RetryAfterSeconds: 901}, "900"},
			{"private-message", domain.NewError("credential_rate_limited", "PRIVATE-MESSAGE-CANARY", false), "1"},
		} {
			t.Run(route.name+"/"+failure.name, func(t *testing.T) {
				wrapped := fmt.Errorf("PRIVATE-CONTEXT-CANARY: %w", errors.Join(failure.err, errors.New("PRIVATE-CAUSE-CANARY")))
				services := &passwordRPCService{rpcServicesStub: &rpcServicesStub{}, err: wrapped}
				browser := &browserRPCService{passwordErr: wrapped}
				handler := authenticatedBusinessHandler(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services, BrowserSessions: browser})
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes[route.name], strings.NewReader(route.body)))
				want := map[string]any{"code": "credential_rate_limited", "message": "Too many password attempts", "retryable": true}
				var got map[string]any
				if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
					t.Fatal(err)
				}
				if response.Code != http.StatusTooManyRequests || !reflect.DeepEqual(got, want) ||
					!reflect.DeepEqual(response.Header().Values("Retry-After"), []string{failure.retry}) ||
					response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Set-Cookie")) != 0 || services.calls+browser.calls != 1 {
					t.Fatalf("rate-limit projection is not canonical: status=%d retry=%q calls=%d", response.Code, response.Header().Values("Retry-After"), services.calls+browser.calls)
				}
			})
		}
	}
}
