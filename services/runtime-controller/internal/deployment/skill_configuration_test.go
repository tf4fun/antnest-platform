package deployment

import (
	"strings"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

func TestRuntimeConfigurationRequiresExactPreparedSkillIdentity(t *testing.T) {
	configuration := testConfiguration()
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	configuration.OrganizationID = org
	configuration.SystemSkills = []skillset.FrozenSkill{}
	configuration.PreparedSkillSet = &skillset.PreparedSet{SkillSetDigest: digest, LayoutVersion: skillset.LayoutVersion}
	configuration.PreparedReferenceID = "psr_" + strings.Repeat("a", 32)
	if err := configuration.Validate(); err != nil {
		t.Fatalf("valid empty collection: %v", err)
	}
	resolved, err := configuration.Resolve("agent-1", 1)
	if err != nil || resolved.PreparedSkills == nil || resolved.PreparedSkills.SkillSetDigest != digest || resolved.PreparedSkills.ReferenceID != configuration.PreparedReferenceID {
		t.Fatalf("resolved Skill identity: %+v %v", resolved.PreparedSkills, err)
	}
	missing := configuration
	missing.PreparedReferenceID = ""
	if err := missing.Validate(); err == nil {
		t.Fatal("accepted missing prepared reference")
	}
	mismatched := configuration
	mismatched.PreparedSkillSet = &skillset.PreparedSet{SkillSetDigest: "sha256:" + strings.Repeat("b", 64), LayoutVersion: 1}
	if err := mismatched.Validate(); err == nil {
		t.Fatal("accepted wrong set digest")
	}
}
