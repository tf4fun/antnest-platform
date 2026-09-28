package skillset

import (
	"strings"
	"testing"
)

func TestPackageFromCheckpointRejectsCorruptInventory(t *testing.T) {
	files := []PackageFile{{Path: "SKILL.md", Size: 10, Digest: "sha256:" + strings.Repeat("a", 64)}}
	skill := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, Name: "review", Description: "Review", ArtifactDigest: "sha256:" + strings.Repeat("b", 64), ContentDigest: packageManifestDigest(files), UnpackedSize: 10}
	checkpoint := PackageCheckpoint{SkillID: skill.SkillID, Version: 1, ContentDigest: skill.ContentDigest, VerifiedBytes: 10, Files: files}
	if _, err := PackageFromCheckpoint(skill, checkpoint); err != nil {
		t.Fatal(err)
	}
	checkpoint.Files[0].Digest = "sha256:" + strings.Repeat("c", 64)
	if _, err := PackageFromCheckpoint(skill, checkpoint); err == nil {
		t.Fatal("accepted corrupt checkpoint file digest")
	}
}
