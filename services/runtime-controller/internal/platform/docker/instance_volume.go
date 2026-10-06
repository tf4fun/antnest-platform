package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

var errInstanceUnprepared = errors.New("instance receiver has not been prepared")

type InstanceMountGate interface {
	Prepare(context.Context, deployment.Key, *instanceauth.Record) error
	VerifyRuntimeMount(context.Context, deployment.Key, *deployment.RuntimeAuthentication, string) error
	Remove(context.Context, deployment.Key) error
}

type InstanceVolumeWriter struct {
	engine SkillVolumeEngine
	image  string
	issuer *instanceauth.Manager
	scope  string
}

func NewInstanceVolumeWriter(engine SkillVolumeEngine, image string, issuer *instanceauth.Manager, scope string) (*InstanceVolumeWriter, error) {
	if engine == nil || image == "" || issuer == nil || (instanceauth.Identity{Scope: scope, AgentID: "validation", Generation: 1}).Validate() != nil {
		return nil, fmt.Errorf("instance volume engine, image, issuer and scope are required")
	}
	return &InstanceVolumeWriter{engine: engine, image: image, issuer: issuer, scope: scope}, nil
}

func instanceVolumeName(id instanceauth.Identity) string {
	// Scope is part of the private volume identity; it is not a Docker path.
	digest := instanceauth.Digest([]byte(strconv.Itoa(len(id.Scope)) + ":" + id.Scope + "\x00" + id.AgentID + "\x00" + strconv.FormatUint(id.Generation, 10)))
	return "antnest-runtime-auth-" + digest[7:39]
}

func instanceVolumeLabels(id instanceauth.Identity, descriptor *deployment.RuntimeAuthentication) map[string]string {
	return map[string]string{labelManaged: "runtime-auth", labelScope: id.Scope, labelAgentID: id.AgentID, labelGeneration: strconv.FormatUint(id.Generation, 10), "io.antnest.runtime-connection-id": descriptor.ConnectionID, "io.antnest.runtime-caller-digest": descriptor.ReceiverDigest, "io.antnest.tunnel-key-id": descriptor.Tunnel.KeyID, "io.antnest.tunnel-keys-digest": descriptor.Tunnel.KeysDigest}
}

func (w *InstanceVolumeWriter) identity(key deployment.Key) instanceauth.Identity {
	return instanceauth.Identity{Scope: w.scope, AgentID: key.AgentID, Generation: key.Generation}
}

func hasInstanceMount(container Container, name string, readOnly bool) bool {
	count := 0
	for _, mount := range container.Mounts {
		if mount.Destination == instanceauth.Directory {
			if mount.Type != "volume" || mount.Name != name || mount.ReadWrite == readOnly || !mount.NoCopy {
				return false
			}
			count++
		}
	}
	return count == 1
}

func (w *InstanceVolumeWriter) Prepare(ctx context.Context, key deployment.Key, record *instanceauth.Record) (resultErr error) {
	id := w.identity(key)
	profile, err := w.issuer.Receiver(id, record)
	if err != nil {
		return err
	}
	tunnel, err := w.issuer.TunnelFile(id, record)
	if err != nil {
		return err
	}
	defer clear(tunnel)
	descriptor := &deployment.RuntimeAuthentication{ConnectionID: record.ConnectionID, CallersFile: instanceauth.CallersFile, ReceiverDigest: record.ReceiverDigest, Tunnel: record.Tunnel.Descriptor()}
	// Never write a live receiver. Exact running recovery is read-only.
	runtime, err := w.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), containerName(key.AgentID))
	if err == nil && runtime.Running {
		return w.VerifyRuntimeMount(ctx, key, descriptor, runtime.ID)
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	name := instanceVolumeName(id)
	labels := instanceVolumeLabels(id, descriptor)
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
		return fmt.Errorf("%w: instance receiver volume ownership differs", ErrConflict)
	}
	helperName := "antnest-auth-preparer-" + strings.TrimPrefix(name, "antnest-runtime-auth-")
	helperLabels := instanceVolumeLabels(id, descriptor)
	helperLabels[labelManaged] = "runtime-auth-preparer"
	helper, err := w.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), helperName)
	if err == nil {
		if helper.Running || helper.Status != "created" || helper.Name != helperName || !matchLabels(helper.Labels, helperLabels) || !hasInstanceMount(helper, name, false) {
			return fmt.Errorf("%w: instance receiver helper differs", ErrConflict)
		}
		if err := w.engine.RemoveContainer(ctx, helper.ID); err != nil {
			return err
		}
	} else if !errors.Is(err, ErrNotFound) {
		return err
	}
	helperID, err := w.engine.CreateContainer(ctx, ContainerSpec{Name: helperName, Image: w.image, User: "0:0", NetworkMode: "none", Mounts: map[string]Mount{instanceauth.Directory: {Source: name, NoCopy: true}}, Labels: helperLabels, RestartPolicy: "no", PidsLimit: 32, MemoryBytes: 64 << 20})
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
	if helper.Running || helper.Status != "created" || helper.Name != helperName || !matchLabels(helper.Labels, helperLabels) || !hasInstanceMount(helper, name, false) {
		return fmt.Errorf("%w: actual instance receiver helper differs", ErrConflict)
	}
	volume, err = w.engine.InspectVolume(ctx, name)
	if err != nil || !matchLabels(volume.Labels, labels) {
		return fmt.Errorf("%w: instance receiver volume changed after helper creation", ErrConflict)
	}
	if err := w.verifyProfile(ctx, helperID, descriptor); err == nil {
		return nil
	} else if !errors.Is(err, errInstanceUnprepared) {
		return err
	}
	var archive bytes.Buffer
	defer func() { clear(archive.Bytes()) }()
	tw := tar.NewWriter(&archive)
	// Docker skips metadata for an archive's '.' entry. Extract from the
	// parent so the named mount directory itself receives mode 0700. The
	// network-none helper is never started; only its parent rootfs is writable.
	if err := tw.WriteHeader(&tar.Header{Name: "antnest-auth", Typeflag: tar.TypeDir, Mode: 0700, Uid: 0, Gid: 0}); err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "antnest-auth/callers.json", Typeflag: tar.TypeReg, Mode: 0600, Uid: 0, Gid: 0, Size: int64(len(profile))}); err != nil {
		return err
	}
	if _, err := tw.Write(profile); err != nil {
		return err
	}
	if err := tw.WriteHeader(&tar.Header{Name: "antnest-auth/tunnel.json", Typeflag: tar.TypeReg, Mode: 0600, Uid: 0, Gid: 0, Size: int64(len(tunnel))}); err != nil {
		return err
	}
	if _, err := tw.Write(tunnel); err != nil {
		return err
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := w.engine.PutArchive(ctx, helperID, "/run", &archive); err != nil {
		return err
	}
	return w.verifyProfile(ctx, helperID, descriptor)
}

func (w *InstanceVolumeWriter) verifyProfile(ctx context.Context, containerID string, descriptor *deployment.RuntimeAuthentication) (resultErr error) {
	stream, err := w.engine.GetArchive(ctx, containerID, instanceauth.Directory)
	if errors.Is(err, ErrNotFound) {
		return errInstanceUnprepared
	}
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, stream.Close()) }()
	reader := tar.NewReader(stream)
	root, err := reader.Next()
	if err != nil {
		return fmt.Errorf("%w: receiver directory archive is invalid", ErrConflict)
	}
	rootName := strings.TrimSuffix(strings.TrimPrefix(root.Name, "./"), "/")
	if rootName != "antnest-auth" || root.Typeflag != tar.TypeDir || root.Uid != 0 || root.Gid != 0 {
		return fmt.Errorf("%w: receiver directory identity differs", ErrConflict)
	}
	expected := map[string]string{"antnest-auth/callers.json": descriptor.ReceiverDigest, "antnest-auth/tunnel.json": descriptor.Tunnel.KeysDigest}
	for count := 0; ; count++ {
		file, err := reader.Next()
		if err == io.EOF {
			if count == 0 {
				return errInstanceUnprepared
			}
			if len(expected) != 0 {
				return fmt.Errorf("%w: private bootstrap file missing", ErrConflict)
			}
			break
		}
		if err != nil {
			return fmt.Errorf("%w: private bootstrap archive invalid", ErrConflict)
		}
		digest, exists := expected[file.Name]
		if !exists || root.Mode&07777 != 0700 || file.Typeflag != tar.TypeReg || file.Mode&07777 != 0600 || file.Uid != 0 || file.Gid != 0 || file.Size < 1 || file.Size > 8192 {
			return fmt.Errorf("%w: private bootstrap file identity differs", ErrConflict)
		}
		data, err := io.ReadAll(io.LimitReader(reader, 8193))
		valid := err == nil && len(data) == int(file.Size) && instanceauth.Digest(data) == digest
		clear(data)
		if !valid {
			return fmt.Errorf("%w: private bootstrap bytes differ", ErrConflict)
		}
		delete(expected, file.Name)
	}
	return nil
}

func (w *InstanceVolumeWriter) VerifyRuntimeMount(ctx context.Context, key deployment.Key, descriptor *deployment.RuntimeAuthentication, containerID string) error {
	if key.Validate() != nil || descriptor == nil || !instanceauth.ValidConnectionID(descriptor.ConnectionID) || descriptor.CallersFile != instanceauth.CallersFile || deployment.ValidateDigest(descriptor.ReceiverDigest) != nil || !instanceauth.ValidTunnelKeyID(descriptor.Tunnel.KeyID) || descriptor.Tunnel.KeysFile != instanceauth.TunnelFile || deployment.ValidateDigest(descriptor.Tunnel.KeysDigest) != nil {
		return fmt.Errorf("%w: instance receiver identity is invalid", ErrConflict)
	}
	id := w.identity(key)
	name := instanceVolumeName(id)
	container, err := w.engine.InspectContainer(ctx, containerID)
	if err != nil {
		return err
	}
	if container.ID != containerID || container.Name != containerName(key.AgentID) || container.Labels[labelManaged] != "runtime" || container.Labels[labelScope] != id.Scope || container.Labels[labelAgentID] != id.AgentID || container.Labels[labelGeneration] != strconv.FormatUint(key.Generation, 10) || !hasInstanceMount(container, name, true) {
		return fmt.Errorf("%w: actual instance receiver mount differs", ErrConflict)
	}
	volume, err := w.engine.InspectVolume(ctx, name)
	if err != nil || volume.Name != name || !matchLabels(volume.Labels, instanceVolumeLabels(id, descriptor)) {
		return fmt.Errorf("%w: actual instance receiver volume ownership differs", ErrConflict)
	}
	return w.verifyProfile(ctx, containerID, descriptor)
}

func (w *InstanceVolumeWriter) Remove(ctx context.Context, key deployment.Key) error {
	if err := key.Validate(); err != nil {
		return err
	}
	id := w.identity(key)
	name := instanceVolumeName(id)
	volume, err := w.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if volume.Name != name || volume.Labels[labelManaged] != "runtime-auth" || volume.Labels[labelScope] != id.Scope || volume.Labels[labelAgentID] != id.AgentID || volume.Labels[labelGeneration] != strconv.FormatUint(id.Generation, 10) {
		return fmt.Errorf("%w: instance receiver cleanup ownership differs", ErrConflict)
	}
	if err := w.engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}
