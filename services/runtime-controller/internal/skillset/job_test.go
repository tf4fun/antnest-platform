package skillset

import "testing"

func TestVolumeNameBindsLogicalSetButNotComputeGeneration(t *testing.T) {
	key := SetKey{Scope: "test", OrganizationID: "org_00000000000000000000000000000000", AgentID: "agent-1",
		SkillSetDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", LayoutVersion: 1, Materialization: 1}
	first, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	if first == "" || len(first) > 63 {
		t.Fatalf("invalid Docker volume name %q", first)
	}
	second := key
	second.AgentID = "agent-2"
	other, err := second.VolumeName()
	if err != nil || other == first {
		t.Fatalf("Agent identity not bound: %q %q %v", first, other, err)
	}
	second = key
	second.Materialization++
	other, err = second.VolumeName()
	if err != nil || other == first {
		t.Fatalf("replacement materialization did not change name: %q %q %v", first, other, err)
	}
}
