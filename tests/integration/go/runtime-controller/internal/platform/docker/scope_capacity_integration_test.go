package docker

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"os"
	"slices"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

func scopeIntegrationDeployment(agent string, generation uint64, image string) deployment.Deployment {
	return deployment.Deployment{
		ImageRef: image,
		RuntimeSpec: deployment.RuntimeSpec{
			AgentID: agent, Generation: generation,
			Listen: deployment.SocketAddress{Host: "0.0.0.0", Port: 8093},
			Network: deployment.NetworkSpec{
				PacketContractRevision: 2,
				EgressEndpoint:         deployment.IPv4Endpoint{IPv4: "10.20.0.8", Port: 8092},
				TunnelIPv4:             "100.64.0.2", ResolverIPv4: "100.64.0.1",
			},
			Filesystem: deployment.FilesystemSpec{Workspace: "/workspace", SystemSkills: "/skills"},
		},
		Resources: deployment.ResourceLimits{MemoryBytes: 256 << 20, PidsLimit: 128, TmpfsBytes: 64 << 20},
	}
}

func TestScopedRuntimeResourcesStayIsolatedOnOneDaemon(t *testing.T) {
	socket := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET enables isolated Docker scope/capacity integration")
	}
	image := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG")
	if image == "" {
		t.Fatal("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG must name an installed repository:tag")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.httpClient.CloseIdleConnections)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	var nonce [8]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(nonce[:])
	network := "antnest-scope-test-" + suffix
	scopes := []string{"scope-a-" + suffix, "scope-b-" + suffix}
	agent := "agent-" + suffix
	skillsVolume := "antnest-system-skills-" + suffix
	owner := "scope-test-" + suffix
	removeErr := func(err error) {
		if err != nil && !errors.Is(err, ErrNotFound) {
			t.Errorf("cleanup of test-owned resource failed: %v", err)
		}
	}
	t.Cleanup(func() {
		cleanup, cleanupCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cleanupCancel()
		for _, scope := range scopes {
			name := runtimeContainerName(scope, agent)
			container, err := client.InspectContainer(cleanup, name)
			switch {
			case errors.Is(err, ErrNotFound):
			case err != nil:
				t.Errorf("inspect test container during cleanup: %v", err)
			case container.Labels[labelManaged] != "runtime" || container.Labels[labelScope] != scope || container.Labels[labelAgentID] != agent:
				t.Errorf("refusing cleanup of container with unexpected ownership: %s", name)
			default:
				removeErr(client.RemoveContainer(cleanup, container.ID))
			}
			for _, name := range []string{workspaceVolumeName(scope, agent), resolverVolumeName(scope, agent, 1)} {
				volume, err := client.InspectVolume(cleanup, name)
				switch {
				case errors.Is(err, ErrNotFound):
				case err != nil:
					t.Errorf("inspect test volume during cleanup: %v", err)
				case volume.Labels[labelScope] != scope || volume.Labels[labelAgentID] != agent:
					t.Errorf("refusing cleanup of volume with unexpected ownership: %s", name)
				default:
					removeErr(client.RemoveVolume(cleanup, name))
				}
			}
		}
		volume, err := client.InspectVolume(cleanup, skillsVolume)
		switch {
		case errors.Is(err, ErrNotFound):
		case err != nil:
			t.Errorf("inspect test Skills volume during cleanup: %v", err)
		case volume.Labels[labelManaged] != "skills" || volume.Labels[labelScope] != owner:
			t.Error("refusing cleanup of Skills volume with unexpected ownership")
		default:
			removeErr(client.RemoveVolume(cleanup, skillsVolume))
		}
		var observed struct {
			ID     string            `json:"Id"`
			Labels map[string]string `json:"Labels"`
		}
		err = client.do(cleanup, http.MethodGet, "/networks/"+network, nil, &observed)
		switch {
		case errors.Is(err, ErrNotFound):
		case err != nil:
			t.Errorf("inspect test network during cleanup: %v", err)
		case observed.ID == "" || observed.Labels[labelManaged] != "test-network" || observed.Labels[labelScope] != owner:
			t.Error("refusing cleanup of network with unexpected ownership")
		default:
			removeErr(client.do(cleanup, http.MethodDelete, "/networks/"+observed.ID, nil, nil))
		}
	})

	resolved, err := client.InspectImage(ctx, image)
	if err != nil {
		t.Fatalf("test image is not installed: %v", err)
	}
	if err := client.do(ctx, http.MethodPost, "/networks/create", map[string]any{
		"Name": network, "Driver": "bridge", "CheckDuplicate": true,
		"Labels": map[string]string{labelManaged: "test-network", labelScope: owner},
	}, nil); err != nil {
		t.Fatalf("create isolated test network: %v", err)
	}
	if err := client.CreateVolume(ctx, skillsVolume, map[string]string{labelManaged: "skills", labelScope: owner}); err != nil {
		t.Fatal(err)
	}

	drivers := make([]*Driver, 0, len(scopes))
	for _, scope := range scopes {
		writer, err := NewResolverVolumeWriter(client, image, scope)
		if err != nil {
			t.Fatal(err)
		}
		driver, err := NewDriver(client, Config{
			ControllerScope: scope, ManagementNetwork: network,
			SystemSkillsVolume: skillsVolume, ResolverMountGate: writer,
		})
		if err != nil {
			t.Fatal(err)
		}
		drivers = append(drivers, driver)
	}
	for _, driver := range drivers {
		if outcome := driver.EnsureStorage(ctx, agent); outcome.State != deployment.EffectCompleted {
			t.Fatalf("ensure workspace: %+v", outcome)
		}
		value := scopeIntegrationDeployment(agent, 1, resolved)
		digest, err := driver.DeploymentDigest(value)
		if err != nil {
			t.Fatal(err)
		}
		outcome := driver.Create(ctx, value, digest)
		if outcome.State != deployment.EffectCompleted {
			t.Fatalf("create: %+v", outcome)
		}
	}
	for i, scope := range scopes {
		container, err := client.InspectContainer(ctx, runtimeContainerName(scope, agent))
		if err != nil || container.Labels[labelScope] != scope || container.Labels[labelAgentID] != agent {
			t.Fatalf("scoped container for %s: %+v err=%v", scope, container, err)
		}
		if !slices.ContainsFunc(container.Mounts, func(m ObservedMount) bool {
			return m.Destination == "/workspace" && m.Name == workspaceVolumeName(scope, agent)
		}) {
			t.Fatalf("scoped workspace mount missing for %s: %+v", scope, container.Mounts)
		}
		if _, err := client.InspectContainer(ctx, runtimeContainerName(scopes[1-i], agent)); err != nil {
			t.Fatalf("other scope container missing: %v", err)
		}
	}
	if details, err := client.InspectNetworkDetails(ctx, network); err != nil || len(details.IPAM) == 0 {
		t.Fatalf("management network details: %+v err=%v", details, err)
	}
	if _, err := drivers[0].List(ctx); err != nil {
		t.Fatal(err)
	}
	if capacity := drivers[0].Capacity(); !capacity.Known {
		t.Fatal("cached capacity snapshot is unknown after a reconciling List")
	}

	value := scopeIntegrationDeployment(agent, 1, resolved)
	digest, err := drivers[0].DeploymentDigest(value)
	if err != nil {
		t.Fatal(err)
	}
	deleted := drivers[0].Delete(ctx, deployment.Key{AgentID: agent, Generation: 1}, digest)
	if deleted.State != deployment.EffectCompleted {
		t.Fatalf("delete own scoped container: %+v", deleted)
	}
	if _, err := client.InspectContainer(ctx, runtimeContainerName(scopes[0], agent)); err == nil {
		t.Fatal("own scoped container survived deletion")
	}
	if _, err := client.InspectContainer(ctx, runtimeContainerName(scopes[1], agent)); err != nil {
		t.Fatal("other scope container was deleted")
	}
	if outcome := drivers[0].DeleteStorage(ctx, agent); outcome.State != deployment.EffectCompleted {
		t.Fatalf("delete own workspace: %+v", outcome)
	}
	if _, err := client.InspectVolume(ctx, workspaceVolumeName(scopes[0], agent)); err == nil {
		t.Fatal("own scoped workspace leaked")
	}
	if _, err := client.InspectVolume(ctx, workspaceVolumeName(scopes[1], agent)); err != nil {
		t.Fatal("other scope workspace was deleted")
	}
	if writer, werr := NewResolverVolumeWriter(client, image, scopes[0]); werr != nil {
		t.Fatal(werr)
	} else if err := writer.Remove(ctx, deployment.Key{AgentID: agent, Generation: 1}); err != nil {
		t.Errorf("resolver volume cleanup: %v", err)
	}
	inspections, err := drivers[1].List(ctx)
	if err != nil || !slices.ContainsFunc(inspections, func(c deployment.Inspection) bool { return c.AgentID == agent }) {
		t.Fatalf("remaining scope lost its managed inventory: %+v err=%v", inspections, err)
	}
}
