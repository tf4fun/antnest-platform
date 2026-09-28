package docker

import (
	"context"
	"io"
	"testing"

	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type cleanupEngineStub struct{ *fakeEngine }

func (*cleanupEngineStub) PutArchive(context.Context, string, string, io.Reader) error { return nil }
func (*cleanupEngineStub) GetArchive(context.Context, string, string) (io.ReadCloser, error) {
	return nil, ErrNotFound
}

func TestPreparedSkillCleanupDeletesOnlyOwnedVolume(t *testing.T) {
	engine := newFakeEngine()
	writer, err := NewSkillVolumeWriter(&cleanupEngineStub{engine}, "antnest/runtime-controller:local")
	if err != nil {
		t.Fatal(err)
	}
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	key := skillset.SetKey{Scope: "test-controller", OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	engine.volumes[name] = Volume{Name: name, Labels: map[string]string{labelManaged: "foreign"}}
	if err := writer.RemovePreparedVolume(context.Background(), key); err == nil || engine.removeVolumeCalls != 0 {
		t.Fatalf("deleted foreign volume: %v", err)
	}
	engine.volumes[name] = Volume{Name: name, Labels: skillVolumeLabels(key)}
	prepared := skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name}
	if err := writer.RemovePreparedVolume(context.Background(), key); err != nil || engine.removeVolumeCalls != 1 {
		t.Fatalf("owned cleanup: %v deletes=%d", err, engine.removeVolumeCalls)
	}
	if err := writer.RemovePreparedVolume(context.Background(), key); err != nil || engine.removeVolumeCalls != 1 {
		t.Fatalf("missing volume cleanup replay: %v deletes=%d", err, engine.removeVolumeCalls)
	}
	if err := writer.InspectPreparedVolume(context.Background(), prepared); err != ErrSkillVolumeMissing {
		t.Fatalf("missing volume preflight: %v", err)
	}
}
