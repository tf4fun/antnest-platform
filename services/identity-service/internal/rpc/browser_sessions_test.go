package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/oidcflow"
)

type browserHintServices struct {
	*rpcServicesStub
	hint  string
	calls int
}

func (s *browserHintServices) Login(_ context.Context, input localauth.LoginInput) (localauth.LoginResult, error) {
	s.hint, s.calls = input.UserAgentHint, s.calls+1
	return localauth.LoginResult{}, nil
}

func (s *browserHintServices) StartLogin(_ context.Context, input oidcflow.StartLoginInput) (oidcflow.StartLoginResult, error) {
	s.hint, s.calls = input.UserAgentHint, s.calls+1
	return oidcflow.StartLoginResult{}, nil
}

func TestRPCBrowserLoginForwardsDisplayHint(t *testing.T) {
	for _, method := range []string{"local_login", "start_oidc_login"} {
		for _, hint := range []string{"", strings.Repeat("界", 256)} {
			t.Run(method+"/"+map[bool]string{true: "omitted", false: "unicode-limit"}[hint == ""], func(t *testing.T) {
				services := &browserHintServices{rpcServicesStub: &rpcServicesStub{}}
				handler := authenticatedBusinessHandler(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services})
				body := map[string]string{"request_id": "login-hint", "organization_slug": "engineering"}
				if method == "local_login" {
					body["email"], body["password"] = "member@example.com", "password"
				} else {
					body["provider_name"] = "workforce"
				}
				if hint != "" {
					body["user_agent_hint"] = hint
				}
				raw, err := json.Marshal(body)
				if err != nil {
					t.Fatal(err)
				}
				response := httptest.NewRecorder()
				handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, ContractRoutes[method], strings.NewReader(string(raw))))
				if response.Code != http.StatusOK || services.calls != 1 || services.hint != hint {
					t.Fatalf("display hint was rejected or lost: status=%d calls=%d", response.Code, services.calls)
				}
			})
		}
	}
}
