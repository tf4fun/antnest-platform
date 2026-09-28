package skillset

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestDigestMatchesSharedControllerFixture(t *testing.T) {
	fixturePath := filepath.Join("..", "..", "..", "..", "tests", "integration", "skill-registry", "skill-set-digest-v1.json")
	data, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		LayoutVersion uint32 `json:"layout_version"`
		Cases         []struct {
			OrganizationID string        `json:"organization_id"`
			Skills         []FrozenSkill `json:"skills"`
			Digest         string        `json:"skill_set_digest"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.LayoutVersion != LayoutVersion || len(fixture.Cases) == 0 {
		t.Fatal("shared fixture has an unexpected layout version or no cases")
	}
	for _, item := range fixture.Cases {
		got, err := Digest(item.OrganizationID, fixture.LayoutVersion, item.Skills)
		if err != nil || got != item.Digest {
			t.Fatalf("digest = %q, %v; want %q", got, err, item.Digest)
		}
	}
}

func TestDigestRejectsTamperedFrozenMetadata(t *testing.T) {
	good := FrozenSkill{
		SkillID: "skill_11111111111111111111111111111111", Version: 1,
		Name: "code-review", Description: "Review code",
		ArtifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ContentDigest:  "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		ArtifactSize:   100, UnpackedSize: 200, PackageRulesVersion: 1,
	}
	organization := "org_00000000000000000000000000000000"
	valid, err := Digest(organization, LayoutVersion, []FrozenSkill{good})
	if err != nil {
		t.Fatal(err)
	}
	changed := good
	changed.Description = "Different instructions"
	other, err := Digest(organization, LayoutVersion, []FrozenSkill{changed})
	if err != nil || valid == other {
		t.Fatalf("description change did not change digest: %q %q %v", valid, other, err)
	}
	if other, err = Digest("org_22222222222222222222222222222222", LayoutVersion, []FrozenSkill{good}); err != nil || valid == other {
		t.Fatalf("organization change did not change digest: %q %q %v", valid, other, err)
	}
	for _, skills := range [][]FrozenSkill{{good, good}, {func() FrozenSkill { v := good; v.Name = "../escape"; return v }()}, {func() FrozenSkill { v := good; v.ArtifactSize = 0; return v }()}} {
		if _, err := Digest(organization, LayoutVersion, skills); err == nil {
			t.Fatalf("invalid frozen metadata accepted: %+v", skills)
		}
	}
	if _, err := Digest(organization, 2, []FrozenSkill{good}); err == nil {
		t.Fatal("unsupported layout accepted")
	}
	// These names are valid when the Registry accepted a quoted YAML scalar.
	// Frozen metadata no longer records whether the source scalar was quoted.
	for _, name := range []string{"0x-1", "2024-01-01"} {
		quoted := good
		quoted.Name = name
		if _, err := Digest(organization, LayoutVersion, []FrozenSkill{quoted}); err != nil {
			t.Fatalf("valid frozen name %q rejected: %v", name, err)
		}
	}
}

func TestDigestNormalizesReferenceOrder(t *testing.T) {
	one := FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, Name: "alpha", Description: "First", ArtifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ContentDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", ArtifactSize: 100, UnpackedSize: 200, PackageRulesVersion: 1}
	two := one
	two.SkillID = "skill_22222222222222222222222222222222"
	two.Name = "beta"
	forward, err := Digest("org_00000000000000000000000000000000", 1, []FrozenSkill{one, two})
	if err != nil {
		t.Fatal(err)
	}
	reverse, err := Digest("org_00000000000000000000000000000000", 1, []FrozenSkill{two, one})
	if err != nil || forward != reverse {
		t.Fatalf("ordering changed digest: %q %q %v", forward, reverse, err)
	}
}
