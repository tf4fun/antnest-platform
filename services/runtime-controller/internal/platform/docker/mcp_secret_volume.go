package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
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

const mcpSecretDirectory = "/run/antnest-mcp"

var errMCPUnprepared = errors.New("managed MCP bootstrap is unprepared")

type MCPSecretResolver interface {
	Resolve(context.Context, *deployment.MCPTemplateSource, []deployment.MCPServer) (map[string]map[string]string, error)
}
type MCPMountGate interface {
	Prepare(context.Context, deployment.Key, *deployment.MCPTemplateSource, []deployment.MCPServer) error
	VerifyRuntimeMount(context.Context, deployment.Key, *deployment.MCPTemplateSource, []deployment.MCPServer, string) error
	Remove(context.Context, deployment.Key) error
}

type MCPVolumeWriter struct {
	engine       SkillVolumeEngine
	image, scope string
	resolver     MCPSecretResolver
}

func NewMCPVolumeWriter(engine SkillVolumeEngine, image, scope string, resolver MCPSecretResolver) (*MCPVolumeWriter, error) {
	if engine == nil || image == "" || scope == "" || resolver == nil {
		return nil, errors.New("managed MCP bootstrap dependencies required")
	}
	return &MCPVolumeWriter{engine: engine, image: image, scope: scope, resolver: resolver}, nil
}

func mcpVolumeName(scope string, key deployment.Key) string {
	encoded, _ := json.Marshal([]any{scope, key.AgentID, key.Generation})
	return "antnest-runtime-mcp-" + instanceauth.Digest(encoded)[7:39]
}
func mcpVolumeLabels(scope string, key deployment.Key, source *deployment.MCPTemplateSource, servers []deployment.MCPServer) map[string]string {
	identity, _ := json.Marshal(struct {
		Source  *deployment.MCPTemplateSource
		Servers []deployment.MCPServer
	}{source, servers})
	return map[string]string{labelManaged: "runtime-mcp-secrets", labelScope: scope, labelAgentID: key.AgentID, labelGeneration: strconv.FormatUint(key.Generation, 10), "io.antnest.mcp-source-digest": instanceauth.Digest(identity)}
}

func hasMCPMount(container Container, name string, readonly bool) bool {
	count := 0
	for _, mount := range container.Mounts {
		if mount.Destination == mcpSecretDirectory {
			if mount.Type != "volume" || mount.Name != name || mount.ReadWrite == readonly || !mount.NoCopy {
				return false
			}
			count++
		}
	}
	return count == 1
}

func (writer *MCPVolumeWriter) Prepare(ctx context.Context, key deployment.Key, source *deployment.MCPTemplateSource, servers []deployment.MCPServer) (resultErr error) {
	if key.Validate() != nil || source.Validate() != nil || !deployment.HasMCPSecrets(servers) {
		return errors.New("managed MCP bootstrap identity invalid")
	}
	runtime, err := writer.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), containerName(key.AgentID))
	if err == nil && runtime.Running {
		return writer.VerifyRuntimeMount(ctx, key, source, servers, runtime.ID)
	}
	if err != nil && !errors.Is(err, ErrNotFound) {
		return errors.New("managed MCP Runtime inspection failed")
	}
	name := mcpVolumeName(writer.scope, key)
	labels := mcpVolumeLabels(writer.scope, key, source, servers)
	volume, err := writer.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		createErr := writer.engine.CreateVolume(ctx, name, labels)
		volume, err = writer.engine.InspectVolume(ctx, name)
		if err != nil {
			return errors.Join(errors.New("managed MCP bootstrap volume creation failed"), createErr)
		}
	}
	if err != nil || volume.Name != name || !matchLabels(volume.Labels, labels) {
		return errors.New("managed MCP bootstrap volume ownership differs")
	}
	helperName := "antnest-mcp-preparer-" + strings.TrimPrefix(name, "antnest-runtime-mcp-")
	helperLabels := mcpVolumeLabels(writer.scope, key, source, servers)
	helperLabels[labelManaged] = "runtime-mcp-preparer"
	helper, err := writer.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), helperName)
	if err == nil {
		if helper.Running || helper.Status != "created" || helper.Name != helperName || !matchLabels(helper.Labels, helperLabels) || !hasMCPMount(helper, name, false) {
			return errors.New("managed MCP bootstrap helper ownership differs")
		}
		if err := writer.engine.RemoveContainer(ctx, helper.ID); err != nil {
			return err
		}
	} else if !errors.Is(err, ErrNotFound) {
		return errors.New("managed MCP bootstrap helper inspection failed")
	}
	helperID, err := writer.engine.CreateContainer(ctx, ContainerSpec{Name: helperName, Image: writer.image, User: "0:0", NetworkMode: "none", Mounts: map[string]Mount{mcpSecretDirectory: {Source: name, NoCopy: true}}, Labels: helperLabels, RestartPolicy: "no", PidsLimit: 32, MemoryBytes: 64 << 20})
	if err != nil {
		return errors.New("managed MCP bootstrap helper creation failed")
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		resultErr = errors.Join(resultErr, writer.engine.RemoveContainer(cleanup, helperID))
	}()
	helper, err = writer.engine.InspectContainer(ctx, helperID)
	if err != nil || helper.Running || helper.Status != "created" || helper.Name != helperName || !matchLabels(helper.Labels, helperLabels) || !hasMCPMount(helper, name, false) {
		return errors.New("actual managed MCP helper differs")
	}
	volume, err = writer.engine.InspectVolume(ctx, name)
	if err != nil || !matchLabels(volume.Labels, labels) {
		return errors.New("managed MCP bootstrap volume changed after helper creation")
	}
	if err := writer.verifyArchive(ctx, helperID, servers); err == nil {
		return nil
	} else if !errors.Is(err, errMCPUnprepared) {
		return err
	}
	values, err := writer.resolver.Resolve(ctx, source, servers)
	if err != nil {
		return errors.New("managed MCP bootstrap resolver unavailable")
	}
	if deployment.ValidateMCPSecretValues(servers, values) != nil {
		return errors.New("managed MCP bootstrap values differ")
	}
	data, err := json.Marshal(values)
	if err != nil || len(data) > 65536 {
		return errors.New("managed MCP bootstrap size invalid")
	}
	defer clear(data)
	var archive bytes.Buffer
	tw := tar.NewWriter(&archive)
	for _, header := range []*tar.Header{{Name: "antnest-mcp", Typeflag: tar.TypeDir, Mode: 0700, Uid: 0, Gid: 0}, {Name: "antnest-mcp/secrets.json", Typeflag: tar.TypeReg, Mode: 0400, Uid: 0, Gid: 0, Size: int64(len(data))}} {
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if header.Typeflag == tar.TypeReg {
			if _, err := tw.Write(data); err != nil {
				return err
			}
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := writer.engine.PutArchive(ctx, helperID, "/run", &archive); err != nil {
		return errors.New("managed MCP bootstrap archive write failed")
	}
	return writer.verifyArchive(ctx, helperID, servers)
}

func (writer *MCPVolumeWriter) verifyArchive(ctx context.Context, id string, servers []deployment.MCPServer) error {
	stream, err := writer.engine.GetArchive(ctx, id, mcpSecretDirectory)
	if errors.Is(err, ErrNotFound) {
		return errMCPUnprepared
	}
	if err != nil {
		return errors.New("managed MCP bootstrap archive read failed")
	}
	defer func() { _ = stream.Close() }()
	reader := tar.NewReader(stream)
	root, err := reader.Next()
	if err == io.EOF {
		return errMCPUnprepared
	}
	if err != nil || root.Typeflag != tar.TypeDir || strings.TrimSuffix(strings.TrimPrefix(root.Name, "./"), "/") != "antnest-mcp" || root.Uid != 0 || root.Gid != 0 {
		return errors.New("managed MCP bootstrap directory invalid")
	}
	file, err := reader.Next()
	if err == io.EOF {
		return errMCPUnprepared
	}
	if err != nil || root.Mode&07777 != 0700 || file.Typeflag != tar.TypeReg || file.Name != "antnest-mcp/secrets.json" || file.Mode&07777 != 0400 || file.Uid != 0 || file.Gid != 0 || file.Size < 1 || file.Size > 65536 {
		return errors.New("managed MCP bootstrap file metadata invalid")
	}
	data, err := io.ReadAll(io.LimitReader(reader, 65537))
	if err != nil || len(data) != int(file.Size) {
		return errors.New("managed MCP bootstrap bytes invalid")
	}
	defer clear(data)
	var values map[string]map[string]string
	if json.Unmarshal(data, &values) != nil || deployment.ValidateMCPSecretValues(servers, values) != nil {
		return errors.New("managed MCP bootstrap content invalid")
	}
	if _, err := reader.Next(); err != io.EOF {
		return errors.New("managed MCP bootstrap has extra files")
	}
	return nil
}

func (writer *MCPVolumeWriter) VerifyRuntimeMount(ctx context.Context, key deployment.Key, source *deployment.MCPTemplateSource, servers []deployment.MCPServer, id string) error {
	if key.Validate() != nil || source.Validate() != nil {
		return errors.New("managed MCP bootstrap identity invalid")
	}
	name := mcpVolumeName(writer.scope, key)
	container, err := writer.engine.InspectContainer(ctx, id)
	if err != nil || container.ID != id || container.Name != containerName(key.AgentID) || container.Labels[labelManaged] != "runtime" || container.Labels[labelScope] != writer.scope || container.Labels[labelAgentID] != key.AgentID || container.Labels[labelGeneration] != strconv.FormatUint(key.Generation, 10) || !hasMCPMount(container, name, true) {
		return errors.New("actual managed MCP bootstrap mount differs")
	}
	volume, err := writer.engine.InspectVolume(ctx, name)
	if err != nil || volume.Name != name || !matchLabels(volume.Labels, mcpVolumeLabels(writer.scope, key, source, servers)) {
		return errors.New("actual managed MCP bootstrap volume differs")
	}
	return writer.verifyArchive(ctx, id, servers)
}

func (writer *MCPVolumeWriter) Remove(ctx context.Context, key deployment.Key) error {
	if key.Validate() != nil {
		return errors.New("managed MCP cleanup identity invalid")
	}
	name := mcpVolumeName(writer.scope, key)
	volume, err := writer.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	if volume.Name != name || volume.Labels[labelManaged] != "runtime-mcp-secrets" || volume.Labels[labelScope] != writer.scope || volume.Labels[labelAgentID] != key.AgentID || volume.Labels[labelGeneration] != strconv.FormatUint(key.Generation, 10) {
		return fmt.Errorf("%w: managed MCP cleanup ownership differs", ErrConflict)
	}
	if err := writer.engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, ErrNotFound) {
		return err
	}
	return nil
}
