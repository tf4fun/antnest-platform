package docker

import (
	"strings"
	"testing"
)

func TestRuntimeImagePolicyMatchesRepositoryAndPinnedDigestExactly(t *testing.T) {
	digest := "sha256:" + strings.Repeat("a", 64)
	policy, err := ParseImagePolicy([]string{"registry.example:5000/team/runtime", "antnest/pinned@" + digest})
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct {
		reference string
		allowed   bool
	}{
		{"registry.example:5000/team/runtime:v1", true},
		{"registry.example:5000/team/runtime@" + digest, true},
		{"antnest/pinned@" + digest, true},
		{"docker.io/antnest/pinned@" + digest, true},
		{"antnest/pinned:latest", false},
		{"antnest/pinned@sha256:" + strings.Repeat("b", 64), false},
		{"evil.registry.example:5000/team/runtime:v1", false},
		{"registry.example:5000/team/runtime-spoof:v1", false},
		{"registry.example:5001/team/runtime:v1", false},
		{"registry.example:5000/team/runtime.evil:v1", false},
		{"registry.example:5000/team/runtime:v1@" + digest, false},
		{"https://registry.example:5000/team/runtime:v1", false},
		{" registry.example:5000/team/runtime:v1", false},
		{digest, false},
	} {
		t.Run(item.reference, func(t *testing.T) {
			if policy.Allows(item.reference) != item.allowed {
				t.Fatal("image authorization differs from exact operator policy")
			}
		})
	}
}

func TestRuntimeImagePolicyRejectsMalformedAndAmbiguousConfiguration(t *testing.T) {
	for _, entries := range [][]string{{""}, {" alpine"}, {"alpine:latest"}, {"antnest/*"}, {"https://registry.example/runtime"}, {"antnest/runtime@sha256:short"}, {"antnest/runtime", "docker.io/antnest/runtime"}, {"antnest/runtime@sha256:" + strings.Repeat("a", 64), "docker.io/antnest/runtime@sha256:" + strings.Repeat("a", 64)}} {
		if _, err := ParseImagePolicy(entries); err == nil {
			t.Fatalf("ambiguous image policy accepted: %v", entries)
		}
	}
	policy, err := ParseImagePolicy(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, image := range []string{"antnest/antnest-runtime:local", "docker.io/antnest/antnest-runtime:release", "antnest/antnest-runtime@sha256:" + strings.Repeat("a", 64)} {
		if !policy.Allows(image) {
			t.Fatal("default Runtime repository was denied")
		}
	}
}

func TestRuntimeImagePolicyNeverTreatsAnImageIDAsARepositoryTag(t *testing.T) {
	policy, err := ParseImagePolicy([]string{"sha256"})
	if err != nil {
		t.Fatal(err)
	}
	if policy.Allows("sha256:" + strings.Repeat("a", 64)) {
		t.Fatal("unnamed immutable image ID bypassed repository authorization")
	}
}
