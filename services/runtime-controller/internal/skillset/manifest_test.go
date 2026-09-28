package skillset

import (
	"bytes"
	"strings"
	"testing"
)

func TestCollectionManifestRequiresEveryVerifiedPackage(t *testing.T) {
	files := []PackageFile{{Path: "SKILL.md", Size: 200, Digest: "sha256:" + strings.Repeat("d", 64)}}
	frozen := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, Name: "code-review", Description: "Review code",
		ArtifactDigest: "sha256:" + strings.Repeat("a", 64), ContentDigest: packageManifestDigest(files), ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}
	setDigest, err := Digest("org_00000000000000000000000000000000", 1, []FrozenSkill{frozen})
	if err != nil {
		t.Fatal(err)
	}
	key := SetKey{Scope: "test", OrganizationID: "org_00000000000000000000000000000000", AgentID: "agent-1",
		SkillSetDigest: setDigest, LayoutVersion: 1, Materialization: 1}
	job := PreparationJob{Key: key, Skills: []FrozenSkill{frozen}}
	if _, _, err := CollectionManifest(job); err == nil {
		t.Fatal("missing package checkpoint accepted")
	}
	job.Checkpoints = []PackageCheckpoint{{SkillID: frozen.SkillID, Version: 1, ContentDigest: frozen.ContentDigest, VerifiedBytes: 200, Files: files}}
	first, digest, err := CollectionManifest(job)
	if err != nil || !bytes.Contains(first, []byte(`"layout_version":1`)) || !bytes.Contains(first, []byte(`"skill_md_digest":"sha256:`)) || len(digest) != 71 {
		t.Fatalf("manifest: %s %s %v", first, digest, err)
	}
	second, other, err := CollectionManifest(job)
	if err != nil || !bytes.Equal(first, second) || digest != other {
		t.Fatalf("manifest not deterministic: %s %s %v", digest, other, err)
	}
}
