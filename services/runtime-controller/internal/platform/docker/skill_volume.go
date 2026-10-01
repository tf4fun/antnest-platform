package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/skillset"
	"soft/antnest-platform/services/runtime-controller/internal/telemetry"
)

const (
	labelSkillOrganization    = "io.antnest.skill-organization-id"
	labelSkillSetDigest       = "io.antnest.skill-set-digest"
	labelSkillLayout          = "io.antnest.skill-layout-version"
	labelSkillMaterialization = "io.antnest.skill-materialization"
)

var ErrSkillVolumeMissing = errors.New("owned Skill volume is missing")
var ErrSkillMountVerificationFailed = errors.New("prepared Skill mount verification failed")
var ErrSkillCollectionDrift = fmt.Errorf("%w: ready Skill collection content differs", ErrConflict)

// VerifyRuntimeMount checks the actual mount after Docker creates a candidate
// Runtime and before it is allowed to start, and rechecks an adopted running
// Runtime before reporting recovery success. Docker may auto-create a missing
// named volume between a preflight check and container creation; this gate
// rejects that unlabeled empty replacement without treating its name as proof.
func (w *SkillVolumeWriter) VerifyRuntimeMount(ctx context.Context, key skillset.SetKey, containerID, manifestDigest string) (resultErr error) {
	name, err := key.VolumeName()
	if err != nil || len(manifestDigest) != 71 || !strings.HasPrefix(manifestDigest, "sha256:") {
		return fmt.Errorf("%w: invalid expected identity", ErrSkillMountVerificationFailed)
	}
	container, err := w.engine.InspectContainer(ctx, containerID)
	if err != nil {
		return fmt.Errorf("%w: inspect candidate Runtime: %v", ErrSkillMountVerificationFailed, err)
	}
	validStatus := container.Status == "created" && !container.Running || container.Status == "running" && container.Running
	if !validStatus || container.Labels[labelManaged] != "runtime" || container.Labels[labelScope] != key.Scope || container.Labels[labelAgentID] != key.AgentID || !hasSkillMount(container, name, true) {
		return fmt.Errorf("%w: actual Runtime mount differs", ErrSkillMountVerificationFailed)
	}
	volume, err := w.engine.InspectVolume(ctx, name)
	if err != nil || volume.Name != name || !matchLabels(volume.Labels, skillVolumeLabels(key)) {
		return fmt.Errorf("%w: actual volume ownership differs: %v", ErrSkillMountVerificationFailed, err)
	}
	stream, err := w.engine.GetArchive(ctx, containerID, "/skills/.antnest-skills.json")
	if err != nil {
		return fmt.Errorf("%w: manifest is absent: %v", ErrSkillMountVerificationFailed, err)
	}
	defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
	reader := tar.NewReader(stream)
	header, err := reader.Next()
	if err != nil || header.Typeflag != tar.TypeReg && header.Typeflag != oldTarRegularType || strings.TrimPrefix(header.Name, "./") != ".antnest-skills.json" ||
		header.Size < 1 || header.Size > 8<<20 || header.Mode&07777 != 0444 || header.Uid != 0 || header.Gid != 0 {
		return fmt.Errorf("%w: manifest file identity differs: %v", ErrSkillMountVerificationFailed, err)
	}
	manifest := make([]byte, int(header.Size))
	if _, err := io.ReadFull(reader, manifest); err != nil {
		return fmt.Errorf("%w: read manifest: %v", ErrSkillMountVerificationFailed, err)
	}
	if _, err := reader.Next(); err != io.EOF {
		return fmt.Errorf("%w: unexpected manifest archive entry: %v", ErrSkillMountVerificationFailed, err)
	}
	hash := sha256.Sum256(manifest)
	if "sha256:"+hex.EncodeToString(hash[:]) != manifestDigest {
		return fmt.Errorf("%w: manifest digest differs", ErrSkillMountVerificationFailed)
	}
	var identity struct {
		LayoutVersion  uint32 `json:"layout_version"`
		OrganizationID string `json:"organization_id"`
		AgentID        string `json:"agent_id"`
		SkillSetDigest string `json:"skill_set_digest"`
	}
	if err := json.Unmarshal(manifest, &identity); err != nil || identity.LayoutVersion != key.LayoutVersion || identity.OrganizationID != key.OrganizationID || identity.AgentID != key.AgentID || identity.SkillSetDigest != key.SkillSetDigest {
		return fmt.Errorf("%w: manifest collection identity differs: %v", ErrSkillMountVerificationFailed, err)
	}
	return nil
}

type SkillVolumeEngine interface {
	InspectVolume(context.Context, string) (Volume, error)
	CreateVolume(context.Context, string, map[string]string) error
	RemoveVolume(context.Context, string) error
	InspectContainer(context.Context, string) (Container, error)
	CreateContainer(context.Context, ContainerSpec) (string, error)
	RemoveContainer(context.Context, string) error
	PutArchive(context.Context, string, string, io.Reader) error
	GetArchive(context.Context, string, string) (io.ReadCloser, error)
}

// RemovePreparedVolume removes only an RC-owned materialization. Docker refuses
// a volume still mounted by a container, which is an additional protection if
// the database and physical state temporarily disagree.
func (w *SkillVolumeWriter) RemovePreparedVolume(ctx context.Context, key skillset.SetKey) error {
	name, err := key.VolumeName()
	if err != nil {
		return err
	}
	volume, err := w.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if volume.Name != name || !matchLabels(volume.Labels, skillVolumeLabels(key)) {
		return fmt.Errorf("%w: Skill volume ownership differs", ErrConflict)
	}
	if err := w.engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}

func (w *SkillVolumeWriter) InspectPreparedVolume(ctx context.Context, prepared skillset.PreparedMaterialization) error {
	name, err := w.ensureVolume(ctx, prepared.Key, false)
	if err != nil {
		return err
	}
	if name != prepared.VolumeName {
		return fmt.Errorf("%w: prepared Skill volume identity differs", ErrConflict)
	}
	return nil
}

// VerifyPreparedCollection performs the bounded full readback only at the
// independent Prepare boundary, never inside a lifecycle mutation deadline.
func (w *SkillVolumeWriter) VerifyPreparedCollection(ctx context.Context, prepared skillset.PreparedMaterialization) error {
	if err := w.InspectPreparedVolume(ctx, prepared); err != nil {
		return err
	}
	if len(prepared.ManifestDigest) != 71 || !strings.HasPrefix(prepared.ManifestDigest, "sha256:") {
		return fmt.Errorf("%w: prepared Skill manifest digest is invalid", ErrConflict)
	}
	return w.withPreparer(ctx, prepared.Key, false, func(containerID string) (resultErr error) {
		stream, err := w.engine.GetArchive(ctx, containerID, "/skills/.antnest-skills.json")
		if errors.Is(err, ErrNotFound) {
			return fmt.Errorf("%w: prepared Skill manifest is missing", ErrSkillCollectionDrift)
		}
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
		reader := tar.NewReader(stream)
		header, err := reader.Next()
		if err != nil || header.Typeflag != tar.TypeReg && header.Typeflag != oldTarRegularType ||
			strings.TrimPrefix(header.Name, "./") != ".antnest-skills.json" ||
			header.Size < 1 || header.Size > 8<<20 || header.Mode&07777 != 0444 || header.Uid != 0 || header.Gid != 0 {
			return fmt.Errorf("%w: prepared Skill manifest identity differs: %v", ErrSkillCollectionDrift, err)
		}
		manifest := make([]byte, int(header.Size))
		if _, err := io.ReadFull(reader, manifest); err != nil {
			return fmt.Errorf("%w: read prepared Skill manifest: %v", ErrSkillCollectionDrift, err)
		}
		if _, err := reader.Next(); err != io.EOF {
			return fmt.Errorf("%w: prepared Skill manifest archive has extra entries: %v", ErrSkillCollectionDrift, err)
		}
		hash := sha256.Sum256(manifest)
		if "sha256:"+hex.EncodeToString(hash[:]) != prepared.ManifestDigest {
			return fmt.Errorf("%w: prepared Skill manifest digest differs", ErrSkillCollectionDrift)
		}
		collection, err := w.engine.GetArchive(ctx, containerID, "/skills")
		if errors.Is(err, ErrNotFound) {
			return fmt.Errorf("%w: prepared Skill collection is missing", ErrSkillCollectionDrift)
		}
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, collection.Close()) }()
		if err := verifyCollectionArchive(ctx, collection, prepared.Key, manifest); err != nil {
			return fmt.Errorf("%w: prepared Skill collection differs: %v", ErrSkillCollectionDrift, err)
		}
		return nil
	})
}

type SkillVolumeWriter struct {
	engine SkillVolumeEngine
	image  string
}

func NewSkillVolumeWriter(engine SkillVolumeEngine, image string) (*SkillVolumeWriter, error) {
	if engine == nil || strings.TrimSpace(image) == "" {
		return nil, fmt.Errorf("skill volume engine and preparation image are required")
	}
	return &SkillVolumeWriter{engine: engine, image: image}, nil
}

func (w *SkillVolumeWriter) MaterializePackage(ctx context.Context, key skillset.SetKey, artifact []byte, pkg skillset.Package) error {
	// Build the complete bounded tar outside Docker. A failed validation never
	// leaves a partial, unverified package in the candidate volume.
	archive, err := os.CreateTemp("", "antnest-skill-package-*.tar")
	if err != nil {
		return err
	}
	defer func() { _ = archive.Close(); _ = os.Remove(archive.Name()) }()
	if err := skillset.WriteNormalizedTar(ctx, artifact, pkg, archive); err != nil {
		return err
	}
	if _, err := archive.Seek(0, io.SeekStart); err != nil {
		return err
	}
	return w.withPreparer(ctx, key, true, func(containerID string) error {
		if err := w.engine.PutArchive(ctx, containerID, "/skills", archive); err != nil {
			return fmt.Errorf("write Skill package archive: %w", err)
		}
		return w.verifyPackage(ctx, containerID, pkg)
	})
}

func (w *SkillVolumeWriter) VerifyPackage(ctx context.Context, key skillset.SetKey, pkg skillset.Package) error {
	return w.withPreparer(ctx, key, false, func(containerID string) error { return w.verifyPackage(ctx, containerID, pkg) })
}

// WriteManifest makes the set ready for consumption only after the exact
// collection identity has been written and read back from the owned volume.
func (w *SkillVolumeWriter) WriteManifest(ctx context.Context, key skillset.SetKey, manifest []byte) error {
	if len(manifest) == 0 || len(manifest) > 8<<20 {
		return fmt.Errorf("invalid Skill collection manifest size")
	}
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	if err := tw.WriteHeader(&tar.Header{Name: ".antnest-skills.json", Mode: 0444, Size: int64(len(manifest)), Typeflag: tar.TypeReg, Uid: 0, Gid: 0}); err != nil {
		return err
	}
	if _, err := tw.Write(manifest); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	return w.withPreparer(ctx, key, true, func(containerID string) (resultErr error) {
		if err := w.engine.PutArchive(ctx, containerID, "/skills", bytes.NewReader(archive.Bytes())); err != nil {
			return fmt.Errorf("write Skill collection manifest: %w", err)
		}
		stream, err := w.engine.GetArchive(ctx, containerID, "/skills/.antnest-skills.json")
		if err != nil {
			return err
		}
		defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
		reader := tar.NewReader(stream)
		header, err := reader.Next()
		if err != nil || header.Typeflag != tar.TypeReg && header.Typeflag != oldTarRegularType ||
			strings.TrimPrefix(header.Name, "./") != ".antnest-skills.json" ||
			header.Size != int64(len(manifest)) || header.Mode&07777 != 0444 || header.Uid != 0 || header.Gid != 0 {
			return fmt.Errorf("skill collection manifest readback identity differs: %v", err)
		}
		actual := make([]byte, len(manifest))
		if _, err := io.ReadFull(reader, actual); err != nil || !bytes.Equal(actual, manifest) {
			return fmt.Errorf("skill collection manifest readback bytes differ: %v", err)
		}
		if _, err := reader.Next(); err != io.EOF {
			return fmt.Errorf("skill collection manifest readback has unexpected entries: %v", err)
		}
		return w.verifyCollection(ctx, containerID, key, manifest)
	})
}

func skillVolumeLabels(key skillset.SetKey) map[string]string {
	return map[string]string{labelManaged: "skill-set", labelScope: key.Scope, labelAgentID: key.AgentID,
		labelSkillOrganization: key.OrganizationID, labelSkillSetDigest: key.SkillSetDigest,
		labelSkillLayout: fmt.Sprint(key.LayoutVersion), labelSkillMaterialization: fmt.Sprint(key.Materialization)}
}

func matchLabels(actual, want map[string]string) bool {
	for key, value := range want {
		if actual[key] != value {
			return false
		}
	}
	return true
}

func (w *SkillVolumeWriter) ensureVolume(ctx context.Context, key skillset.SetKey, create bool) (string, error) {
	name, err := key.VolumeName()
	if err != nil {
		return "", err
	}
	labels := skillVolumeLabels(key)
	volume, err := w.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		if !create {
			return "", ErrSkillVolumeMissing
		}
		createErr := w.engine.CreateVolume(ctx, name, labels)
		volume, err = w.engine.InspectVolume(ctx, name)
		if err != nil {
			return "", errors.Join(createErr, err)
		}
	}
	if err != nil {
		return "", err
	}
	if volume.Name != name || !matchLabels(volume.Labels, labels) {
		return "", fmt.Errorf("%w: Skill volume ownership differs", ErrConflict)
	}
	return name, nil
}

func preparerName(volumeName string) string {
	return "antnest-skill-preparer-" + strings.TrimPrefix(volumeName, "antnest-skills-")
}

func (w *SkillVolumeWriter) withPreparer(ctx context.Context, key skillset.SetKey, create bool, act func(string) error) (resultErr error) {
	volumeName, err := w.ensureVolume(ctx, key, create)
	if err != nil {
		return err
	}
	name := preparerName(volumeName)
	labels := skillVolumeLabels(key)
	labels[labelManaged] = "skill-preparer"
	// A prior worker can leave an unstarted helper after crashing. A new
	// holder removes only a proven owned helper before writing this volume.
	existing, err := w.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), name)
	if err == nil {
		if existing.Running || existing.Status != "created" || !matchLabels(existing.Labels, labels) ||
			!hasSkillMount(existing, volumeName, false) {
			return fmt.Errorf("%w: Skill preparer identity differs", ErrConflict)
		}
		if err := w.engine.RemoveContainer(ctx, existing.ID); err != nil {
			return err
		}
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	containerID, err := w.engine.CreateContainer(ctx, ContainerSpec{
		Name: name, Image: w.image, User: "0:0", NetworkMode: "none", ReadOnlyRootFS: true,
		Mounts: map[string]Mount{"/skills": {Source: volumeName, NoCopy: true}}, Labels: labels,
		RestartPolicy: "no", PidsLimit: 64, MemoryBytes: 128 << 20,
	})
	if err != nil {
		return err
	}
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resultErr = errors.Join(resultErr, w.engine.RemoveContainer(cleanupCtx, containerID))
	}()
	container, err := w.engine.InspectContainer(ctx, containerID)
	if err != nil {
		return err
	}
	if container.Running || container.Status != "created" || !matchLabels(container.Labels, labels) ||
		!hasSkillMount(container, volumeName, false) {
		return fmt.Errorf("%w: actual Skill preparation mount differs", ErrConflict)
	}
	volume, err := w.engine.InspectVolume(ctx, volumeName)
	if err != nil {
		return err
	}
	if volume.Name != volumeName || !matchLabels(volume.Labels, skillVolumeLabels(key)) {
		return fmt.Errorf("%w: actual Skill volume ownership differs after container creation", ErrConflict)
	}
	return act(containerID)
}

func hasSkillMount(container Container, volumeName string, readOnly bool) bool {
	for _, mount := range container.Mounts {
		if mount.Destination == "/skills" {
			return mount.Type == "volume" && mount.Name == volumeName && mount.ReadWrite != readOnly && mount.NoCopy
		}
	}
	return false
}

func (w *SkillVolumeWriter) verifyPackage(ctx context.Context, containerID string, pkg skillset.Package) (resultErr error) {
	stream, err := w.engine.GetArchive(ctx, containerID, "/skills/"+pkg.Name)
	if err != nil {
		return fmt.Errorf("read back Skill package: %w", err)
	}
	defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
	expectedFiles := make(map[string]skillset.PackageFile, len(pkg.Files))
	expectedDirs := map[string]bool{pkg.Name: true}
	for _, file := range pkg.Files {
		expectedFiles[pkg.Name+"/"+file.Path] = file
		for parent := path.Dir(file.Path); parent != "."; parent = path.Dir(parent) {
			expectedDirs[pkg.Name+"/"+parent] = true
		}
	}
	for _, directory := range pkg.Directories {
		expectedDirs[pkg.Name+"/"+directory] = true
		for parent := path.Dir(directory); parent != "."; parent = path.Dir(parent) {
			expectedDirs[pkg.Name+"/"+parent] = true
		}
	}
	seenFiles := map[string]bool{}
	seenDirs := map[string]bool{}
	reader := tar.NewReader(stream)
	for entries := 0; ; entries++ {
		if entries > 5000 {
			return fmt.Errorf("skill readback has too many entries")
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		header, err := reader.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(strings.TrimPrefix(header.Name, "./"), "/")
		if name == "" || path.Clean(name) != name || strings.HasPrefix(name, "/") ||
			strings.HasPrefix(name, "../") || header.Uid != 0 || header.Gid != 0 {
			return fmt.Errorf("skill readback contains unsafe identity")
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if !expectedDirs[name] || seenDirs[name] || header.Mode&07777 != 0555 {
				return fmt.Errorf("skill readback directory differs")
			}
			seenDirs[name] = true
		case tar.TypeReg, oldTarRegularType:
			file, ok := expectedFiles[name]
			mode := int64(0444)
			if file.Executable {
				mode = 0555
			}
			if !ok || seenFiles[name] || header.Mode&07777 != mode || header.Size != int64(file.Size) {
				return fmt.Errorf("skill readback file identity differs")
			}
			hash := sha256.New()
			actual, err := io.CopyN(hash, reader, int64(file.Size))
			if err != nil || uint64(actual) != file.Size || "sha256:"+hex.EncodeToString(hash.Sum(nil)) != file.Digest {
				return fmt.Errorf("skill readback file bytes differ")
			}
			seenFiles[name] = true
		default:
			return fmt.Errorf("skill readback contains nonregular entry")
		}
	}
	if len(seenFiles) != len(expectedFiles) || len(seenDirs) != len(expectedDirs) {
		return fmt.Errorf("skill readback is incomplete")
	}
	return nil
}
