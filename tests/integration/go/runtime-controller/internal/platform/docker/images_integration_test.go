package docker

import (
	"context"
	"errors"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"os"
	"testing"
	"time"
)

func TestInstalledImageResolution(t *testing.T) {
	socket := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET enables read-only Docker integration")
	}
	image := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG")
	if image == "" {
		t.Fatal("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG must name an installed repository:tag")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	driver, err := NewDriver(client, Config{ControllerScope: "image-query-test", ManagementNetwork: "unused", SystemSkillsVolume: "unused"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	result, err := driver.ResolveImage(ctx, image)
	if err != nil {
		t.Fatal(err)
	}
	if result.Reference == "" || result.ImageRef == "" {
		t.Fatalf("incomplete image resolution: %+v", result)
	}
	pinned, err := client.InspectImage(ctx, result.ImageRef)
	if err != nil || pinned != result.ImageRef {
		t.Fatalf("resolved image cannot be addressed by its immutable ID: %q, %v", pinned, err)
	}
	byID, err := driver.ResolveImage(ctx, result.ImageRef)
	if !errors.Is(err, platform.ErrImageNotAllowed) || byID.ImageRef != "" {
		t.Fatalf("immutable image lookup changed identity: %+v %v", byID, err)
	}
}
