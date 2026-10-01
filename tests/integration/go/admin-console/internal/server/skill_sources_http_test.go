package server

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"soft/antnest-platform/services/admin-console/internal/principal"
	"soft/antnest-platform/services/admin-console/internal/upstream"
)

func TestSkillSourceRealHTTPConsumerScopesPreviewAndPromotion(t *testing.T) {
	archive, artifactDigest, contentDigest := sourceArchive(t, "---\nname: code-review\ndescription: Review code\n---\nReview a change.\n")
	token := "console-discovery-component-token-at-least-32-bytes"
	var mu sync.Mutex
	var calls []skillCall
	registry := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+token || r.Header.Get("Cookie") != "" || r.Header.Get(principal.HeaderUserID) != "" {
			t.Error("Registry service connection leaked browser authentication or principal headers")
			w.WriteHeader(401)
			return
		}
		body, err := io.ReadAll(io.LimitReader(r.Body, 4097))
		if err != nil || len(body) > 4096 {
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		calls = append(calls, skillCall{method: r.Method, path: r.URL.Path, body: body})
		mu.Unlock()
		var input map[string]any
		if json.Unmarshal(body, &input) != nil || input["organization_id"] != "org-1" || input["actor_id"] != "user-admin" {
			t.Error("Registry request did not bind the verified browser caller")
			w.WriteHeader(400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/internal/skill-discovery/search":
			_, _ = w.Write([]byte(`{"items":[{"skill_ref":` + sourceRefJSON + `,"name":"code-review","description":"Review code","content_digest":"` + contentDigest + `"}]}`))
		case "/internal/skill-discovery/load":
			w.Header().Set("Content-Type", "application/zip")
			w.Header().Set("X-Antnest-Artifact-Digest", artifactDigest)
			w.Header().Set("X-Antnest-Content-Digest", contentDigest)
			_, _ = w.Write([]byte(archive))
		case "/internal/skill-projections/promote":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"skill_id":"` + sourceTarget + `","version":1,"name":"code-review","description":"Review code","artifact_digest":"` + artifactDigest + `","content_digest":"` + contentDigest + `","artifact_size":` + jsonNumber(len(archive)) + `,"unpacked_size":75,"package_rules_version":1,"actor_id":"hidden"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer registry.Close()
	client, err := upstream.NewRegistryClient(registry.URL, token, &http.Client{Timeout: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	h, err := NewHandler(Config{}, Dependencies{Backend: newBackendStub(), Registry: client, Assets: fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("ok")}}, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	console := httptest.NewServer(h)
	defer console.Close()
	for _, step := range []struct {
		action, body, key string
		status            int
	}{
		{"search", `{"query":"review"}`, "", 200},
		{"preview", sourceSelection(contentDigest), "", 200},
		{"promote", sourceSelection(contentDigest), "source-attempt-0001", 201},
	} {
		request, err := http.NewRequest("POST", console.URL+"/api/admin/skill-sources/"+step.action, strings.NewReader(step.body))
		if err != nil {
			t.Fatal(err)
		}
		request.Header = skillRequest("POST", "/", nil, "application/json", step.key).Header
		request.Header.Set("Cookie", "browser-session=private")
		request.Header.Set("Authorization", "Bearer browser-private-token")
		response, err := console.Client().Do(request)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(response.Body)
		_ = response.Body.Close()
		if err != nil || response.StatusCode != step.status || strings.Contains(string(data), "hidden") || response.Header.Get("Cache-Control") != "no-store" {
			t.Fatalf("step=%s status=%d body=%s", step.action, response.StatusCode, data)
		}
	}
	mu.Lock()
	defer mu.Unlock()
	if len(calls) != 3 || calls[0].path != "/internal/skill-discovery/search" || calls[1].path != "/internal/skill-discovery/load" || calls[2].path != "/internal/skill-projections/promote" {
		t.Fatalf("calls=%v", calls)
	}
}

func jsonNumber(value int) string {
	data, _ := json.Marshal(value)
	return string(data)
}
