package docker

import (
	"context"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
)

func TestCreateUsesPinnedImageAndInjectsBuildMetadata(t *testing.T) {
	for _, generation := range []uint64{7, 8} {
		engine := newFakeEngine()
		driver := newTestDriver(t, engine)
		value := testDeployment()
		value.RuntimeSpec.Generation = generation
		value.ImageReference = "antnest/runtime:latest"
		value.ImageRef = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		digest, err := driver.DeploymentDigest(value)
		if err != nil {
			t.Fatal(err)
		}
		outcome := driver.Create(context.Background(), value, digest)
		if outcome.State != deployment.EffectCompleted || engine.created.Image != value.ImageRef {
			t.Fatalf("Docker did not receive the pinned image: outcome=%+v image=%q", outcome, engine.created.Image)
		}
		if engine.created.Environment["ANTNEST_RUNTIME_IMAGE_REFERENCE"] != value.ImageReference ||
			engine.created.Environment["ANTNEST_RUNTIME_IMAGE_ID"] != value.ImageRef {
			t.Fatal("container is missing build image metadata")
		}
		replayed := driver.Create(context.Background(), value, digest)
		if replayed.State != deployment.EffectCompleted || engine.createCalls != 1 {
			t.Fatalf("replay unexpectedly rebuilt the container: %+v, creates=%d", replayed, engine.createCalls)
		}
	}
}
