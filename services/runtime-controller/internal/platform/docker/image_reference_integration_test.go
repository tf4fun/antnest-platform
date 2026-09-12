package docker

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"slices"
	"testing"
	"time"
)

func TestMovedTagCreatesNewImageWithoutChangingReference(t *testing.T) {
	socket := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET enables Docker integration")
	}
	images := []string{os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG"), os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_MOVED_IMAGE_TAG")}
	if images[0] == "" || images[1] == "" {
		t.Fatal("TEST_IMAGE_TAG and TEST_MOVED_IMAGE_TAG must name two different installed images")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	name := fmt.Sprintf("antnest-image-reference-test-%d", time.Now().UnixNano())
	reference := name + ":latest"
	var previous string
	for index, image := range images {
		identity, err := client.InspectImage(ctx, image)
		if err != nil {
			t.Fatal(err)
		}
		if identity == previous {
			t.Fatal("test requires two distinct installed image IDs")
		}
		previous = identity
		query := url.Values{"repo": {name}, "tag": {"latest"}}
		if err := client.do(ctx, http.MethodPost, "/images/"+url.PathEscape(identity)+"/tag?"+query.Encode(), nil, nil); err != nil {
			t.Fatal(err)
		}
		if index == 0 {
			t.Cleanup(func() {
				cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
				defer stop()
				if err := client.do(cleanup, http.MethodDelete, "/images/"+url.PathEscape(reference)+"?force=1", nil, nil); err != nil {
					t.Error(err)
				}
			})
		}
		resolved, err := client.InspectImage(ctx, reference)
		if err != nil || resolved != identity {
			t.Fatalf("resolve current tag: %s %v", resolved, err)
		}
		// Moving the tag after resolution must not change this build's image.
		if err := client.do(ctx, http.MethodPost, "/images/"+url.PathEscape(images[1-index])+"/tag?"+query.Encode(), nil, nil); err != nil {
			t.Fatal(err)
		}
		containerID, err := client.CreateContainer(ctx, ContainerSpec{
			Name: fmt.Sprintf("%s-%d", name, index), Image: resolved,
			Environment: map[string]string{"ANTNEST_RUNTIME_IMAGE_REFERENCE": reference, "ANTNEST_RUNTIME_IMAGE_ID": resolved},
		})
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			cleanup, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			if err := client.RemoveContainer(cleanup, containerID); err != nil {
				t.Error(err)
			}
		})
		var inspected struct {
			Image  string `json:"Image"`
			Config struct {
				Image string   `json:"Image"`
				Env   []string `json:"Env"`
			} `json:"Config"`
		}
		if err := client.do(ctx, http.MethodGet, "/containers/"+url.PathEscape(containerID)+"/json", nil, &inspected); err != nil {
			t.Fatal(err)
		}
		if inspected.Image != identity || inspected.Config.Image != resolved ||
			!slices.Contains(inspected.Config.Env, "ANTNEST_RUNTIME_IMAGE_REFERENCE="+reference) ||
			!slices.Contains(inspected.Config.Env, "ANTNEST_RUNTIME_IMAGE_ID="+resolved) {
			t.Fatalf("container image and build metadata disagree: %+v", inspected)
		}
	}
}
