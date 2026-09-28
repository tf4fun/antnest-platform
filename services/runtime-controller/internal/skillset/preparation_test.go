package skillset

import (
	"testing"
)

func TestPreparationRequestValidatesFrozenCollectionAndIdentity(t *testing.T) {
	organization := "org_00000000000000000000000000000000"
	digest, err := Digest(organization, LayoutVersion, nil)
	if err != nil {
		t.Fatal(err)
	}
	input := PrepareRequest{
		Scope: "test", RequestID: "prepare-1", AgentID: "agent-1", OrganizationID: organization,
		OwnerOperationID: "build-1", LayoutVersion: LayoutVersion, SkillSetDigest: digest,
		SystemSkills: []FrozenSkill{},
	}
	fingerprint, err := input.ValidateAndDigest()
	if err != nil || fingerprint == "" {
		t.Fatalf("valid preparation = %q, %v", fingerprint, err)
	}
	changed := input
	changed.OwnerOperationID = "build-2"
	other, err := changed.ValidateAndDigest()
	if err != nil || other == fingerprint {
		t.Fatalf("owner operation did not bind request: %q %q %v", fingerprint, other, err)
	}
	for _, bad := range []PrepareRequest{
		func() PrepareRequest { v := input; v.RequestID = "bad\nrequest"; return v }(),
		func() PrepareRequest { v := input; v.RequestID = "bad/request"; return v }(),
		func() PrepareRequest { v := input; v.AgentID = ""; return v }(),
		func() PrepareRequest { v := input; v.OwnerOperationID = ""; return v }(),
		func() PrepareRequest { v := input; v.SkillSetDigest = "sha256:deadbeef"; return v }(),
		func() PrepareRequest { v := input; v.LayoutVersion = 2; return v }(),
	} {
		if _, err := bad.ValidateAndDigest(); err == nil {
			t.Fatalf("invalid preparation accepted: %+v", bad)
		}
	}
}
