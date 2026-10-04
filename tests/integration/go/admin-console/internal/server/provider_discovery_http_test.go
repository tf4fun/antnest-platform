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

func TestProviderDiscoveryRealHTTPUsesPrivateControllerAndUnchangedSignedScope(t *testing.T) {
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		t.Fatal(err)
	}
	workload := base64.RawURLEncoding.EncodeToString(secret)
	const draftKey = "synthetic-provider-key-not-a-real-credential"
	type call struct {
		path, context string
		body          map[string]any
	}
	var mu sync.Mutex
	var calls []call
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get(serviceauth.Header) != "Bearer "+workload ||
			r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.Header.Get(principal.HeaderUserID) != "" {
			t.Error("discovery used a wrong method, unsigned hints or browser credentials")
			w.WriteHeader(401)
			return
		}
		var input map[string]any
		if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || input["organization_id"] != "org-1" {
			t.Error("discovery lost its verified Organization scope")
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		calls = append(calls, call{r.URL.Path, r.Header.Get(callercontext.Header), input})
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/provider-connections/saved/discover-models":
			if len(input) != 1 {
				t.Error("saved discovery must send scope only")
			}
			_, _ = w.Write([]byte(`{"models":[{"model_id":"remote","display_name":"Remote","supports_images":false,"context_window":128000,"api_key":"` + draftKey + `"}],"credential":{"api_key":"` + draftKey + `"}}`))
		case "/internal/provider-discovery/draft":
			if input["base_url"] != "http://127.0.0.1:1/v1" || input["credential"].(map[string]any)["api_key"] != draftKey {
				t.Error("draft was not forwarded to Controller unchanged")
			}
			w.WriteHeader(422)
			_, _ = w.Write([]byte(`{"code":"provider_endpoint_forbidden","message":"` + draftKey + ` at http://private/","retryable":false}`))
		default:
			t.Error("discovery used a retired credential route")
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(controller.Close)
	dir := t.TempDir()
	callersFile := filepath.Join(dir, "callers.json")
	if err := os.WriteFile(callersFile, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "agent-controller"), []byte(workload), 0600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callersFile, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
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
	var contexts []string
	for _, step := range []struct {
		method, path, body string
		status             int
	}{
		{http.MethodGet, "/api/admin/provider-connections/saved/models/discovery", "", 200},
		{http.MethodPost, "/api/admin/provider-models/discovery", `{"provider_key":"deepseek","base_url":"http://127.0.0.1:1/v1","credential":{"method":"api_key","api_key":"` + draftKey + `"}}`, 422},
	} {
		cct := h.sign(actor, "", nil)
		contexts = append(contexts, cct)
		r, err := http.NewRequest(step.method, console.URL+step.path, strings.NewReader(step.body))
		if err != nil {
			t.Fatal(err)
		}
		r.Header.Set(serviceauth.Header, "Bearer "+h.token)
		r.Header.Set(callercontext.Header, cct)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer browser-private")
		r.Header.Set("Cookie", "browser=private")
		r.Header.Set(principal.HeaderOrganizationID, "forged-org")
		response, err := console.Client().Do(r)
		if err != nil {
			t.Fatal(err)
		}
		body, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != step.status || response.Header.Get("Cache-Control") != "no-store" || len(response.Header.Values("Cache-Control")) != 1 || strings.Contains(string(body), draftKey) || strings.Contains(string(body), "http://private") {
			t.Fatalf("discovery returned unsafe response: status=%d", response.StatusCode)
		}
		if step.status == 200 && !strings.Contains(string(body), `"supports_images":false`) {
			t.Fatal("model metadata was not preserved")
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != len(contexts) {
		t.Fatalf("got %d calls, expected %d", len(calls), len(contexts))
	}
	for i, got := range calls {
		if got.context != contexts[i] {
			t.Fatal("Console replaced the verified CCT")
		}
	}
}
