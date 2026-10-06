package docker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type volumeSecretResolver struct{ calls int }

func (resolver *volumeSecretResolver) Resolve(context.Context, *deployment.MCPTemplateSource, []deployment.MCPServer) (map[string]map[string]string, error) {
	resolver.calls++
	return map[string]map[string]string{"docs": {"API_KEY": "docker-managed-secret-canary"}}, nil
}

func TestManagedMCPSecretsPreparedInStoppedDockerVolume(t *testing.T) {
	socket := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_RUNTIME_CONTROLLER_TEST_DOCKER_SOCKET enables isolated Docker volume integration")
	}
	image := os.Getenv("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG")
	if image == "" {
		t.Fatal("ANTNEST_RUNTIME_CONTROLLER_TEST_IMAGE_TAG must name an installed image")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		t.Fatal(err)
	}
	scope := "rc-mcp-test-" + hex.EncodeToString(nonce[:])
	key := deployment.Key{AgentID: "agent-" + hex.EncodeToString(nonce[:]), Generation: 1}
	source := &deployment.MCPTemplateSource{OrganizationID: "org", TemplateID: "template", Revision: 1}
	digest := sha256.Sum256([]byte("docker-managed-secret-canary"))
	servers := []deployment.MCPServer{{ID: "docs", Command: "node", SecretEnv: map[string]deployment.MCPSecretDescriptor{"API_KEY": {Set: true, Fingerprint: "sha256:" + hex.EncodeToString(digest[:4])}}}}
	resolver := &volumeSecretResolver{}
	writer, err := NewMCPVolumeWriter(client, image, scope, resolver)
	if err != nil {
		t.Fatal(err)
	}
	name := mcpVolumeName(scope, key)
	helper := "antnest-mcp-preparer-" + strings.TrimPrefix(name, "antnest-runtime-mcp-")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, container := range []string{containerName(key.AgentID), helper} {
			if _, err := client.InspectContainer(ctx, container); err == nil {
				if err := client.RemoveContainer(ctx, container); err != nil {
					t.Error(err)
				}
			}
		}
		if _, err := client.InspectVolume(ctx, name); err == nil {
			if err := client.RemoveVolume(ctx, name); err != nil {
				t.Error(err)
			}
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	for range 2 {
		if err := writer.Prepare(ctx, key, source, servers); err != nil {
			t.Fatal("secret preparation failed", err)
		}
	}
	if resolver.calls != 1 {
		t.Fatal("verified bootstrap was fetched again")
	}
	if _, err := client.InspectContainer(ctx, helper); err == nil {
		t.Fatal("preparation left a helper container")
	}
	create := func() string {
		t.Helper()
		labels := mcpVolumeLabels(scope, key, source, servers)
		labels[labelManaged] = "runtime"
		id, err := client.CreateContainer(ctx, ContainerSpec{Name: containerName(key.AgentID), Image: image, User: "0:0", NetworkMode: "none", Labels: labels, Mounts: map[string]Mount{mcpSecretDirectory: {Source: name, ReadOnly: true, NoCopy: true}}})
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	id := create()
	if err := writer.VerifyRuntimeMount(ctx, key, source, servers, id); err != nil {
		t.Fatal("actual read-only mount verification failed", err)
	}
	if err := client.RemoveContainer(ctx, id); err != nil {
		t.Fatal(err)
	}
	if err := writer.Remove(ctx, key); err != nil {
		t.Fatal(err)
	}
	// A deleted volume is silently recreated by Docker. Reject it before start.
	id = create()
	if err := writer.VerifyRuntimeMount(ctx, key, source, servers, id); err == nil {
		t.Fatal("unlabeled empty replacement was admitted")
	}
}
