package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"strings"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type readyInspectEngine struct {
	*fakeEngine
	manifestArchive   []byte
	collectionArchive []byte
}

func (e *readyInspectEngine) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	id, err := e.fakeEngine.CreateContainer(ctx, spec)
	if err == nil {
		e.container.Status = "created"
		e.container.Mounts = []ObservedMount{{Name: spec.Mounts["/skills"].Source, Destination: "/skills", Type: "volume", NoCopy: true, ReadWrite: true}}
	}
	return id, err
}

func (*readyInspectEngine) PutArchive(context.Context, string, string, io.Reader) error { return nil }
func (e *readyInspectEngine) GetArchive(_ context.Context, _, path string) (io.ReadCloser, error) {
	switch path {
	case "/skills/.antnest-skills.json":
		if e.manifestArchive == nil {
			return nil, ErrNotFound
		}
		return io.NopCloser(bytes.NewReader(e.manifestArchive)), nil
	case "/skills":
		return io.NopCloser(bytes.NewReader(e.collectionArchive)), nil
	default:
		return nil, ErrNotFound
	}
}

func readyInspectArchive(entries []struct {
	header  tar.Header
	content []byte
}) []byte {
	var out bytes.Buffer
	writer := tar.NewWriter(&out)
	for _, entry := range entries {
		_ = writer.WriteHeader(&entry.header)
		_, _ = writer.Write(entry.content)
	}
	_ = writer.Close()
	return out.Bytes()
}

func TestReadySkillPreflightChecksManifestAndFullContent(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	setDigest := "sha256:" + strings.Repeat("a", 64)
	key := skillset.SetKey{Scope: "test-controller", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: setDigest, LayoutVersion: 1, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	manifest := []byte(`{"layout_version":1,"organization_id":"` + org + `","agent_id":"agent-1","skill_set_digest":"` + setDigest + `","skills":[{"name":"code-review","files":[{"path":"SKILL.md","size":3,"digest":"sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad","executable":false}]}]}`)
	hash := sha256.Sum256(manifest)
	prepared := skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name, ManifestDigest: "sha256:" + hex.EncodeToString(hash[:])}
	manifestArchive := readyInspectArchive([]struct {
		header  tar.Header
		content []byte
	}{{tar.Header{Name: ".antnest-skills.json", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(manifest))}, manifest}})
	collection := func(body string) []byte {
		return readyInspectArchive([]struct {
			header  tar.Header
			content []byte
		}{
			{tar.Header{Name: "skills/", Typeflag: tar.TypeDir, Mode: 0755}, nil},
			{tar.Header{Name: "skills/code-review/", Typeflag: tar.TypeDir, Mode: 0555}, nil},
			{tar.Header{Name: "skills/code-review/SKILL.md", Typeflag: tar.TypeReg, Mode: 0444, Size: 3}, []byte(body)},
			{tar.Header{Name: "skills/.antnest-skills.json", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(manifest))}, manifest},
		})
	}
	for _, test := range []struct {
		name     string
		manifest []byte
		content  []byte
		drift    bool
	}{
		{"valid", manifestArchive, collection("abc"), false},
		{"missing manifest", nil, collection("abc"), true},
		{"modified Skill body", manifestArchive, collection("xyz"), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			engine := &readyInspectEngine{fakeEngine: newFakeEngine(), manifestArchive: test.manifest, collectionArchive: test.content}
			engine.volumes[name] = Volume{Name: name, Labels: skillVolumeLabels(key)}
			writer, err := NewSkillVolumeWriter(engine, "antnest/runtime-controller:local")
			if err != nil {
				t.Fatal(err)
			}
			err = writer.VerifyPreparedCollection(context.Background(), prepared)
			if test.drift && !errors.Is(err, ErrConflict) {
				t.Fatalf("drift accepted: %v", err)
			}
			if !test.drift && err != nil {
				t.Fatalf("valid ready collection rejected: %v", err)
			}
			if engine.removeCalls != 1 {
				t.Fatalf("preflight helper leaked: removals=%d", engine.removeCalls)
			}
		})
	}
}

func TestActiveSkillVerificationChecksCurrentGenerationAndMountedManifest(t *testing.T) {
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, skillset.LayoutVersion, []skillset.FrozenSkill{})
	if err != nil {
		t.Fatal(err)
	}
	key := skillset.SetKey{Scope: "test-controller", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	manifest := []byte(`{"layout_version":1,"organization_id":"` + org + `","agent_id":"agent-1","skill_set_digest":"` + digest + `","skills":[]}`)
	hash := sha256.Sum256(manifest)
	prepared := skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name, ManifestDigest: "sha256:" + hex.EncodeToString(hash[:])}
	archive := readyInspectArchive([]struct {
		header  tar.Header
		content []byte
	}{{tar.Header{Name: ".antnest-skills.json", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(len(manifest))}, manifest}})
	engine := &readyInspectEngine{fakeEngine: newFakeEngine(), manifestArchive: archive}
	engine.volumes[name] = Volume{Name: name, Labels: skillVolumeLabels(key)}
	engine.container = &Container{ID: "runtime-1", Name: containerName("agent-1"), Status: "running", Running: true,
		Labels: map[string]string{labelManaged: "runtime", labelScope: key.Scope, labelAgentID: key.AgentID, labelGeneration: "3", labelSpecDigest: "sha256:" + strings.Repeat("a", 64)},
		Mounts: []ObservedMount{{Type: "volume", Name: name, Destination: "/skills", ReadWrite: false, NoCopy: true}}}
	writer, err := NewSkillVolumeWriter(engine, "antnest/runtime-controller:local")
	if err != nil {
		t.Fatal(err)
	}
	specDigest := "sha256:" + strings.Repeat("a", 64)
	if err := writer.VerifyActiveRuntimeMount(context.Background(), prepared, 3, specDigest); err != nil {
		t.Fatalf("valid active mount rejected: %v", err)
	}
	if err := writer.VerifyActiveRuntimeMount(context.Background(), prepared, 4, specDigest); !errors.Is(err, ErrSkillMountVerificationFailed) {
		t.Fatalf("stale generation admitted: %v", err)
	}
	engine.container.Mounts[0].ReadWrite = true
	if err := writer.VerifyActiveRuntimeMount(context.Background(), prepared, 3, specDigest); !errors.Is(err, ErrSkillMountVerificationFailed) {
		t.Fatalf("writable mount admitted: %v", err)
	}
	engine.container.Mounts[0].ReadWrite = false
	engine.container.Labels[labelSpecDigest] = "sha256:" + strings.Repeat("b", 64)
	if err := writer.VerifyActiveRuntimeMount(context.Background(), prepared, 3, specDigest); !errors.Is(err, ErrSkillMountVerificationFailed) {
		t.Fatalf("changed deployment admitted: %v", err)
	}
	engine.container.Labels[labelSpecDigest] = specDigest
	engine.manifestArchive = nil
	if err := writer.VerifyActiveRuntimeMount(context.Background(), prepared, 3, specDigest); !errors.Is(err, ErrSkillMountVerificationFailed) {
		t.Fatalf("missing manifest admitted: %v", err)
	}
}
