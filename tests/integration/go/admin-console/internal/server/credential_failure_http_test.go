package server

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/callercontext"
	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/principal"
	"github.com/tf4fun/antnest-platform/services/admin-console/internal/upstream"
)

func TestCreateLocalUserRealHTTPKeepsSignedScopeAndDoesNotReplay(t *testing.T) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	workload := base64.RawURLEncoding.EncodeToString(secret)
	type step struct {
		status int
		body   string
		retry  []string
		code   string
	}
	steps := []step{
		{503, createUserBusy, []string{"1"}, "credential_busy"},
		{503, createUserBusy, []string{"1", "1"}, "identity_unavailable"},
		{503, `{"code":"credential_busy","message":"private-create-password","retryable":true}`, []string{"1"}, "identity_unavailable"},
		{200, strings.TrimSuffix(createUserSuccess, "}") + `,"code":"credential_busy","retryable":true}`, []string{"1"}, "identity_unavailable"},
		{201, createUserSuccess, nil, ""},
	}
	var mu sync.Mutex
	var contexts []string
	issuer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/rpc/identity/create-local-user" || r.URL.RawQuery != "" ||
			r.Header.Get(serviceauth.Header) != "Bearer "+workload || r.Header.Get("Authorization") != "" ||
			r.Header.Get("Cookie") != "" || r.Header.Get(principal.HeaderUserID) != "" {
			t.Error("create-user forwarded browser credentials or used the wrong owning RPC")
			w.WriteHeader(401)
			return
		}
		var body map[string]any
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body) != nil || len(body) != 7 ||
			body["actor_principal_id"] != "user-admin" || body["organization_id"] != "org-1" ||
			body["password"] != "private-create-password" || body["email"] != "alice@example.com" ||
			!strings.HasPrefix(body["request_id"].(string), "directory-") {
			t.Error("create-user lost verified authority or altered credential input")
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		index := len(contexts)
		contexts = append(contexts, r.Header.Get(callercontext.Header))
		mu.Unlock()
		if index >= len(steps) {
			t.Error("create-user replayed a request")
			w.WriteHeader(500)
			return
		}
		item := steps[index]
		for _, value := range item.retry {
			w.Header().Add("Retry-After", value)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		w.Header().Set("Set-Cookie", "private-create-password=private")
		w.WriteHeader(item.status)
		_, _ = w.Write([]byte(item.body))
	}))
	t.Cleanup(issuer.Close)
	dir := t.TempDir()
	callersFile := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callersFile, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "identity-service"), []byte(workload), 0600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callersFile, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	clients, err := serviceauth.LoadOutbound("admin-console", serviceauth.CallerContextHeaders, func(name string) (string, bool) { value, ok := values[name]; return value, ok }, map[string]string{"identity-service": issuer.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(clients.CloseIdleConnections)
	backend, err := upstream.NewClient(upstream.Config{IdentityURL: issuer.URL, AgentControllerURL: issuer.URL, AgentACPURL: issuer.URL, HTTPClient: clients.HTTPClient()})
	if err != nil {
		t.Fatal(err)
	}
	h := newBusinessHandler(t, Config{}, Dependencies{Backend: backend, Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	console := httptest.NewServer(h.handler)
	t.Cleanup(console.Close)
	actor := principal.Principal{UserID: "user-admin", OrganizationID: "org-1", MembershipID: "member-1", SystemRole: "user", OrganizationRole: "admin"}
	for index, item := range steps {
		cct := h.sign(actor, "", nil)
		request, err := http.NewRequest(http.MethodPost, console.URL+"/api/admin/directory/users", strings.NewReader(createUserRequest))
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set(serviceauth.Header, "Bearer "+h.token)
		request.Header.Set(callercontext.Header, cct)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Idempotency-Key", "create-user-same-explicit-retry")
		request.Header.Set("Authorization", "Bearer private-browser-token")
		request.Header.Set("Cookie", "existing=private-browser-cookie")
		request.Header.Set(principal.HeaderOrganizationID, "forged-org")
		response, err := console.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		wantStatus, wantRetry := 503, ""
		if item.code == "" {
			wantStatus = 201
		}
		if item.code == "credential_busy" {
			wantRetry = "1"
		}
		if err != nil || response.StatusCode != wantStatus || response.Header.Get("Retry-After") != wantRetry ||
			response.Header.Get("Cache-Control") != "no-store" || len(response.Header.Values("Cache-Control")) != 1 || len(response.Cookies()) != 0 {
			t.Fatalf("step %d returned unsafe password response: status=%d", index, response.StatusCode)
		}
		if item.code != "" && !strings.Contains(string(body), `"code":"`+item.code+`"`) {
			t.Fatalf("step %d lost safe failure code", index)
		}
		for _, secret := range []string{workload, cct, "private-create-password", "private-browser-token", "private-browser-cookie", "forged-org"} {
			if strings.Contains(string(body), secret) {
				t.Fatal("response disclosed a private input")
			}
		}
		mu.Lock()
		valid := len(contexts) == index+1 && contexts[index] == cct
		mu.Unlock()
		if !valid {
			t.Fatal("create-user replayed the request or replaced its verified CCT")
		}
	}
	console.Close()
	mu.Lock()
	defer mu.Unlock()
	if len(contexts) != len(steps) {
		t.Fatal("create-user left a replay running after shutdown")
	}
}
