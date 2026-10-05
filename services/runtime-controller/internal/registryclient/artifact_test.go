package registryclient

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func testArtifact(t *testing.T) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	file, err := writer.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(file, "---\nname: code-review\ndescription: Helpful review\n---\n"); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestDownloadUsesExactScopedVersionAndChecksFrozenArtifact(t *testing.T) {
	artifact := testArtifact(t)
	pkg, err := skillset.InspectArtifact(context.Background(), artifact)
	if err != nil {
		t.Fatal(err)
	}
	frozen := skillset.FrozenSkill{
		SkillID: "skill_11111111111111111111111111111111", Version: 7,
		Name: pkg.Name, Description: pkg.Description,
		ArtifactDigest: pkg.ArtifactDigest, ContentDigest: pkg.ContentDigest,
		ArtifactSize: int64(len(artifact)), UnpackedSize: int64(pkg.UnpackedSize), PackageRulesVersion: 1,
	}
	org := "org_00000000000000000000000000000000"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/internal/skills/"+frozen.SkillID+"/versions/7/artifact" || r.URL.Query().Get("organization_id") != org ||
			r.Header.Get("Antnest-Service-Authorization") != "Bearer "+registryTestToken || r.Header.Get("Authorization") != "" {
			t.Error("wrong scoped/authenticated Registry request")
		}
		w.Header().Set("Content-Type", "application/zip")
		w.Header().Set("Content-Length", strconv.Itoa(len(artifact)))
		w.Header().Set("X-Antnest-Artifact-Digest", pkg.ArtifactDigest)
		_, _ = w.Write(artifact)
	}))
	defer server.Close()
	client, err := newAuthenticatedRegistry(t, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	got, verified, err := client.Download(context.Background(), org, frozen)
	if err != nil || string(got) != string(artifact) || verified.ContentDigest != pkg.ContentDigest {
		t.Fatalf("download: %+v %v", verified, err)
	}
	bad := frozen
	bad.ContentDigest = "sha256:" + strings.Repeat("0", 64)
	if _, _, err := client.Download(context.Background(), org, bad); !errors.Is(err, ErrArtifactMismatch) {
		t.Fatalf("wrong digest = %v", err)
	}
}

func TestDownloadRejectsRedirectAndClassifiesMissingAndTemporary(t *testing.T) {
	frozen := skillset.FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, ArtifactSize: 100}
	status := http.StatusFound
	redirectCalls := 0
	redirectTarget := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		redirectCalls++
		w.WriteHeader(http.StatusOK)
	}))
	defer redirectTarget.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Location", redirectTarget.URL+"/steal")
		w.WriteHeader(status)
	}))
	defer server.Close()
	client, err := newAuthenticatedRegistry(t, server.URL)
	if err != nil {
		t.Fatal(err)
	}
	org := "org_00000000000000000000000000000000"
	if _, _, err := client.Download(context.Background(), org, frozen); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("redirect = %v", err)
	}
	if redirectCalls != 0 {
		t.Fatal("Registry bearer token was sent to a redirect target")
	}
	status = http.StatusNotFound
	if _, _, err := client.Download(context.Background(), org, frozen); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing = %v", err)
	}
	status = http.StatusServiceUnavailable
	if _, _, err := client.Download(context.Background(), org, frozen); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("temporary = %v", err)
	}
}
