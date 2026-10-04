package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
)

type instanceArchiveEngine struct {
	*fakeEngine
	archive []byte
}

func (e *instanceArchiveEngine) PutArchive(_ context.Context, _, _ string, input io.Reader) error {
	data, err := io.ReadAll(input)
	e.archive = data
	return err
}
func (e *instanceArchiveEngine) GetArchive(_ context.Context, _, _ string) (io.ReadCloser, error) {
	return io.NopCloser(bytes.NewReader(e.archive)), nil
}

func instanceArchive(t *testing.T, profile []byte, mode int64) []byte {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	for _, h := range []*tar.Header{{Name: "antnest-auth/", Mode: 0700, Typeflag: tar.TypeDir, Uid: 0, Gid: 0}, {Name: "antnest-auth/callers.json", Mode: mode, Typeflag: tar.TypeReg, Uid: 0, Gid: 0, Size: int64(len(profile))}} {
		if err := w.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			if _, err := w.Write(profile); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func TestInstanceMountChecksActualVolumeAndRootOnlyProfile(t *testing.T) {
	ctx := context.Background()
	id := instanceauth.Identity{Scope: "test-controller", AgentID: "agent-1", Generation: 7}
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	record, _ := issuer.Issue(id)
	profile, _ := issuer.Receiver(id, record)
	engine := &instanceArchiveEngine{fakeEngine: newFakeEngine(), archive: instanceArchive(t, profile, 0600)}
	writer, err := NewInstanceVolumeWriter(engine, "preparer:local", issuer, id.Scope)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := &deployment.RuntimeAuthentication{ConnectionID: record.ConnectionID, CallersFile: instanceauth.CallersFile, ReceiverDigest: record.ReceiverDigest}
	name := instanceVolumeName(id)
	engine.volumes[name] = Volume{Name: name, Labels: instanceVolumeLabels(id, descriptor)}
	engine.container = exactContainer()
	engine.container.Mounts = []ObservedMount{{Type: "volume", Name: name, Destination: instanceauth.Directory, ReadWrite: false, NoCopy: true}}
	key := deployment.Key{AgentID: id.AgentID, Generation: id.Generation}
	if err := writer.VerifyRuntimeMount(ctx, key, descriptor, engine.container.ID); err != nil {
		t.Fatal(err)
	}
	engine.volumes[name] = Volume{Name: name, Labels: map[string]string{}}
	if err := writer.VerifyRuntimeMount(ctx, key, descriptor, engine.container.ID); err == nil {
		t.Fatal("Docker-created empty replacement volume admitted")
	}
	engine.volumes[name] = Volume{Name: name, Labels: instanceVolumeLabels(id, descriptor)}
	engine.archive = instanceArchive(t, profile, 0644)
	if err := writer.VerifyRuntimeMount(ctx, key, descriptor, engine.container.ID); err == nil {
		t.Fatal("executor-readable receiver accepted")
	}
	engine.archive = instanceArchive(t, []byte(`{}`), 0600)
	if err := writer.VerifyRuntimeMount(ctx, key, descriptor, engine.container.ID); err == nil {
		t.Fatal("different receiver profile accepted")
	}
}

type rejectingInstanceGate struct{ calls int }

func (g *rejectingInstanceGate) Prepare(context.Context, deployment.Key, *instanceauth.Record) error {
	return nil
}
func (g *rejectingInstanceGate) VerifyRuntimeMount(context.Context, deployment.Key, *deployment.RuntimeAuthentication, string) error {
	g.calls++
	return errors.New("actual receiver volume differs")
}
func (*rejectingInstanceGate) Remove(context.Context, deployment.Key) error { return nil }

func TestRuntimeCannotStartBeforeInstanceMountAdmission(t *testing.T) {
	engine := newFakeEngine()
	engine.createMaterializes = true
	gate := &rejectingInstanceGate{}
	driver := newTestDriver(t, engine)
	driver.config.InstanceMountGate = gate
	issuer, _ := instanceauth.New(bytes.Repeat([]byte{42}, 32))
	id := instanceauth.Identity{Scope: "test-controller", AgentID: "agent-1", Generation: 7}
	record, _ := issuer.Issue(id)
	physical := testDeployment()
	physical.InstanceAuthentication = record
	physical.RuntimeSpec.Authentication = &deployment.RuntimeAuthentication{ConnectionID: record.ConnectionID, CallersFile: instanceauth.CallersFile, ReceiverDigest: record.ReceiverDigest}
	digest, err := driver.DeploymentDigest(physical)
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(context.Background(), physical, digest)
	if outcome.State != deployment.EffectUnknown || outcome.Code != "instance_mount_verification_failed" || gate.calls != 1 || engine.startCalls != 0 {
		t.Fatal("candidate started before receiver verification", outcome)
	}
}
