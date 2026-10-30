package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"io"
	"testing"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
)

type resolverArchiveEngine struct {
	*fakeEngine
	archives map[string][]byte
	writes   int
}

func newResolverEngine() *resolverArchiveEngine {
	return &resolverArchiveEngine{fakeEngine: newFakeEngine(), archives: map[string][]byte{}}
}

func (e *resolverArchiveEngine) PutArchive(_ context.Context, _, path string, input io.Reader) error {
	data, err := io.ReadAll(input)
	if err != nil {
		return err
	}
	e.writes++
	e.archives[path] = data
	if path == "/run" {
		e.archives["/run/antnest-resolver"] = data
	}
	return nil
}

func (e *resolverArchiveEngine) GetArchive(_ context.Context, _, path string) (io.ReadCloser, error) {
	data, ok := e.archives[path]
	if !ok {
		return nil, ErrNotFound
	}
	return io.NopCloser(bytes.NewReader(data)), nil
}

func resolverDirArchive(t *testing.T, document string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	if err := w.WriteHeader(&tar.Header{Name: "antnest-resolver", Mode: 0755, Typeflag: tar.TypeDir, Uid: 0, Gid: 0}); err != nil {
		t.Fatal(err)
	}
	if document != "" {
		if err := w.WriteHeader(&tar.Header{Name: "antnest-resolver/resolv.conf", Mode: 0444, Typeflag: tar.TypeReg, Uid: 0, Gid: 0, Size: int64(len(document))}); err != nil {
			t.Fatal(err)
		}
		if _, err := w.Write([]byte(document)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func resolverFileArchive(t *testing.T, document string) []byte {
	t.Helper()
	var b bytes.Buffer
	w := tar.NewWriter(&b)
	if err := w.WriteHeader(&tar.Header{Name: "resolv.conf", Mode: 0444, Typeflag: tar.TypeReg, Uid: 0, Gid: 0, Size: int64(len(document))}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write([]byte(document)); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func newResolverWriter(t *testing.T, engine *resolverArchiveEngine) *ResolverVolumeWriter {
	t.Helper()
	writer, err := NewResolverVolumeWriter(engine, "antnest/runtime-controller:local", "test-controller")
	if err != nil {
		t.Fatal(err)
	}
	return writer
}

func resolverKey() deployment.Key {
	return deployment.Key{AgentID: "agent-1", Generation: 7}
}

func TestResolverPrepareCreatesHelperWritesDocumentAndCleansUp(t *testing.T) {
	engine := newResolverEngine()
	writer := newResolverWriter(t, engine)

	if err := writer.Prepare(context.Background(), resolverKey(), "100.64.0.1"); err != nil {
		t.Fatalf("prepare resolver volume: %v", err)
	}
	name := resolverVolumeName("test-controller", "agent-1", 7)
	volume := engine.volumes[name]
	if volume.Labels[labelManaged] != "runtime-resolver" ||
		volume.Labels["io.antnest.resolver-content-digest"] == "" {
		t.Fatalf("resolver volume identity missing: %+v", volume)
	}
	if engine.writes != 1 || engine.archives["/run"] == nil {
		t.Fatalf("resolver document was not written through the helper: %+v", engine.archives)
	}
	if engine.removeCalls != 1 || engine.container != nil {
		t.Fatalf("resolver helper was not cleaned up: %+v", engine)
	}
}

func TestResolverPrepareWithRunningRuntimeOnlyVerifiesReadOnly(t *testing.T) {
	engine := newResolverEngine()
	name := resolverVolumeName("test-controller", "agent-1", 7)
	document, _ := resolverDocument("100.64.0.1")
	engine.volumes[name] = Volume{
		Name: name, Labels: resolverVolumeLabels("test-controller", resolverKey(), document),
	}
	engine.archives["/etc/resolv.conf"] = resolverFileArchive(t, document)
	engine.container = &Container{
		ID: "runtime-1", Name: containerName("agent-1"), Running: true, Status: "running",
		Labels: map[string]string{
			labelManaged: "runtime", labelScope: "test-controller",
			labelAgentID: "agent-1", labelGeneration: "7",
		},
		Mounts: []ObservedMount{{
			Type: "volume", Name: name, Destination: "/etc/resolv.conf",
			ReadWrite: false, NoCopy: true, Subpath: "resolv.conf",
		}},
	}
	writer := newResolverWriter(t, engine)

	if err := writer.Prepare(context.Background(), resolverKey(), "100.64.0.1"); err != nil {
		t.Fatalf("exact running resolver adoption failed: %v", err)
	}
	if engine.createCalls != 0 || engine.writes != 0 {
		t.Fatalf("running Runtime must never get a preparation helper or rewrite: %+v", engine)
	}
}

func TestResolverPrepareRejectsForeignVolumeLabels(t *testing.T) {
	engine := newResolverEngine()
	name := resolverVolumeName("test-controller", "agent-1", 7)
	engine.volumes[name] = Volume{Name: name, Labels: map[string]string{labelManaged: "workspace"}}
	writer := newResolverWriter(t, engine)

	err := writer.Prepare(context.Background(), resolverKey(), "100.64.0.1")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("foreign resolver volume must conflict: %v", err)
	}
}

func TestResolverPrepareNeverOverwritesContentDrift(t *testing.T) {
	engine := newResolverEngine()
	name := resolverVolumeName("test-controller", "agent-1", 7)
	document, _ := resolverDocument("100.64.0.1")
	engine.volumes[name] = Volume{
		Name: name, Labels: resolverVolumeLabels("test-controller", resolverKey(), document),
	}
	engine.archives["/run/antnest-resolver"] = resolverDirArchive(t, "nameserver 8.8.8.8\n")
	writer := newResolverWriter(t, engine)

	err := writer.Prepare(context.Background(), resolverKey(), "100.64.0.1")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("resolver content drift must conflict, not be rewritten: %v", err)
	}
	if engine.writes != 0 {
		t.Fatal("drifted resolver volume was overwritten")
	}
}

func TestResolverVerifyRejectsUnexpectedWritableOrSubpathMount(t *testing.T) {
	engine := newResolverEngine()
	name := resolverVolumeName("test-controller", "agent-1", 7)
	document, _ := resolverDocument("100.64.0.1")
	engine.volumes[name] = Volume{
		Name: name, Labels: resolverVolumeLabels("test-controller", resolverKey(), document),
	}
	engine.archives["/etc/resolv.conf"] = resolverFileArchive(t, document)
	writer := newResolverWriter(t, engine)
	base := func() *Container {
		return &Container{
			ID: "runtime-1", Name: containerName("agent-1"), Running: true, Status: "running",
			Labels: map[string]string{
				labelManaged: "runtime", labelScope: "test-controller",
				labelAgentID: "agent-1", labelGeneration: "7",
			},
		}
	}
	for _, test := range []struct {
		name  string
		mount ObservedMount
	}{
		{"writable", ObservedMount{Type: "volume", Name: name, Destination: "/etc/resolv.conf", ReadWrite: true, NoCopy: true, Subpath: "resolv.conf"}},
		{"missing_subpath", ObservedMount{Type: "volume", Name: name, Destination: "/etc/resolv.conf", NoCopy: true}},
		{"bind_replacement", ObservedMount{Type: "bind", Name: name, Destination: "/etc/resolv.conf", NoCopy: true, Subpath: "resolv.conf"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			container := base()
			container.Mounts = []ObservedMount{test.mount}
			engine.container = container
			if err := writer.VerifyRuntimeMount(context.Background(), resolverKey(), "100.64.0.1", "runtime-1"); err == nil {
				t.Fatalf("%s resolver mount must fail closed", test.name)
			}
		})
	}
}

func TestResolverVerifyRejectsAutocreatedReplacementVolume(t *testing.T) {
	engine := newResolverEngine()
	document, _ := resolverDocument("100.64.0.1")
	engine.archives["/etc/resolv.conf"] = resolverFileArchive(t, document)
	engine.container = &Container{
		ID: "runtime-1", Name: containerName("agent-1"), Running: true, Status: "running",
		Labels: map[string]string{
			labelManaged: "runtime", labelScope: "test-controller",
			labelAgentID: "agent-1", labelGeneration: "7",
		},
	}
	writer := newResolverWriter(t, engine)

	err := writer.VerifyRuntimeMount(context.Background(), resolverKey(), "100.64.0.1", "runtime-1")
	if err == nil {
		t.Fatal("missing or auto-created resolver volume must fail closed")
	}
}

func TestResolverRemoveRequiresAbsentComputeAndOwnedVolume(t *testing.T) {
	engine := newResolverEngine()
	name := resolverVolumeName("test-controller", "agent-1", 7)
	document, _ := resolverDocument("100.64.0.1")
	engine.volumes[name] = Volume{
		Name: name, Labels: resolverVolumeLabels("test-controller", resolverKey(), document),
	}
	engine.container = &Container{ID: "runtime-1", Name: containerName("agent-1")}
	writer := newResolverWriter(t, engine)

	if err := writer.Remove(context.Background(), resolverKey()); !errors.Is(err, ErrConflict) {
		t.Fatalf("removing a mounted resolver volume must conflict: %v", err)
	}
	engine.container = nil
	engine.volumes[name] = Volume{Name: name, Labels: map[string]string{labelManaged: "workspace"}}
	if err := writer.Remove(context.Background(), resolverKey()); !errors.Is(err, ErrConflict) {
		t.Fatalf("removing an unowned volume must conflict: %v", err)
	}
	engine.volumes[name] = Volume{
		Name: name, Labels: resolverVolumeLabels("test-controller", resolverKey(), document),
	}
	if err := writer.Remove(context.Background(), resolverKey()); err != nil {
		t.Fatalf("remove owned resolver volume: %v", err)
	}
	if engine.removeVolumeCalls != 1 {
		t.Fatalf("resolver volume removal count: %+v", engine)
	}
	if err := writer.Remove(context.Background(), resolverKey()); err != nil {
		t.Fatalf("absent resolver volume removal must succeed: %v", err)
	}
}
