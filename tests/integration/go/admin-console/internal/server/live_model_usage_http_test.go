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

func TestLiveModelUsageRealHTTPScopesVerifiedScopeAndAllowlist(t *testing.T) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	workload := base64.RawURLEncoding.EncodeToString(secret)
	var mu sync.Mutex
	var calls []string
	var upstreamStatus = http.StatusOK
	var upstreamBody = `{"templates":2,"agents":3,"secret":"omitted","organization_id":"org-2"}`
	setUpstream := func(status int, body string) {
		mu.Lock()
		upstreamStatus, upstreamBody = status, body
		mu.Unlock()
	}
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/internal/model-profiles/model-1/usage" ||
			r.URL.Query().Get("organization_id") != "org-1" || len(r.URL.Query()) != 1 ||
			r.Header.Get(serviceauth.Header) != "Bearer "+workload ||
			r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get(principal.HeaderUserID) != "" {
			t.Error("usage forward used a wrong route, unsigned hints or browser credentials")
			w.WriteHeader(401)
			return
		}
		mu.Lock()
		calls = append(calls, r.Header.Get(callercontext.Header))
		status, body := upstreamStatus, upstreamBody
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(controller.Close)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "callers.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-controller"), []byte(workload), 0600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": filepath.Join(dir, "callers.json"), "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	clients, err := serviceauth.LoadOutbound("admin-console", serviceauth.CallerContextHeaders, func(name string) (string, bool) { value, ok := values[name]; return value, ok }, map[string]string{"agent-controller": controller.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(clients.CloseIdleConnections)
	backend, err := upstream.NewClient(upstream.Config{IdentityURL: controller.URL, AgentControllerURL: controller.URL, AgentACPURL: controller.URL, HTTPClient: clients.HTTPClient()})
	if err != nil {
		t.Fatal(err)
	}
	h := newBusinessHandler(t, Config{}, Dependencies{Backend: backend, Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	console := httptest.NewServer(h.handler)
	t.Cleanup(console.Close)
	actor := principal.Principal{UserID: "user-admin", OrganizationID: "org-1", MembershipID: "member-1", SystemRole: "user", OrganizationRole: "admin"}

	var lastSentCCT string
	admin := func(path, body string) (int, string) {
		cct := h.sign(actor, "", nil)
		lastSentCCT = cct
		r, err := http.NewRequest(http.MethodGet, console.URL+path, strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set(serviceauth.Header, "Bearer "+h.token)
		r.Header.Set(callercontext.Header, cct)
		r.Header.Set("Authorization", "Bearer browser-private")
		r.Header.Set("Cookie", "browser=private")
		r.Header.Set(principal.HeaderOrganizationID, "forged-org")
		response, err := console.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		payload, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if response.Header.Get("Cache-Control") != "no-store" {
			t.Fatal("usage response lost no-store")
		}
		return response.StatusCode, string(payload)
	}

	status, body := admin("/api/admin/model-profiles/model-1/usage", "")
	if status != http.StatusOK {
		t.Fatalf("usage returned %d: %s", status, body)
	}
	var usage struct {
		Templates int64 `json:"templates"`
		Agents    int64 `json:"agents"`
	}
	if err := json.Unmarshal([]byte(body), &usage); err != nil || usage.Templates != 2 || usage.Agents != 3 || strings.Contains(body, "omitted") || strings.Contains(body, "org-2") {
		t.Fatalf("usage leaked upstream metadata: %s", body)
	}
	mu.Lock()
	forwarded := append([]string(nil), calls...)
	mu.Unlock()
	if len(forwarded) != 1 || forwarded[0] != lastSentCCT {
		t.Fatalf("Console replaced the verified CCT or called upstream %d times", len(forwarded))
	}

	if code, _ := admin("/api/admin/model-profiles/model-1/usage?organization_id=org-2", ""); code != http.StatusBadRequest {
		t.Fatalf("browser organization query was not rejected: %d", code)
	}
	if code, _ := admin("/api/admin/model-profiles/model-1/usage?extra=1", ""); code != http.StatusBadRequest {
		t.Fatalf("browser query was not rejected: %d", code)
	}
	if code, _ := admin("/api/admin/model-profiles/model-1/usage", `{"templates":9}`); code != http.StatusBadRequest {
		t.Fatalf("browser request body was not rejected: %d", code)
	}
	mu.Lock()
	if len(calls) != 1 {
		t.Fatalf("rejected browser requests reached Controller: %d calls", len(calls))
	}
	mu.Unlock()

	for _, malformed := range []string{
		`{"templates":null,"agents":1}`, `{"templates":-1,"agents":0}`,
		`{"templates":1.5,"agents":0}`, `{"templates":"2","agents":0}`,
	} {
		setUpstream(http.StatusOK, malformed)
		if code, _ := admin("/api/admin/model-profiles/model-1/usage", ""); code != http.StatusBadGateway {
			t.Fatalf("malformed counts were not rejected: %d for %s", code, malformed)
		}
	}
	setUpstream(http.StatusNotFound, `{"code":"not_found","message":"unknown model"}`)
	if code, _ := admin("/api/admin/model-profiles/model-1/usage", ""); code != http.StatusNotFound {
		t.Fatalf("upstream 404 was not preserved: %d", code)
	}
}
