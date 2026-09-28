package skillset

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func artifactZIP(t *testing.T, entries map[string]string) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for name, content := range entries {
		member, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(member, content); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestArtifactVerifierUsesSharedPackageRules(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "tests", "integration", "skill-registry", "package-rules-v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		PackageRulesVersion int `json:"package_rules_version"`
		Cases               []struct {
			ID, Manifest, Name string
			Accept             bool
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil || fixture.PackageRulesVersion != 1 {
		t.Fatalf("fixture: %v", err)
	}
	for _, item := range fixture.Cases {
		t.Run(item.ID, func(t *testing.T) {
			pkg, err := InspectArtifact(context.Background(), artifactZIP(t, map[string]string{"SKILL.md": item.Manifest}))
			if item.Accept && (err != nil || pkg.Name != item.Name) {
				t.Fatalf("valid package rejected: %+v %v", pkg, err)
			}
			if !item.Accept && err == nil {
				t.Fatalf("invalid package accepted: %+v", pkg)
			}
		})
	}
}

func TestVerifiedArtifactBecomesReadOnlyRealFilesInTar(t *testing.T) {
	archive := artifactZIP(t, map[string]string{
		"SKILL.md":            "---\nname: code-review\ndescription: Helpful review\n---\n",
		"references/check.md": "check the code\n",
	})
	pkg, err := InspectArtifact(context.Background(), archive)
	if err != nil {
		t.Fatal(err)
	}
	frozen := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1,
		Name: pkg.Name, Description: pkg.Description, ArtifactDigest: pkg.ArtifactDigest,
		ContentDigest: pkg.ContentDigest, ArtifactSize: int64(len(archive)),
		UnpackedSize: int64(pkg.UnpackedSize), PackageRulesVersion: 1}
	if _, err := ValidateFrozenArtifact(context.Background(), archive, frozen); err != nil {
		t.Fatal(err)
	}
	mutated := frozen
	mutated.ContentDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	if _, err := ValidateFrozenArtifact(context.Background(), archive, mutated); err == nil {
		t.Fatal("accepted wrong frozen content digest")
	}
	var normalized bytes.Buffer
	if err := WriteNormalizedTar(context.Background(), archive, pkg, &normalized); err != nil {
		t.Fatal(err)
	}
	reader := tar.NewReader(&normalized)
	seen := map[string]bool{}
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		seen[header.Name] = true
		if header.Uid != 0 || header.Gid != 0 || header.Typeflag != tar.TypeDir && header.Typeflag != tar.TypeReg {
			t.Fatalf("unsafe tar header: %+v", header)
		}
		if header.Typeflag == tar.TypeDir && header.Mode != 0555 || header.Typeflag == tar.TypeReg && header.Mode != 0444 {
			t.Fatalf("wrong normalized mode: %+v", header)
		}
	}
	for _, expected := range []string{"code-review/", "code-review/SKILL.md", "code-review/references/", "code-review/references/check.md"} {
		if !seen[expected] {
			t.Fatalf("missing real volume member %s: %+v", expected, seen)
		}
	}
}

func TestArtifactVerifierRejectsUnsafeZIP(t *testing.T) {
	for _, name := range []string{"../escape", "/absolute", "references/../../escape", "a\\b"} {
		t.Run(name, func(t *testing.T) {
			archive := artifactZIP(t, map[string]string{"SKILL.md": "---\nname: safe\ndescription: Safe\n---\n", name: "bad"})
			if _, err := InspectArtifact(context.Background(), archive); err == nil {
				t.Fatal("unsafe ZIP accepted")
			}
		})
	}
}

func TestArtifactVerifierRejectsDuplicateZIPMembers(t *testing.T) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for range 2 {
		member, err := writer.Create("SKILL.md")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := io.WriteString(member, "---\nname: safe\ndescription: Safe\n---\n"); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := InspectArtifact(context.Background(), output.Bytes()); err == nil {
		t.Fatal("duplicate member accepted")
	}
}
