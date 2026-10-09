package docker

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

func TestInstanceReceiverPreparedInStoppedDockerVolume(t *testing.T) {
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
	id := instanceauth.Identity{Scope: "rc-volume-test-" + hex.EncodeToString(nonce[:]), AgentID: "agent-" + hex.EncodeToString(nonce[:]), Generation: 1}
	key := deployment.Key{AgentID: id.AgentID, Generation: id.Generation}
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	record, err := issuer.Issue(id)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := NewInstanceVolumeWriter(client, image, issuer, id.Scope)
	if err != nil {
		t.Fatal(err)
	}
	name := instanceVolumeName(id)
	helperName := "antnest-auth-preparer-" + strings.TrimPrefix(name, "antnest-runtime-auth-")
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		for _, container := range []string{containerName(id.AgentID), helperName} {
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
		if err := writer.Prepare(ctx, key, record); err != nil {
			t.Fatalf("stopped-volume receiver preparation: %v", err)
		}
	}
	descriptor := &deployment.RuntimeAuthentication{ConnectionID: record.ConnectionID, CallersFile: instanceauth.CallersFile, ReceiverDigest: record.ReceiverDigest, Tunnel: record.Tunnel.Descriptor()}
	create := func() string {
		t.Helper()
		labels := instanceVolumeLabels(id, descriptor)
		labels[labelManaged] = "runtime"
		candidate, err := client.CreateContainer(ctx, ContainerSpec{Name: containerName(id.AgentID), Image: image, User: "0:0", NetworkMode: "none", Labels: labels, Mounts: map[string]Mount{instanceauth.Directory: {Source: name, ReadOnly: true, NoCopy: true}}})
		if err != nil {
			t.Fatal(err)
		}
		return candidate
	}
	candidate := create()
	if err := writer.VerifyRuntimeMount(ctx, key, descriptor, candidate); err != nil {
		t.Fatal(err)
	}
	if err := client.RemoveContainer(ctx, candidate); err != nil {
		t.Fatal(err)
	}
	if err := client.RemoveVolume(ctx, name); err != nil {
		t.Fatal(err)
	}
	// Docker creates an empty, unlabeled volume if it disappears after preflight.
	// The post-create gate must reject it before any candidate process starts.
	candidate = create()
	if err := writer.VerifyRuntimeMount(ctx, key, descriptor, candidate); err == nil {
		t.Fatal("Docker-created replacement volume passed actual mount verification")
	}
}
