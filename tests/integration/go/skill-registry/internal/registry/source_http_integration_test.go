package registry

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestHTTPAgentSourceChecksSelectedBytesAndRefusesRedirects(t *testing.T) {
	archive := skillZIP(t, "---\nname: code-review\ndescription: Review code\n---\nBody.\n")
	pkg, err := ValidatePackage(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	p := Projection{OrganizationID: testOrg, AgentID: testAgent, OwnerID: testActor, Name: pkg.Name, Description: pkg.Description, Sequence: 1, ContentDigest: pkg.ContentDigest, Active: true}
	var state atomic.Value
	state.Store("ok")
	var called atomic.Int64
	sourceToken := randomToken(t)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called.Add(1)
		mode := state.Load().(string)
		if r.Header.Get("Antnest-Service-Authorization") != "Bearer "+sourceToken || r.Header.Get("Authorization") != "" || r.Header.Get("Antnest-Caller-Context") != "" {
			t.Error("source token missing")
		}
		switch mode {
		case "redirect":
			w.Header().Set("Location", "/unexpected")
			w.WriteHeader(302)
			return
		case "unavailable":
			w.WriteHeader(503)
			_, _ = w.Write([]byte("PRIVATE_SECRET"))
			return
		case "missing":
			w.WriteHeader(404)
			return
		}
		if r.URL.Path == "/internal/skill-sources/inspect" {
			var in struct {
				OrganizationID string      `json:"organization_id"`
				ActorID        string      `json:"actor_id"`
				Sources        []SourceKey `json:"sources"`
			}
			if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.ActorID != testActor || len(in.Sources) != 1 {
				t.Errorf("bad inspect request: %+v %v", in, err)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"items": []Projection{p}})
			return
		}
		var in SourceArtifactInput
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil || in.SkillRef.Sequence != 1 || in.ExpectedDigest != pkg.ContentDigest {
			t.Errorf("bad artifact request: %+v %v", in, err)
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Length", strconv.Itoa(len(archive)))
		w.Header().Set("X-Antnest-Artifact-Digest", pkg.ArtifactDigest)
		w.Header().Set("X-Antnest-Content-Digest", pkg.ContentDigest)
		w.Header().Set("X-Antnest-Source-Sequence", "1")
		if mode == "changed" {
			w.Header().Set("X-Antnest-Source-Sequence", "2")
		}
		if mode == "corrupt" {
			w.Header().Set("X-Antnest-Artifact-Digest", "sha256:"+strings.Repeat("f", 64))
		}
		_, _ = w.Write(archive)
	}))
	defer peer.Close()
	source, err := newTestSource(t, peer.URL, sourceToken)
	if err != nil {
		t.Fatal(err)
	}
	items, err := source.Inspect(context.Background(), testOrg, testActor, []SourceKey{{AgentID: testAgent, Name: pkg.Name}})
	if err != nil || len(items) != 1 || items[0] != p {
		t.Fatalf("inspect: %+v %v", items, err)
	}
	in := SourceArtifactInput{OrganizationID: testOrg, ActorID: testActor, SkillRef: projectionItem(p).SkillRef, ExpectedDigest: p.ContentDigest}
	data, err := source.Artifact(context.Background(), in)
	if err != nil || !bytes.Equal(data, archive) {
		t.Fatalf("fetch: %v", err)
	}
	for _, check := range []struct{ mode, code string }{{"changed", "content_changed"}, {"corrupt", "source_invalid"}, {"redirect", "source_unavailable"}, {"missing", "not_found"}, {"unavailable", "source_unavailable"}} {
		state.Store(check.mode)
		before := called.Load()
		_, err := source.Artifact(context.Background(), in)
		if Code(err) != check.code || strings.Contains(err.Error(), "PRIVATE_SECRET") {
			t.Fatalf("%s: %v", check.mode, err)
		}
		if called.Load() != before+1 {
			t.Fatal("followed redirect or retried")
		}
	}
}
func TestHTTPAgentSourceCancellationClosesInFlightRequest(t *testing.T) {
	entered := make(chan struct{})
	stopped := make(chan struct{})
	sourceToken := randomToken(t)
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		<-r.Context().Done()
		close(stopped)
	}))
	defer peer.Close()
	source, err := newTestSource(t, peer.URL, sourceToken)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := source.Inspect(ctx, testOrg, testActor, []SourceKey{{AgentID: testAgent, Name: "code-review"}})
		done <- err
	}()
	select {
	case <-entered:
	case <-ctx.Done():
		t.Fatal("source request did not start")
	}
	cancel()
	if err := <-done; err == nil {
		t.Fatal("cancellation was ignored")
	}
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("source did not observe cancellation")
	}
}
