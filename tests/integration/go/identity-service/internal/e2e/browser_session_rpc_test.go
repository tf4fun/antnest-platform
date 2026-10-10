package e2e

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/browsersessions"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/callercontext"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/credentials"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/directory"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/domain"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/localauth"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/rpc"
	"github.com/tf4fun/antnest-platform/services/identity-service/internal/scim"
)

func TestBrowserSessionRPCUsesRealAuthorityApplicationAndPostgres(t *testing.T) {
	oidc := browserOIDCFixture(t)
	f := browserControlsForFixture(t, oidc.localAdmissionFixture, &oidc.now)
	if err := f.store.InitializeBrowserSessions(t.Context(), 5*time.Second); err != nil {
		t.Fatal(err)
	}
	authentication, _, tokens := identityTestAuthentication(t, f.store)
	scimService, err := scim.NewService(scim.Config{Repository: f.store.SCIM(), NewID: f.newID, NewOpaque: credentials.NewOpaqueToken, Now: f.clock})
	if err != nil {
		t.Fatal(err)
	}
	h, err := rpc.NewHandler(rpc.Dependencies{Directory: directory.NewService(f.store.Directory(), f.newID, f.clock), LocalAuth: f.auth, OIDC: oidc.flow, SCIM: scimService, BrowserSessions: f.service, Authentication: authentication, CallerContext: f.authority})
	if err != nil {
		t.Fatal(err)
	}
	call := func(method string, body any, workload, cct string, status int, result any) []byte {
		t.Helper()
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, rpc.ContractRoutes[method], bytes.NewReader(raw)).WithContext(t.Context())
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set(serviceauth.Header, "Bearer "+tokens[workload])
		if cct != "" {
			request.Header.Set(callercontext.Header, cct)
		}
		response := httptest.NewRecorder()
		h.ServeHTTP(response, request)
		if response.Code != status {
			t.Fatalf("real %s RPC status=%d want=%d", method, response.Code, status)
		}
		if status == http.StatusOK && response.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("session response permits caching")
		}
		if result != nil {
			if err := json.Unmarshal(response.Body.Bytes(), result); err != nil {
				t.Fatal(err)
			}
		}
		return response.Body.Bytes()
	}
	loginBody := map[string]any{"request_id": "rpc-browser-login", "organization_slug": "admission", "email": "member@example.com", "password": "correct horse battery staple", "user_agent_hint": "Browser <script>"}
	var current, other localauth.LoginResult
	call("local_login", loginBody, "edge-gateway", "", 200, &current)
	call("local_login", loginBody, "edge-gateway", "", 200, &other)
	if current.AccessToken == "" || current.TokenID == other.TokenID || current.ActivityIntervalMS != 1666 || !current.IdleExpiresAt.Equal(f.clock().Add(5*time.Second)) {
		t.Fatal("real login lost fresh credential or session policy")
	}
	contextFor := func(raw, profile string) string {
		t.Helper()
		var resolved struct {
			CallerContext string `json:"caller_context"`
		}
		call("resolve_access_token", map[string]any{"access_token": raw, "profile": profile}, "edge-gateway", "", 200, &resolved)
		if resolved.CallerContext == "" {
			t.Fatal("real resolution did not issue CCT")
		}
		return resolved.CallerContext
	}
	cct := contextFor(current.AccessToken, "session")
	consoleCCT := contextFor(current.AccessToken, "console")
	list := map[string]any{"actor_principal_id": f.user.User.ID, "user_id": f.user.User.ID, "scope": "self", "limit": 100}
	call("list_user_sessions", list, "edge-gateway", "", 401, nil)
	call("list_session_revocations", map[string]any{"after_sequence": 0, "limit": 500}, "admin-console", consoleCCT, 403, nil)
	var page browsersessions.Page
	raw := call("list_user_sessions", list, "edge-gateway", cct, 200, &page)
	if len(page.Sessions) != 2 || page.Sessions[0].Current == page.Sessions[1].Current {
		t.Fatal("real inventory lost signed current-session identity")
	}
	for _, secret := range []string{current.AccessToken, other.AccessToken, current.TokenID, other.TokenID, credentials.HashToken(current.AccessToken)} {
		if strings.Contains(string(raw), secret) {
			t.Fatal("public RPC exposed credential or private SID")
		}
	}
	accountBody := map[string]any{"actor_principal_id": f.user.User.ID, "organization_id": f.admin.Organization.ID}
	for workload, context := range map[string]string{"edge-gateway": cct, "admin-console": consoleCCT} {
		var result struct {
			Account directory.CurrentAccount `json:"account"`
		}
		call("get_current_account", accountBody, workload, context, 200, &result)
		if !result.Account.LocalPasswordAvailable || result.Account.OrganizationSlug != "admission" || result.Account.UserID != f.user.User.ID {
			t.Fatal("real account projection lost credential availability or Organization metadata")
		}
	}
	f.now.Add(int64(time.Second))
	var activity browsersessions.Deadlines
	call("touch_browser_session", map[string]any{"actor_principal_id": f.user.User.ID}, "edge-gateway", cct, 200, &activity)
	if !activity.ExpiresAt.Equal(current.ExpiresAt) || !activity.IdleExpiresAt.Equal(f.clock().Add(5*time.Second)) {
		t.Fatal("real activity changed absolute deadline or failed to extend idle")
	}
	password := map[string]any{"request_id": "rpc-password", "actor_principal_id": f.user.User.ID, "user_id": f.user.User.ID, "current_password": "incorrect password value", "new_password": "new correct password value"}
	call("change_local_password", password, "edge-gateway", cct, 400, nil)
	call("change_local_password", password, "admin-console", consoleCCT, 403, nil)
	call("get_current_account", accountBody, "edge-gateway", cct, 200, nil)
	var revoked browsersessions.RevokeResult
	revoke := map[string]any{"request_id": "rpc-revoke", "actor_principal_id": f.user.User.ID, "user_id": f.user.User.ID, "scope": "self", "mode": "others"}
	call("revoke_user_sessions", revoke, "edge-gateway", cct, 200, &revoked)
	if revoked.RevokedCount != 1 || revoked.CurrentRevoked {
		t.Fatal("others mode did not preserve signed current SID")
	}
	password["current_password"] = "correct horse battery staple"
	var rotated browsersessions.PasswordResult
	call("change_local_password", password, "edge-gateway", cct, 200, &rotated)
	if rotated.AccessToken == "" || rotated.TokenID == current.TokenID || !rotated.ExpiresAt.Equal(current.ExpiresAt) {
		t.Fatal("real password RPC did not return an atomic replacement")
	}
	call("get_current_account", accountBody, "edge-gateway", cct, 401, nil)
	call("change_local_password", password, "edge-gateway", cct, 401, nil)
	currentCCT := contextFor(rotated.AccessToken, "session")
	call("list_user_sessions", list, "edge-gateway", currentCCT, 200, &page)
	if len(page.Sessions) != 1 || !page.Sessions[0].Current || page.Sessions[0].UserAgentHint != "Browser <script>" {
		t.Fatal("password replacement lost public metadata or old-session retirement")
	}
	revoke["mode"] = "all"
	call("revoke_user_sessions", revoke, "edge-gateway", currentCCT, 200, &revoked)
	if revoked.RevokedCount != 1 || !revoked.CurrentRevoked {
		t.Fatal("all mode failed to retire current SID")
	}
	call("get_current_account", accountBody, "edge-gateway", currentCCT, 401, nil)
	var feed domain.SessionRevocationPage
	call("list_session_revocations", map[string]any{"after_sequence": 0, "limit": 500}, "edge-gateway", "", 200, &feed)
	if len(feed.Events) != 3 || feed.Events[0].TokenID != other.TokenID || feed.Events[1].TokenID != current.TokenID || feed.Events[1].Reason != "password_changed" || feed.Events[2].TokenID != rotated.TokenID {
		t.Fatal("real private feed did not preserve committed rotation/revocation order")
	}
	if len(readRevocations(t, f.localAdmissionFixture, 0, 500).Events) != 0 {
		t.Fatal("browser RPC emitted principal offboarding")
	}
}
