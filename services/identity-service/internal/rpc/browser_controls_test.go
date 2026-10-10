package rpc

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
)

type browserRPCService struct {
	calls       int
	callerSID   string
	list        browsersessions.ListInput
	revoke      browsersessions.RevokeInput
	feed        browsersessions.RevocationQuery
	password    browsersessions.PasswordInput
	passwordErr error
	sessions    []browsersessions.Session
	feedEvents  []domain.SessionRevocation
}

func (s *browserRPCService) record(ctx context.Context) error {
	caller, err := callercontext.CallerFromContext(ctx)
	if err != nil {
		return err
	}
	s.calls++
	s.callerSID = caller.Claims().Session
	return nil
}
func (s *browserRPCService) Touch(ctx context.Context, _ string) (browsersessions.Deadlines, error) {
	err := s.record(ctx)
	return browsersessions.Deadlines{ExpiresAt: time.Now().Add(time.Hour), IdleExpiresAt: time.Now().Add(time.Minute), ActivityIntervalMS: 30000}, err
}
func (s *browserRPCService) List(ctx context.Context, input browsersessions.ListInput) (browsersessions.Page, error) {
	s.list = input
	sessions := s.sessions
	if sessions == nil {
		sessions = []browsersessions.Session{}
	}
	return browsersessions.Page{Sessions: sessions}, s.record(ctx)
}
func (s *browserRPCService) Revoke(ctx context.Context, input browsersessions.RevokeInput) (browsersessions.RevokeResult, error) {
	s.revoke = input
	return browsersessions.RevokeResult{RevokedCount: 2}, s.record(ctx)
}
func (s *browserRPCService) ListRevocations(_ context.Context, query browsersessions.RevocationQuery) (domain.SessionRevocationPage, error) {
	s.calls++
	s.feed = query
	page := domain.SessionRevocationPage{Events: s.feedEvents, NextSequence: query.AfterSequence}
	if page.Events == nil {
		page.Events = []domain.SessionRevocation{}
	}
	if len(page.Events) > 0 {
		page.NextSequence = page.Events[len(page.Events)-1].Sequence
	}
	return page, nil
}

func (s *browserRPCService) ChangePassword(ctx context.Context, input browsersessions.PasswordInput) (browsersessions.PasswordResult, error) {
	s.password = input
	if err := s.record(ctx); err != nil {
		return browsersessions.PasswordResult{}, err
	}
	if s.passwordErr != nil {
		return browsersessions.PasswordResult{}, s.passwordErr
	}
	return browsersessions.PasswordResult{Status: "changed", LoginResult: localauth.LoginResult{
		Principal: domain.Principal{UserID: "admin", OrganizationID: "org-1", OrganizationSlug: "engineering", OrganizationName: "Engineering", MembershipID: "membership-1", SystemRole: domain.SystemRoleAdmin, OrganizationRole: domain.OrganizationRoleAdmin, Active: true},
		TokenID:   "replacement-session", AccessToken: "replacement-opaque-credential", ExpiresAt: time.Now().Add(time.Hour), IdleExpiresAt: time.Now().Add(time.Minute), ActivityIntervalMS: 30000,
	}}, nil
}

func browserRPC(t *testing.T) (*Handler, Dependencies, *rpcSessionStub, *browserRPCService, string) {
	t.Helper()
	services, browser := &rpcServicesStub{}, &browserRPCService{}
	deps, sessions := authenticationDependencies(t, Dependencies{Directory: services, LocalAuth: services, OIDC: services, SCIM: services, BrowserSessions: browser})
	_, cct, err := deps.CallerContext.Issue(t.Context(), "raw-credential", "session", "")
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(deps)
	if err != nil {
		t.Fatal(err)
	}
	return handler, deps, sessions, browser, cct
}

func browserRPCRequest(handler http.Handler, path, body, workload, cct string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(serviceauth.Header, "Bearer "+workload)
	if cct != "" {
		request.Header.Set(callercontext.Header, cct)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestBrowserRPCRequiresGatewayCallerContextAndPreservesSignedAuthority(t *testing.T) {
	for _, route := range []struct{ name, body string }{
		{"touch-browser-session", `{"actor_principal_id":"admin"}`},
		{"list-user-sessions", `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10}`},
		{"revoke-user-sessions", `{"request_id":"revoke-1","actor_principal_id":"admin","user_id":"admin","scope":"self","mode":"others"}`},
	} {
		for _, authority := range []string{"live", "missing", "forged", "revoked", "wrong-workload"} {
			t.Run(route.name+"/"+authority, func(t *testing.T) {
				handler, _, sessions, browser, cct := browserRPC(t)
				workload, want := gatewayTestToken, http.StatusOK
				switch authority {
				case "missing":
					cct = ""
					want = http.StatusUnauthorized
				case "forged":
					cct = "forged"
					want = http.StatusUnauthorized
				case "revoked":
					sessions.err = domain.ErrNotFound
					want = http.StatusUnauthorized
				case "wrong-workload":
					workload = controllerTestToken
					want = http.StatusForbidden
				}
				response := browserRPCRequest(handler, "/rpc/identity/"+route.name, route.body, workload, cct)
				if response.Code != want {
					t.Fatalf("browser admission status=%d want=%d", response.Code, want)
				}
				if authority == "live" {
					if browser.calls != 1 || browser.callerSID != "session-1" || response.Header().Get("Cache-Control") != "no-store" {
						t.Fatal("live Gateway CCT was not preserved in typed context")
					}
				} else if browser.calls != 0 {
					t.Fatal("unauthorized browser request reached application service")
				}
			})
		}
	}
}

func TestBrowserRPCStrictRequestsRejectCallerSelectedAuthority(t *testing.T) {
	for _, test := range []struct {
		path, body string
		status     int
	}{
		{"touch-browser-session", `{"actor_principal_id":"admin","token_id":"chosen"}`, 400},
		{"touch-browser-session", `{"actor_principal_id":"other"}`, 403},
		{"touch-browser-session", `{}`, 400},
		{"list-user-sessions", `{"actor_principal_id":"admin","user_id":"admin","scope":"self"}`, 400},
		{"list-user-sessions", `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10,"after_id":""}`, 400},
		{"list-user-sessions", `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10,"after_id":null}`, 400},
		{"list-user-sessions", `{"actor_principal_id":"admin","user_id":"admin","scope":"self","limit":10,"organization_id":"org-1"}`, 400},
		{"revoke-user-sessions", `{"request_id":"r","actor_principal_id":"admin","user_id":"admin","scope":"self","mode":"others","except_token_id":"chosen"}`, 400},
		{"revoke-user-sessions", `{"request_id":"r","actor_principal_id":"admin","user_id":"admin","scope":"self"}`, 400},
	} {
		t.Run(test.path+"/"+test.body, func(t *testing.T) {
			h, _, _, service, cct := browserRPC(t)
			response := browserRPCRequest(h, "/rpc/identity/"+test.path, test.body, gatewayTestToken, cct)
			if response.Code != test.status || service.calls != 0 {
				t.Fatalf("malformed browser request reached service: status=%d calls=%d", response.Code, service.calls)
			}
		})
	}
}

func TestBrowserRPCConsoleScopeAndWorkloadOnlySessionFeed(t *testing.T) {
	for _, route := range []struct {
		name, body string
		allowed    bool
	}{
		{"touch-browser-session", `{"actor_principal_id":"admin"}`, false},
		{"list-user-sessions", `{"actor_principal_id":"admin","user_id":"target","scope":"organization","limit":100,"after_id":"public-1"}`, true},
		{"revoke-user-sessions", `{"request_id":"r","actor_principal_id":"admin","user_id":"target","scope":"organization","mode":"all"}`, true},
	} {
		t.Run(route.name, func(t *testing.T) {
			h, deps, _, service, _ := browserRPC(t)
			_, cct, err := deps.CallerContext.Issue(t.Context(), "raw", "console", "")
			if err != nil {
				t.Fatal(err)
			}
			r := browserRPCRequest(h, "/rpc/identity/"+route.name, route.body, consoleTestToken, cct)
			if route.allowed {
				if r.Code != 200 || service.calls != 1 || service.callerSID != "session-1" {
					t.Fatalf("authorized Console route failed: %d", r.Code)
				}
				if route.name == "list-user-sessions" && (service.list.Scope != "organization" || service.list.UserID != "target" || service.list.AfterID != "public-1" || service.list.Limit != 100) {
					t.Fatal("inventory inputs were not preserved")
				}
				if route.name == "revoke-user-sessions" && (service.revoke.Scope != "organization" || service.revoke.UserID != "target" || service.revoke.Mode != "all") {
					t.Fatal("revocation inputs were not preserved")
				}
			} else if r.Code != 403 || service.calls != 0 {
				t.Fatal("Console was allowed to record browser activity")
			}
		})
	}
	for _, workload := range []string{gatewayTestToken, consoleTestToken, controllerTestToken} {
		h, _, _, service, _ := browserRPC(t)
		r := browserRPCRequest(h, "/rpc/identity/list-session-revocations", `{"after_sequence":12,"limit":500}`, workload, "")
		if workload != gatewayTestToken {
			if r.Code != 403 || service.calls != 0 {
				t.Fatal("wrong workload read private session feed")
			}
			continue
		}
		if r.Code != 200 || service.calls != 1 || service.feed.AfterSequence != 12 || service.feed.Limit != 500 {
			t.Fatalf("workload-only session feed failed: %d", r.Code)
		}
		var page domain.SessionRevocationPage
		if err := json.Unmarshal(r.Body.Bytes(), &page); err != nil || page.NextSequence != 12 || page.Events == nil {
			t.Fatalf("feed wire response: %v", err)
		}
	}
}

func TestBrowserRPCPasswordUsesGatewayAtomicRotationAndRetiresConsolePath(t *testing.T) {
	for _, state := range []string{"live", "missing", "console", "wrong-password", "actor-spoof"} {
		t.Run(state, func(t *testing.T) {
			h, _, _, service, cct := browserRPC(t)
			body := `{"request_id":"password-1","actor_principal_id":"admin","user_id":"admin","current_password":"current password value","new_password":"replacement password value"}`
			workload, want, calls := gatewayTestToken, 200, 1
			switch state {
			case "missing":
				cct = ""
				want, calls = 401, 0
			case "console":
				workload = consoleTestToken
				want, calls = 403, 0
			case "wrong-password":
				service.passwordErr = domain.InvalidArgument("Current password is incorrect")
				want = 400
			case "actor-spoof":
				body = strings.Replace(body, `"actor_principal_id":"admin"`, `"actor_principal_id":"victim"`, 1)
				want, calls = 403, 0
			}
			r := browserRPCRequest(h, "/rpc/identity/change-local-password", body, workload, cct)
			if r.Code != want || service.calls != calls {
				t.Fatalf("password route did not enforce atomic Gateway authority: status=%d calls=%d", r.Code, service.calls)
			}
			if state == "live" {
				var result browsersessions.PasswordResult
				if err := json.Unmarshal(r.Body.Bytes(), &result); err != nil || result.Status != "changed" || result.AccessToken == "" || result.TokenID != "replacement-session" || result.ActivityIntervalMS != 30000 || result.ExpiresAt.IsZero() || result.IdleExpiresAt.IsZero() {
					t.Fatalf("password route discarded replacement session: %v", err)
				}
				if service.callerSID != "session-1" || service.password.RequestID != "password-1" || service.password.UserID != "admin" || service.password.CurrentPassword != "current password value" || service.password.NewPassword != "replacement password value" {
					t.Fatal("atomic password input or original authority was not preserved")
				}
			} else if strings.Contains(r.Body.String(), "replacement-opaque-credential") {
				t.Fatal("failed password request returned a credential")
			}
		})
	}
}

func TestBrowserRPCCurrentAccountRequiresLiveContextForBothWorkloads(t *testing.T) {
	for _, workload := range []string{gatewayTestToken, consoleTestToken} {
		for _, state := range []string{"live", "missing", "revoked"} {
			t.Run(workload[:2]+"/"+state, func(t *testing.T) {
				h, _, sessions, _, cct := browserRPC(t)
				want := 200
				if state == "missing" {
					cct = ""
					want = 401
				}
				if state == "revoked" {
					sessions.err = domain.ErrNotFound
					want = 401
				}
				r := browserRPCRequest(h, "/rpc/identity/get-current-account", `{"actor_principal_id":"admin","organization_id":"org-1"}`, workload, cct)
				if r.Code != want || r.Header().Get("Cache-Control") != "no-store" {
					t.Fatalf("account route has wrong live authority requirement: %d", r.Code)
				}
			})
		}
	}
}
