package docker

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type skillVolumeDeletionRaceEngine struct {
	*Client
	volumeName string
	removed    bool
	startCalls int
}

func (e *skillVolumeDeletionRaceEngine) CreateContainer(ctx context.Context, spec ContainerSpec) (string, error) {
	if err := e.RemoveVolume(ctx, e.volumeName); err != nil {
		return "", err
	}
	e.removed = true
	return e.Client.CreateContainer(ctx, spec)
}

func (e *skillVolumeDeletionRaceEngine) StartContainer(context.Context, string) error {
	e.startCalls++
	return errors.New("rejected Skill candidate must never start")
}

func TestDockerDeletedPreparedVolumeCannotStartRuntimeCandidate(t *testing.T) {
	socket := os.Getenv("ANTNEST_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_TEST_DOCKER_SOCKET is not set")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(random[:])
	agentID, scope := "skill-race-"+suffix, "skill-race-"+suffix
	org := "org_00000000000000000000000000000000"
	setDigest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	key := skillset.SetKey{Scope: scope, OrganizationID: org, AgentID: agentID, SkillSetDigest: setDigest, LayoutVersion: 1, Materialization: 1}
	volumeName, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	workspaceName := workspaceVolume(agentID)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := client.CreateVolume(ctx, workspaceName, map[string]string{labelManaged: "workspace", labelScope: scope, labelAgentID: agentID}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		_ = client.RemoveContainer(cleanup, containerName(agentID))
		if err := client.RemoveVolume(cleanup, volumeName); err != nil && !errors.Is(err, ErrNotFound) {
			t.Errorf("remove auto-created race volume: %v", err)
		}
		if err := client.RemoveVolume(cleanup, workspaceName); err != nil && !errors.Is(err, ErrNotFound) {
			t.Errorf("remove race workspace volume: %v", err)
		}
	})
	if err := client.CreateVolume(ctx, volumeName, skillVolumeLabels(key)); err != nil {
		t.Fatal(err)
	}
	imageID, err := client.InspectImage(ctx, "antnest/antnest-runtime:local")
	if err != nil {
		t.Fatal(err)
	}
	engine := &skillVolumeDeletionRaceEngine{Client: client, volumeName: volumeName}
	gate, err := NewSkillVolumeWriter(engine, imageID)
	if err != nil {
		t.Fatal(err)
	}
	driver, err := NewDriver(engine, Config{ControllerScope: scope, ManagementNetwork: "bridge", SystemSkillsVolume: "unused", SkillMountGate: gate})
	if err != nil {
		t.Fatal(err)
	}
	value := testDeployment()
	value.ImageRef = imageID
	value.RuntimeSpec.AgentID = agentID
	value.PreparedSkills = &skillset.PreparedReference{Scope: scope, OrganizationID: org, AgentID: agentID, SkillSetDigest: setDigest, LayoutVersion: 1, ReferenceID: "psr_11111111111111111111111111111111", SystemSkills: []skillset.FrozenSkill{}}
	value.PreparedMaterialization = &skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: volumeName, ManifestDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
	digest, err := driver.DeploymentDigest(value)
	if err != nil {
		t.Fatal(err)
	}
	outcome := driver.Create(ctx, value, digest)
	if !engine.removed || outcome.State != deployment.EffectUnknown || outcome.Code != "skill_mount_verification_failed" || engine.startCalls != 0 {
		t.Fatalf("Docker auto-created empty Skill volume was accepted: outcome=%+v removed=%v starts=%d", outcome, engine.removed, engine.startCalls)
	}
	if _, err := client.InspectContainer(ctx, containerName(agentID)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rejected unstarted candidate remains: %v", err)
	}
	replacement, err := client.InspectVolume(ctx, volumeName)
	if err != nil || len(replacement.Labels) != 0 {
		t.Fatalf("Docker race did not produce an untrusted unlabeled volume: %+v %v", replacement, err)
	}
}

func TestUnstartedDockerPreparationArchiveRoundTrip(t *testing.T) {
	socket := os.Getenv("ANTNEST_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_TEST_DOCKER_SOCKET is not set")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	suffix := hex.EncodeToString(random[:])
	volumeName, containerName := "antnest-skill-e2e-volume-"+suffix, "antnest-skill-e2e-preparer-"+suffix
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	if err := client.CreateVolume(ctx, volumeName, map[string]string{"io.antnest.e2e": "system-skill-archive"}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		_ = client.RemoveContainer(cleanup, containerName)
		if err := client.RemoveVolume(cleanup, volumeName); err != nil {
			t.Errorf("remove E2E volume: %v", err)
		}
	})
	_, err = client.CreateContainer(ctx, ContainerSpec{
		Name: containerName, Image: "antnest/antnest-runtime:local", User: "0:0", NetworkMode: "none",
		Mounts: map[string]Mount{"/skills": {Source: volumeName, NoCopy: true}},
		Labels: map[string]string{"io.antnest.managed": "skill-preparer"}, ReadOnlyRootFS: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	container, err := client.InspectContainer(ctx, containerName)
	if err != nil {
		t.Fatal(err)
	}
	if container.Running || container.Status != "created" || len(container.Mounts) != 1 || container.Mounts[0].Name != volumeName || !container.Mounts[0].NoCopy {
		t.Fatalf("preparation container or actual mount is wrong: %+v", container)
	}
	var zipped bytes.Buffer
	zipWriter := zip.NewWriter(&zipped)
	member, err := zipWriter.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(member, "---\nname: code-review\ndescription: Verify real archive delivery\n---\n"); err != nil {
		t.Fatal(err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	pkg, err := skillset.InspectArtifact(ctx, zipped.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	var normalized bytes.Buffer
	if err := skillset.WriteNormalizedTar(ctx, zipped.Bytes(), pkg, &normalized); err != nil {
		t.Fatal(err)
	}
	if err := client.PutArchive(ctx, container.ID, "/skills", bytes.NewReader(normalized.Bytes())); err != nil {
		t.Fatal(err)
	}
	readback, err := client.GetArchive(ctx, container.ID, "/skills/code-review")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = readback.Close() }()
	reader := tar.NewReader(readback)
	var found bool
	for {
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(header.Name, "/SKILL.md") {
			content, err := io.ReadAll(reader)
			if err != nil || !strings.Contains(string(content), "name: code-review") || header.Mode != 0444 || header.Uid != 0 || header.Gid != 0 {
				t.Fatalf("readback file mismatch: %+v %v", header, err)
			}
			found = true
		}
	}
	if !found {
		t.Fatal("normalized SKILL.md was not stored as a real file")
	}
	after, err := client.InspectContainer(ctx, container.ID)
	if err != nil || after.Status != "created" || after.Running {
		t.Fatalf("preparer started during archive copy: %+v %v", after, err)
	}
}

func TestPreparedSkillCleanupRemovesOnlyOwnedDockerVolume(t *testing.T) {
	socket := os.Getenv("ANTNEST_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_TEST_DOCKER_SOCKET is not set")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, nil)
	if err != nil {
		t.Fatal(err)
	}
	key := skillset.SetKey{Scope: "cleanup-e2e", OrganizationID: org, AgentID: "agent-" + hex.EncodeToString(random[:]), SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}
	name, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.CreateVolume(ctx, name, skillVolumeLabels(key)); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 10*time.Second)
		defer done()
		_ = client.RemoveVolume(cleanup, name)
	})
	writer, err := NewSkillVolumeWriter(client, "antnest/antnest-runtime:local")
	if err != nil {
		t.Fatal(err)
	}
	prepared := skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: name}
	if err := writer.InspectPreparedVolume(ctx, prepared); err != nil {
		t.Fatalf("owned volume failed lightweight preflight: %v", err)
	}
	prepared.ManifestDigest = digest
	if err := writer.VerifyPreparedCollection(ctx, prepared); !errors.Is(err, ErrConflict) {
		t.Fatalf("labeled empty volume passed full ready verification: %v", err)
	}
	if err := writer.RemovePreparedVolume(ctx, key); err != nil {
		t.Fatal(err)
	}
	if _, err := client.InspectVolume(ctx, name); !errors.Is(err, ErrNotFound) {
		t.Fatalf("owned volume remained after cleanup: %v", err)
	}
	if err := writer.RemovePreparedVolume(ctx, key); err != nil {
		t.Fatalf("cleanup replay: %v", err)
	}
	if err := writer.InspectPreparedVolume(ctx, prepared); !errors.Is(err, ErrSkillVolumeMissing) {
		t.Fatalf("missing volume preflight: %v", err)
	}
}

func TestSkillVolumeWriterMaterializesAndRechecksRealPackage(t *testing.T) {
	socket := os.Getenv("ANTNEST_TEST_DOCKER_SOCKET")
	if socket == "" {
		t.Skip("ANTNEST_TEST_DOCKER_SOCKET is not set")
	}
	client, err := NewUnixClient(socket)
	if err != nil {
		t.Fatal(err)
	}
	writer, err := NewSkillVolumeWriter(client, "antnest/antnest-runtime:local")
	if err != nil {
		t.Fatal(err)
	}
	var zipped bytes.Buffer
	zipWriter := zip.NewWriter(&zipped)
	member, err := zipWriter.Create("SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.WriteString(member, "---\nname: code-review\ndescription: Verify writer\n---\n"); err != nil {
		t.Fatal(err)
	}
	if err := zipWriter.Close(); err != nil {
		t.Fatal(err)
	}
	pkg, err := skillset.InspectArtifact(context.Background(), zipped.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	frozen := skillset.FrozenSkill{SkillID: "skill_11111111111111111111111111111111", Version: 1, Name: pkg.Name, Description: pkg.Description,
		ArtifactDigest: pkg.ArtifactDigest, ContentDigest: pkg.ContentDigest, ArtifactSize: int64(len(zipped.Bytes())), UnpackedSize: int64(pkg.UnpackedSize), PackageRulesVersion: 1}
	org := "org_00000000000000000000000000000000"
	digest, err := skillset.Digest(org, 1, []skillset.FrozenSkill{frozen})
	if err != nil {
		t.Fatal(err)
	}
	var random [8]byte
	if _, err := rand.Read(random[:]); err != nil {
		t.Fatal(err)
	}
	key := skillset.SetKey{Scope: "e2e-" + hex.EncodeToString(random[:]), OrganizationID: org, AgentID: "agent-1", SkillSetDigest: digest, LayoutVersion: 1, Materialization: 1}
	volumeName, err := key.VolumeName()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		if err := client.RemoveVolume(cleanup, volumeName); err != nil {
			t.Errorf("remove writer volume: %v", err)
		}
	})
	if err := writer.MaterializePackage(ctx, key, zipped.Bytes(), pkg); err != nil {
		t.Fatal(err)
	}
	if err := writer.VerifyPackage(ctx, key, pkg); err != nil {
		t.Fatalf("checkpoint readback failed: %v", err)
	}
	job := skillset.PreparationJob{Key: key, Skills: []skillset.FrozenSkill{frozen}, Checkpoints: []skillset.PackageCheckpoint{{
		SkillID: frozen.SkillID, Version: frozen.Version, ContentDigest: frozen.ContentDigest,
		VerifiedBytes: frozen.UnpackedSize, Files: pkg.Files, Directories: pkg.Directories,
	}}}
	manifest, manifestDigest, err := skillset.CollectionManifest(job)
	if err != nil {
		t.Fatal(err)
	}
	if err := writer.WriteManifest(ctx, key, manifest); err != nil {
		t.Fatalf("write and read back collection manifest: %v", err)
	}
	if err := writer.WriteManifest(ctx, key, manifest); err != nil {
		t.Fatalf("retry collection manifest after lost completion receipt: %v", err)
	}
	if err := writer.VerifyPreparedCollection(ctx, skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: volumeName, ManifestDigest: manifestDigest}); err != nil {
		t.Fatalf("complete ready collection failed preflight: %v", err)
	}
	gateName := "antnest-skill-e2e-gate-" + hex.EncodeToString(random[:])
	gateID, err := client.CreateContainer(ctx, ContainerSpec{Name: gateName, Image: "antnest/antnest-runtime:local", User: "0:0", NetworkMode: "none", ReadOnlyRootFS: true,
		Mounts: map[string]Mount{"/skills": {Source: volumeName, ReadOnly: true, NoCopy: true}}, Labels: map[string]string{"io.antnest.managed": "runtime", "io.antnest.runtime-controller-scope": key.Scope, "io.antnest.agent-id": key.AgentID}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		_ = client.RemoveContainer(cleanup, gateID)
	})
	if err := writer.VerifyRuntimeMount(ctx, key, gateID, manifestDigest); err != nil {
		t.Fatalf("prepared Runtime mount gate: %v", err)
	}
	if err := writer.VerifyRuntimeMount(ctx, key, gateID, "sha256:"+strings.Repeat("f", 64)); err == nil {
		t.Fatal("wrong manifest digest passed startup gate")
	}
	volume, err := client.InspectVolume(ctx, volumeName)
	if err != nil || volume.Labels["io.antnest.skill-set-digest"] != digest {
		t.Fatalf("owned volume identity: %+v %v", volume, err)
	}
	if err := client.RemoveContainer(ctx, gateID); err != nil {
		t.Fatal(err)
	}
	tamperName := "antnest-skill-e2e-tamper-" + hex.EncodeToString(random[:])
	tamperID, err := client.CreateContainer(ctx, ContainerSpec{Name: tamperName, Image: "antnest/antnest-runtime:local", User: "0:0", NetworkMode: "none", ReadOnlyRootFS: true,
		Mounts: map[string]Mount{"/skills": {Source: volumeName, NoCopy: true}}, Labels: map[string]string{"io.antnest.e2e": "skill-content-drift"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		_ = client.RemoveContainer(cleanup, tamperID)
	})
	var changed bytes.Buffer
	archive := tar.NewWriter(&changed)
	for _, file := range pkg.Files {
		if file.Path != "SKILL.md" {
			continue
		}
		if err := archive.WriteHeader(&tar.Header{Name: "SKILL.md", Typeflag: tar.TypeReg, Mode: 0444, Size: int64(file.Size)}); err != nil {
			t.Fatal(err)
		}
		if _, err := archive.Write(bytes.Repeat([]byte("x"), int(file.Size))); err != nil {
			t.Fatal(err)
		}
	}
	if err := archive.Close(); err != nil {
		t.Fatal(err)
	}
	if err := client.PutArchive(ctx, tamperID, "/skills/code-review", bytes.NewReader(changed.Bytes())); err != nil {
		t.Fatal(err)
	}
	if err := client.RemoveContainer(ctx, tamperID); err != nil {
		t.Fatal(err)
	}
	if err := writer.VerifyPreparedCollection(ctx, skillset.PreparedMaterialization{SetID: 1, Key: key, VolumeName: volumeName, ManifestDigest: manifestDigest}); !errors.Is(err, ErrConflict) {
		t.Fatalf("modified ready Skill body passed preflight: %v", err)
	}
	if err := client.RemoveVolume(ctx, volumeName); err != nil {
		t.Fatal(err)
	}
	// Docker silently creates an unlabeled empty named volume if the original
	// disappears between preflight and container creation.
	replacementID, err := client.CreateContainer(ctx, ContainerSpec{Name: gateName, Image: "antnest/antnest-runtime:local", User: "0:0", NetworkMode: "none", ReadOnlyRootFS: true,
		Mounts: map[string]Mount{"/skills": {Source: volumeName, ReadOnly: true, NoCopy: true}}, Labels: map[string]string{"io.antnest.managed": "runtime", "io.antnest.runtime-controller-scope": key.Scope, "io.antnest.agent-id": key.AgentID}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanup, done := context.WithTimeout(context.Background(), 15*time.Second)
		defer done()
		_ = client.RemoveContainer(cleanup, replacementID)
	})
	if err := writer.VerifyRuntimeMount(ctx, key, replacementID, manifestDigest); err == nil {
		t.Fatal("Docker auto-created empty volume passed startup gate")
	}
}
