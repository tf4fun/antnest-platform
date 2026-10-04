package registryclient

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/modules/service-authentication/serviceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestNativeRegistryClientReloadsCredentialsWithoutProxyOrRedirect(t *testing.T) {
	current, next := registryTestToken, strings.Repeat("A", 43)
	hashes := []string{}
	for _, token := range []string{current, next} {
		hashes = append(hashes, fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(token))))
	}
	encoded, err := json.Marshal(map[string][]string{"runtime-controller": hashes})
	if err != nil {
		t.Fatal(err)
	}
	receiver, err := serviceauth.ParseReceiver("skill-registry", encoded, false)
	if err != nil {
		t.Fatal(err)
	}
	var calls, traps atomic.Int64
	trap := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		traps.Add(1)
		w.WriteHeader(500)
	}))
	t.Cleanup(trap.Close)
	t.Setenv("HTTP_PROXY", trap.URL)
	t.Setenv("HTTPS_PROXY", trap.URL)
	t.Setenv("ALL_PROXY", trap.URL)
	t.Setenv("NO_PROXY", "")
	// Force even loopback through the trap unless the native client clears the
	// inherited proxy. ProxyFromEnvironment otherwise exempts loopback itself.
	proxyURL, err := url.Parse(trap.URL)
	if err != nil {
		t.Fatal(err)
	}
	originalTransport := http.DefaultTransport
	defaultTransport := originalTransport.(*http.Transport).Clone()
	defaultTransport.Proxy = http.ProxyURL(proxyURL)
	http.DefaultTransport = defaultTransport
	t.Cleanup(func() { http.DefaultTransport = originalTransport; defaultTransport.CloseIdleConnections() })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := receiver.Authorize(r, []string{"runtime-controller"}); err != nil {
			t.Error("native Registry client omitted or malformed workload authority")
			w.WriteHeader(401)
			return
		}
		for _, name := range []string{"Authorization", "Cookie", "X-Antnest-Principal-ID"} {
			if r.Header.Get(name) != "" {
				t.Error("native Registry client forwarded untrusted identity")
			}
		}
		calls.Add(1)
		w.Header().Set("Location", trap.URL)
		w.WriteHeader(302)
	}))
	t.Cleanup(server.Close)
	dir := t.TempDir()
	callers, sender := filepath.Join(dir, "callers.json"), filepath.Join(dir, "skill-registry")
	if err := os.WriteFile(callers, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(sender, []byte(current), 0o600); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{"ANTNEST_SERVICE_AUTH_MODE": "token", "ANTNEST_SERVICE_AUTH_ALLOW_INSECURE_TRANSPORT": "true", "ANTNEST_SERVICE_AUTH_CALLERS_FILE": callers, "ANTNEST_SERVICE_AUTH_TOKEN_DIR": dir}
	auth, err := serviceauth.LoadOutbound("runtime-controller", serviceauth.CallerContextHeaders, func(key string) (string, bool) { value, present := values[key]; return value, present }, map[string]string{"skill-registry": server.URL})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(auth.CloseIdleConnections)
	client, err := New(server.URL, time.Second, auth)
	if err != nil {
		t.Fatal(err)
	}
	frozen := skillset.FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, ArtifactSize: 100}
	for _, token := range []string{current, next, "", next + "\n", current} {
		if err := os.WriteFile(sender, []byte(token), 0o600); err != nil {
			t.Fatal(err)
		}
		before := calls.Load()
		if _, _, err := client.Download(context.Background(), "org-1", frozen); !errors.Is(err, ErrUnavailable) {
			t.Fatalf("redirect or unavailable credential was not a safe failure: %v", err)
		}
		want := int64(1)
		if token == "" || strings.HasSuffix(token, "\n") {
			want = 0
		}
		if calls.Load()-before != want || traps.Load() != 0 {
			t.Fatal("credential fallback, redirect or environment proxy reached a destination")
		}
	}
}
