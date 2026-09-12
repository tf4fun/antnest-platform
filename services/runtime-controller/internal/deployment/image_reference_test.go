package deployment

import (
	"strings"
	"testing"
)

func TestImageReferencePreservedAcrossGenerations(t *testing.T) {
	for _, image := range []string{"antnest/runtime:latest", "registry.example:5000/runtime:v2", "runtime", "sha256:" + strings.Repeat("a", 64)} {
		t.Run(image, func(t *testing.T) {
			value := testDeployment()
			input := Configuration{ImageRef: image, Network: value.RuntimeSpec.Network, Resources: value.Resources}
			for _, generation := range []uint64{1, 2} {
				physical, err := input.Resolve("agent-1", generation)
				if err != nil || physical.ImageRef != image || input.ImageRef != image {
					t.Fatalf("reference changed: %+v, error = %v", physical, err)
				}
			}
		})
	}
}

func TestImageReferenceRejectsMalformedInput(t *testing.T) {
	for _, image := range []string{"", " runtime:latest", "runtime:bad tag", "runtime@sha256:bad", strings.Repeat("a", 513)} {
		t.Run(image, func(t *testing.T) {
			value := testDeployment()
			value.ImageRef = image
			if err := value.ValidateFor(Key{AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation}); err == nil {
				t.Fatal("malformed image reference accepted")
			}
		})
	}
}
