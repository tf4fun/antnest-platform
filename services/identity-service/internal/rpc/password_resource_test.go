package rpc

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type passwordRPCService struct {
	*rpcServicesStub
	err   error
	calls int
}

func (s *passwordRPCService) Login(context.Context, localauth.LoginInput) (localauth.LoginResult, error) {
	s.calls++
	return localauth.LoginResult{}, s.err
}

func (s *passwordRPCService) CreateLocalUser(context.Context, directory.CreateLocalUserInput) (directory.CreateLocalUserResult, error) {
	s.calls++
	return directory.CreateLocalUserResult{}, s.err
}

func TestPasswordRPCBusyIsCanonicalAcrossAllResourceConsumers(t *testing.T) {
	for _, route := range []struct{ name, body string }{
		{"local_login", `{"request_id":"login-1","organization_slug":"engineering","email":"alice@example.com","password":"password value"}`},
		{"create_local_user", `{"request_id":"create-1","actor_principal_id":"admin","organization_id":"org-1","email":"alice@example.com","display_name":"Alice","password":"password value","role":"member"}`},
		{"change_local_password", `{"request_id":"change-1","actor_principal_id":"admin","user_id":"admin","current_password":"current password value","new_password":"new password value"}`},
	} {
		t.Run(route.name, func(t *testing.T) {
			failure := fmt.Errorf("private context: %w", domain.WithCause(domain.NewError("credential_busy", "PASSWORD-CANARY", false), errors.New("PRIVATE-CAUSE-CANARY")))
			services := &passwordRPCService{rpcServicesStub: &rpcServicesStub{}, err: failure}
			browser := &browserRPCService{passwordErr: failure}
			handler := authenticatedBusinessHandler(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services, BrowserSessions: browser})
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes[route.name], strings.NewReader(route.body)))
			want := map[string]any{"code": "credential_busy", "message": "Password verification is busy", "retryable": true}
			var got map[string]any
			if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if response.Code != http.StatusServiceUnavailable || !reflect.DeepEqual(got, want) || response.Header().Get("Retry-After") != "1" || response.Header().Get("Cache-Control") != "no-store" || len(response.Header().Values("Set-Cookie")) != 0 || services.calls+browser.calls != 1 {
				t.Fatalf("password busy projection is not canonical: status=%d calls=%d", response.Code, services.calls+browser.calls)
			}
		})
	}
}

func TestPasswordRPCInternalFailureIsNotCredentialBusy(t *testing.T) {
	response := httptest.NewRecorder()
	writeError(response, errors.New("PRIVATE-FAILURE-CANARY"))
	var got map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if response.Code != http.StatusInternalServerError || got["code"] != "internal_error" || response.Header().Get("Retry-After") != "" || strings.Contains(response.Body.String(), "CANARY") {
		t.Fatal("internal failure was exposed or converted to resource pressure")
	}
}
