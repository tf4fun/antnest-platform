package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"reflect"
	"slices"
	"sync"
	"testing"
	"time"
)

type containerCleanupInventory struct {
	Containers []string
	Volumes    []string
}

func readContainerCleanupInventory(ctx context.Context, client *Client) (containerCleanupInventory, error) {
	var containers []struct {
		ID string `json:"Id"`
	}
	if err := client.do(ctx, http.MethodGet, "/containers/json?all=1", nil, &containers); err != nil {
		return containerCleanupInventory{}, err
	}
	var volumes struct {
		Volumes []struct {
			Name string `json:"Name"`
		} `json:"Volumes"`
	}
	if err := client.do(ctx, http.MethodGet, "/volumes", nil, &volumes); err != nil {
		return containerCleanupInventory{}, err
	}
	inventory := containerCleanupInventory{Containers: []string{}, Volumes: []string{}}
	for _, container := range containers {
		if container.ID == "" || slices.Contains(inventory.Containers, container.ID) {
			return containerCleanupInventory{}, errors.New("Docker container inventory has an empty or duplicate ID")
		}
		inventory.Containers = append(inventory.Containers, container.ID)
	}
	for _, volume := range volumes.Volumes {
		if volume.Name == "" || slices.Contains(inventory.Volumes, volume.Name) {
			return containerCleanupInventory{}, errors.New("Docker volume inventory has an empty or duplicate name")
		}
		inventory.Volumes = append(inventory.Volumes, volume.Name)
	}
	slices.Sort(inventory.Containers)
	slices.Sort(inventory.Volumes)
	return inventory, nil
}

func TestRemoveContainerDeletesAnonymousVolumesAndPreservesNamedResources(t *testing.T) {
	// This fixture needs an image-declared anonymous volume, so it has an
	// independent opt-in from the generic installed-image integration checks.
	image := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_ANONYMOUS_VOLUME_IMAGE")
	if image == "" {
		t.Skip("ANTNEST_RUNTIME_CONTROLLER_TEST_ANONYMOUS_VOLUME_IMAGE enables isolated Docker container cleanup integration")
	}
	socket := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Fatal("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET is required when anonymous volume integration is enabled")
	}
	if image != "postgres:17.11-bookworm" {
		t.Fatal("ANTNEST_RUNTIME_CONTROLLER_TEST_ANONYMOUS_VOLUME_IMAGE must explicitly name cached postgres:17.11-bookworm; this test never pulls images")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.httpClient.CloseIdleConnections)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	resolvedImage, err := client.InspectImage(ctx, image)
	if err != nil {
		t.Fatal("cached Postgres image is unavailable", err)
	}
	baseline, err := readContainerCleanupInventory(ctx, client)
	if err != nil {
		t.Fatal(err)
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	nonce[6] = (nonce[6] & 0x0f) | 0x40
	nonce[8] = (nonce[8] & 0x3f) | 0x80
	owner := "rc-container-cleanup-" + hex.EncodeToString(nonce[:])
	const ownerLabel = "io.antnest.test"
	labels := map[string]string{ownerLabel: owner, labelScope: owner}
	containerNames := []string{owner + "-retained", owner + "-removed"}
	namedVolumes := []string{owner + "-retained-volume", owner + "-fixture-volume"}
	containerIDs := map[string]bool{}
	anonymousVolumes := map[string]bool{}

	// Anonymous volumes have no test label. Their ownership comes only from a
	// real Mounts record on an exactly owned container, never a global delta.
	recordMounts := func(container Container) ([]string, error) {
		var anonymous []string
		var failures []error
		for _, mount := range container.Mounts {
			if mount.Type != "volume" || mount.Name == "" {
				failures = append(failures, errors.New("fixture container has an unexpected mount"))
				continue
			}
			if slices.Contains(namedVolumes, mount.Name) {
				continue
			}
			if slices.Contains(baseline.Volumes, mount.Name) {
				failures = append(failures, errors.New("fixture unexpectedly references a baseline volume"))
				continue
			}
			anonymousVolumes[mount.Name] = true
			anonymous = append(anonymous, mount.Name)
			if mount.Destination != "/var/lib/postgresql/data" {
				failures = append(failures, errors.New("Postgres anonymous volume has an unexpected destination"))
			}
		}
		if len(anonymous) != 1 {
			failures = append(failures, fmt.Errorf("expected one real Postgres anonymous mount, got %d", len(anonymous)))
		}
		return anonymous, errors.Join(failures...)
	}
	checkInventory := func(checkCtx context.Context, containers, volumes []string) error {
		actual, err := readContainerCleanupInventory(checkCtx, client)
		if err != nil {
			return err
		}
		wanted := containerCleanupInventory{
			Containers: append(slices.Clone(baseline.Containers), containers...),
			Volumes:    append(slices.Clone(baseline.Volumes), volumes...),
		}
		slices.Sort(wanted.Containers)
		slices.Sort(wanted.Volumes)
		if !reflect.DeepEqual(actual, wanted) {
			return fmt.Errorf("Docker inventory differs: containers=%d expected=%d, volumes=%d expected=%d", len(actual.Containers), len(wanted.Containers), len(actual.Volumes), len(wanted.Volumes))
		}
		return nil
	}
	var cleanupOnce sync.Once
	var cleanupError error
	cleanup := func() error {
		cleanupOnce.Do(func() {
			cleanupCtx, stop := context.WithTimeout(context.Background(), time.Minute)
			defer stop()
			var failures []error
			// Include planned names so an ambiguous create response is still
			// recovered, but inspect UUID ownership before any destructive call.
			identifiers := slices.Clone(containerNames)
			for id := range containerIDs {
				identifiers = append(identifiers, id)
			}
			seen := map[string]bool{}
			for _, identifier := range identifiers {
				container, inspectErr := client.InspectContainer(cleanupCtx, identifier)
				if errors.Is(inspectErr, ErrNotFound) {
					continue
				}
				if inspectErr != nil {
					failures = append(failures, fmt.Errorf("inspect cleanup container: %w", inspectErr))
					continue
				}
				if seen[container.ID] {
					continue
				}
				seen[container.ID] = true
				if container.ID == "" || slices.Contains(baseline.Containers, container.ID) || !slices.Contains(containerNames, container.Name) || container.Labels[ownerLabel] != owner || container.Labels[labelScope] != owner {
					failures = append(failures, errors.New("cleanup container ownership differs; preserved"))
					continue
				}
				if _, mountErr := recordMounts(container); mountErr != nil {
					failures = append(failures, mountErr)
				}
				// Do not use RemoveContainer here: this independent Engine call
				// must clean up even while the production behavior is red.
				removeErr := client.do(cleanupCtx, http.MethodDelete, "/containers/"+url.PathEscape(container.ID)+"?force=1&v=1", nil, nil)
				if removeErr != nil && !errors.Is(removeErr, ErrNotFound) {
					failures = append(failures, fmt.Errorf("force-remove fixture container: %w", removeErr))
				}
			}
			volumes := slices.Clone(namedVolumes)
			for name := range anonymousVolumes {
				volumes = append(volumes, name)
			}
			slices.Sort(volumes)
			for _, name := range volumes {
				volume, inspectErr := client.InspectVolume(cleanupCtx, name)
				if errors.Is(inspectErr, ErrNotFound) {
					continue
				}
				if inspectErr != nil {
					failures = append(failures, fmt.Errorf("inspect cleanup volume: %w", inspectErr))
					continue
				}
				if volume.Name != name || slices.Contains(baseline.Volumes, name) || (slices.Contains(namedVolumes, name) && (volume.Labels[ownerLabel] != owner || volume.Labels[labelScope] != owner)) {
					failures = append(failures, errors.New("cleanup volume ownership differs; preserved"))
					continue
				}
				if removeErr := client.do(cleanupCtx, http.MethodDelete, "/volumes/"+url.PathEscape(name), nil, nil); removeErr != nil && !errors.Is(removeErr, ErrNotFound) {
					failures = append(failures, fmt.Errorf("remove recorded fixture volume: %w", removeErr))
				}
			}
			if inventoryErr := checkInventory(cleanupCtx, nil, nil); inventoryErr != nil {
				failures = append(failures, fmt.Errorf("final precise cleanup inventory: %w", inventoryErr))
			}
			cleanupError = errors.Join(failures...)
		})
		return cleanupError
	}
	t.Cleanup(func() {
		if err := cleanup(); err != nil {
			t.Error(err)
		}
	})

	behaviorError := func() error {
		for _, name := range namedVolumes {
			if err := client.CreateVolume(ctx, name, labels); err != nil {
				return err
			}
		}
		var containers []Container
		var anonymous []string
		for index, name := range containerNames {
			id, err := client.CreateContainer(ctx, ContainerSpec{
				Name: name, Image: resolvedImage, User: "0:0", NetworkMode: "none", Labels: labels,
				Mounts: map[string]Mount{"/fixture": {Source: namedVolumes[index], NoCopy: true}},
			})
			if id != "" {
				containerIDs[id] = true
			}
			if err != nil {
				return err
			}
			container, err := client.InspectContainer(ctx, id)
			if err != nil {
				return err
			}
			if container.ID != id || container.Name != name || container.Running || container.Status != "created" || container.Labels[ownerLabel] != owner || container.Labels[labelScope] != owner {
				return errors.New("created fixture container identity or stopped state differs")
			}
			mounted, mountErr := recordMounts(container)
			if mountErr != nil {
				return mountErr
			}
			if len(container.Mounts) != 2 || !slices.ContainsFunc(container.Mounts, func(mount ObservedMount) bool {
				return mount.Type == "volume" && mount.Name == namedVolumes[index] && mount.Destination == "/fixture" && mount.NoCopy
			}) {
				return errors.New("explicit named fixture mount differs")
			}
			containers = append(containers, container)
			anonymous = append(anonymous, mounted[0])
		}
		if anonymous[0] == anonymous[1] {
			return errors.New("independent fixtures unexpectedly share an anonymous volume")
		}
		if err := checkInventory(ctx, []string{containers[0].ID, containers[1].ID}, append(slices.Clone(namedVolumes), anonymous...)); err != nil {
			return fmt.Errorf("created fixture inventory: %w", err)
		}
		if err := client.RemoveContainer(ctx, containers[1].ID); err != nil {
			return err
		}
		var failures []error
		if _, err := client.InspectContainer(ctx, containers[1].ID); !errors.Is(err, ErrNotFound) {
			failures = append(failures, fmt.Errorf("removed container must return ErrNotFound, got %v", err))
		}
		if _, err := client.InspectVolume(ctx, anonymous[1]); !errors.Is(err, ErrNotFound) {
			failures = append(failures, fmt.Errorf("removed container's actual anonymous volume must return ErrNotFound, got %v", err))
		}
		for _, name := range namedVolumes {
			volume, err := client.InspectVolume(ctx, name)
			if err != nil || volume.Name != name || !reflect.DeepEqual(volume.Labels, labels) {
				failures = append(failures, fmt.Errorf("explicit named volume was removed or changed: %v", err))
			}
		}
		retained, err := client.InspectContainer(ctx, containers[0].ID)
		if err != nil || !reflect.DeepEqual(retained, containers[0]) {
			failures = append(failures, fmt.Errorf("independent retained container changed: %v", err))
		}
		if _, err := client.InspectVolume(ctx, anonymous[0]); err != nil {
			failures = append(failures, fmt.Errorf("independent retained anonymous volume was removed: %w", err))
		}
		if err := checkInventory(ctx, []string{containers[0].ID}, append(slices.Clone(namedVolumes), anonymous[0])); err != nil {
			failures = append(failures, fmt.Errorf("post-removal fixture inventory: %w", err))
		}
		return errors.Join(failures...)
	}()
	// Complete actual cleanup before reporting either the expected red result
	// or success; the registered fallback also covers panic/early test exit.
	cleanupErr := cleanup()
	if cleanupErr == nil {
		t.Log("precise fixture cleanup completed; Docker container and volume inventories match the original baseline")
	}
	if err := errors.Join(behaviorError, cleanupErr); err != nil {
		t.Fatal(err)
	}
}
