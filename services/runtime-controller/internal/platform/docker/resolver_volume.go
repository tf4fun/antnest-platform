package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

const resolverMountPath = "/etc/resolv.conf"

var errResolverUnprepared = errors.New("resolver file is not initialized")

type ResolverVolumeWriter struct {
	engine SkillVolumeEngine
	image  string
	scope  string
}

func NewResolverVolumeWriter(engine SkillVolumeEngine, image string, scope string) (*ResolverVolumeWriter, error) {
	if engine == nil || image == "" || strings.TrimSpace(scope) == "" {
		return nil, fmt.Errorf("resolver volume engine, image and scope are required")
	}
	return &ResolverVolumeWriter{engine: engine, image: image, scope: scope}, nil
}

func resolverDocument(resolverIPv4 string) (string, error) {
	resolver, err := netip.ParseAddr(strings.TrimSpace(resolverIPv4))
	if err != nil || !resolver.Is4() {
		return "", fmt.Errorf("resolver IPv4 is invalid")
	}
	return "options use-vc\nnameserver " + resolver.String() + "\n", nil
}

func resolverVolumeLabels(scope string, key deployment.Key, document string) map[string]string {
	return map[string]string{
		labelManaged: "runtime-resolver", labelScope: scope, labelAgentID: key.AgentID,
		labelGeneration:                      strconv.FormatUint(key.Generation, 10),
		"io.antnest.resolver-content-digest": instanceauth.Digest([]byte(document)),
	}
}

func hasResolverMount(container Container, name string, readOnly bool) bool {
	count := 0
	for _, mount := range container.Mounts {
		if mount.Destination == resolverMountPath {
			if mount.Type != "volume" || mount.Name != name || mount.ReadWrite == readOnly ||
				!mount.NoCopy || mount.Subpath != "resolv.conf" {
				return false
			}
			count++
		}
	}
	return count == 1
}

func (w *ResolverVolumeWriter) Prepare(ctx context.Context, key deployment.Key, resolverIPv4 string) (resultErr error) {
	document, err := resolverDocument(resolverIPv4)
	if err != nil {
		return err
	}
	runtime, err := w.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), containerName(key.AgentID))
	if err == nil && runtime.Running {
		return w.VerifyRuntimeMount(ctx, key, resolverIPv4, runtime.ID)
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	name := resolverVolumeName(w.scope, key.AgentID, key.Generation)
	labels := resolverVolumeLabels(w.scope, key, document)
	volume, err := w.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		createErr := w.engine.CreateVolume(ctx, name, labels)
		volume, err = w.engine.InspectVolume(ctx, name)
		if err != nil {
			return errors.Join(createErr, err)
		}
	}
	if err != nil {
		return err
	}
	if volume.Name != name || !matchLabels(volume.Labels, labels) {
		return fmt.Errorf("%w: resolver volume ownership differs", ErrConflict)
	}
	helperName := "antnest-resolver-preparer-" + strings.TrimPrefix(name, "antnest-runtime-resolver-")
	helperLabels := resolverVolumeLabels(w.scope, key, document)
	helperLabels[labelManaged] = "runtime-resolver-preparer"
	helper, err := w.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), helperName)
	if err == nil {
		if helper.Running || helper.Status != "created" || helper.Name != helperName || !matchLabels(helper.Labels, helperLabels) || !hasResolverHelperMount(helper, name) {
			return fmt.Errorf("%w: resolver helper differs", ErrConflict)
		}
		if err := w.engine.RemoveContainer(ctx, helper.ID); err != nil {
			return err
		}
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	helperID, err := w.engine.CreateContainer(ctx, ContainerSpec{
		Name: helperName, Image: w.image, User: "0:0", NetworkMode: "none",
		Mounts:        map[string]Mount{"/run/antnest-resolver": {Source: name, NoCopy: true}},
		Labels:        helperLabels,
		RestartPolicy: "no", PidsLimit: 32, MemoryBytes: 64 << 20,
	})
	if err != nil {
		return err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resultErr = errors.Join(resultErr, w.engine.RemoveContainer(cleanup, helperID))
	}()
	helper, err = w.engine.InspectContainer(ctx, helperID)
	if err != nil {
		return err
	}
	if helper.Running || helper.Status != "created" || helper.Name != helperName || !matchLabels(helper.Labels, helperLabels) || !hasResolverHelperMount(helper, name) {
		return fmt.Errorf("%w: actual resolver helper differs", ErrConflict)
	}
	volume, err = w.engine.InspectVolume(ctx, name)
	if err != nil || !matchLabels(volume.Labels, labels) {
		return fmt.Errorf("%w: resolver volume changed after helper creation", ErrConflict)
	}
	if err := w.verifyResolver(ctx, helperID, document); err == nil {
		return nil
	} else if !errors.Is(err, errResolverUnprepared) {
		return err
	}
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	if err := tw.WriteHeader(&tar.Header{Name: "antnest-resolver", Typeflag: tar.TypeDir, Mode: 0755, Uid: 0, Gid: 0}); err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "antnest-resolver/resolv.conf", Typeflag: tar.TypeReg, Mode: 0444, Uid: 0, Gid: 0, Size: int64(len(document))}); err != nil {
		return err
	}
	if _, err := tw.Write([]byte(document)); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := w.engine.PutArchive(ctx, helperID, "/run", &archive); err != nil {
		return err
	}
	return w.verifyResolver(ctx, helperID, document)
}

func hasResolverHelperMount(container Container, name string) bool {
	count := 0
	for _, mount := range container.Mounts {
		if mount.Destination == "/run/antnest-resolver" {
			if mount.Type != "volume" || mount.Name != name || !mount.ReadWrite || !mount.NoCopy {
				return false
			}
			count++
		}
	}
	return count == 1
}

func (w *ResolverVolumeWriter) verifyResolver(ctx context.Context, containerID, document string) (resultErr error) {
	stream, err := w.engine.GetArchive(ctx, containerID, "/run/antnest-resolver")
	if errors.Is(err, ErrNotFound) {
		return errResolverUnprepared
	}
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
	reader := tar.NewReader(stream)
	root, err := reader.Next()
	if err != nil {
		return fmt.Errorf("%w: resolver archive is invalid", ErrConflict)
	}
	rootName := strings.TrimSuffix(strings.TrimPrefix(root.Name, "./"), "/")
	if rootName != "antnest-resolver" || root.Typeflag != tar.TypeDir || root.Mode&07777 != 0755 ||
		root.Uid != 0 || root.Gid != 0 {
		return fmt.Errorf("%w: resolver directory identity differs", ErrConflict)
	}
	seen := false
	for {
		file, err := reader.Next()
		if err == io.EOF {
			if !seen {
				return errResolverUnprepared
			}
			break
		}
		if err != nil {
			return fmt.Errorf("%w: resolver archive invalid", ErrConflict)
		}
		name := strings.TrimPrefix(file.Name, "antnest-resolver/")
		if name != "resolv.conf" || file.Typeflag != tar.TypeReg || file.Mode&07777 != 0444 ||
			file.Uid != 0 || file.Gid != 0 || file.Size != int64(len(document)) {
			return fmt.Errorf("%w: resolver file identity differs", ErrConflict)
		}
		data, err := io.ReadAll(io.LimitReader(reader, int64(len(document))+1))
		if err != nil || string(data) != document {
			return fmt.Errorf("%w: resolver content differs", ErrConflict)
		}
		seen = true
	}
	return nil
}

func (w *ResolverVolumeWriter) VerifyRuntimeMount(ctx context.Context, key deployment.Key, resolverIPv4, containerID string) error {
	document, err := resolverDocument(resolverIPv4)
	if err != nil {
		return err
	}
	if key.Validate() != nil {
		return fmt.Errorf("%w: resolver identity is invalid", ErrConflict)
	}
	name := resolverVolumeName(w.scope, key.AgentID, key.Generation)
	labels := resolverVolumeLabels(w.scope, key, document)
	volume, err := w.engine.InspectVolume(ctx, name)
	if err != nil {
		return err
	}
	if volume.Name != name || !matchLabels(volume.Labels, labels) {
		return fmt.Errorf("%w: resolver volume ownership differs", ErrConflict)
	}
	container, err := w.engine.InspectContainer(ctx, containerID)
	if err != nil {
		return err
	}
	if container.ID != containerID || container.Name != containerName(key.AgentID) ||
		container.Labels[labelManaged] != "runtime" || container.Labels[labelScope] != w.scope ||
		container.Labels[labelAgentID] != key.AgentID ||
		container.Labels[labelGeneration] != strconv.FormatUint(key.Generation, 10) ||
		!hasResolverMount(container, name, true) {
		return fmt.Errorf("%w: actual resolver mount differs", ErrConflict)
	}
	volume, err = w.engine.InspectVolume(ctx, name)
	if err != nil || !matchLabels(volume.Labels, labels) {
		return fmt.Errorf("%w: resolver volume changed after mount verification", ErrConflict)
	}
	return w.verifyResolverFile(ctx, containerID, document)
}

func (w *ResolverVolumeWriter) verifyResolverFile(ctx context.Context, containerID, document string) (resultErr error) {
	stream, err := w.engine.GetArchive(ctx, containerID, resolverMountPath)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
	reader := tar.NewReader(stream)
	file, err := reader.Next()
	if err != nil {
		return fmt.Errorf("%w: resolver file archive is invalid", ErrConflict)
	}
	name := strings.TrimSuffix(strings.TrimPrefix(file.Name, "./"), "/")
	if name != "resolv.conf" || file.Typeflag != tar.TypeReg || file.Mode&07777 != 0444 ||
		file.Uid != 0 || file.Gid != 0 || file.Size != int64(len(document)) {
		return fmt.Errorf("%w: resolver file identity differs", ErrConflict)
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(len(document))+1))
	if err != nil || string(data) != document {
		return fmt.Errorf("%w: resolver file content differs", ErrConflict)
	}
	if _, err := reader.Next(); err != io.EOF {
		return fmt.Errorf("%w: resolver file archive has extra entries", ErrConflict)
	}
	return nil
}

func (w *ResolverVolumeWriter) Remove(ctx context.Context, key deployment.Key) error {
	if key.Validate() != nil {
		return fmt.Errorf("%w: resolver identity is invalid", ErrConflict)
	}
	_, err := w.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), containerName(key.AgentID))
	if err == nil {
		return fmt.Errorf("%w: resolver volume is still mounted by compute", ErrConflict)
	}
	if !errors.Is(err, ErrNotFound) {
		return err
	}
	name := resolverVolumeName(w.scope, key.AgentID, key.Generation)
	volume, err := w.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if volume.Name != name || volume.Labels[labelManaged] != "runtime-resolver" ||
		volume.Labels[labelScope] != w.scope || volume.Labels[labelAgentID] != key.AgentID ||
		volume.Labels[labelGeneration] != strconv.FormatUint(key.Generation, 10) {
		return fmt.Errorf("%w: resolver volume ownership differs", ErrConflict)
	}
	if err := w.engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}
