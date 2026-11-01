package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/deployment"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/platform"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/telemetry"
)

var _ platform.Port = (*Driver)(nil)

const (
	labelManaged    = "io.antnest.managed"
	labelScope      = "io.antnest.runtime-controller-scope"
	labelAgentID    = "io.antnest.agent-id"
	labelGeneration = "io.antnest.runtime-generation"
	labelSpecDigest = "io.antnest.runtime-spec-digest"
)

var (
	ErrNotFound = errors.New("docker resource was not found")
	ErrConflict = errors.New("docker resource already exists")
)

type Config struct {
	MCPMountGate          MCPMountGate
	AllowedImages         []string
	ControllerScope       string
	ManagementNetwork     string
	SystemSkillsVolume    string
	RuntimeOTEL           map[string]string
	SkillMountGate        SkillMountGate
	InstanceMountGate     InstanceMountGate
	ResolverMountGate     ResolverMountGate
	RuntimeAuthentication map[string]string
	StopGraceSeconds      int
	WorkspaceVolumeDriver string
	WorkspaceQuotaOption  string
}

const RuntimeStopGraceSeconds = 20

type SkillMountGate interface {
	VerifyRuntimeMount(context.Context, skillset.SetKey, string, string) error
}

type ResolverMountGate interface {
	Prepare(context.Context, deployment.Key, string) error
	VerifyRuntimeMount(context.Context, deployment.Key, string, string) error
	Remove(context.Context, deployment.Key) error
}

type Engine interface {
	Ping(context.Context) error
	InspectImage(context.Context, string) (string, error)
	InspectContainer(context.Context, string) (Container, error)
	ListManagedContainerIDs(context.Context) ([]string, error)
	ListManagedContainers(context.Context) ([]Container, error)
	WatchManagedEvents(context.Context, time.Time, func() error, func(ContainerEvent) error) error
	InspectVolume(context.Context, string) (Volume, error)
	CreateVolume(context.Context, string, map[string]string) error
	CreateQuotaVolume(context.Context, string, map[string]string, string, map[string]string) error
	InspectNetwork(context.Context, string) error
	CreateContainer(context.Context, ContainerSpec) (string, error)
	StartContainer(context.Context, string) error
	StopContainer(context.Context, string) error
	RemoveContainer(context.Context, string) error
	RemoveVolume(context.Context, string) error
}

type ContainerEvent struct {
	ID         string
	Action     string
	Attributes map[string]string
	ObservedAt time.Time
}

type Container struct {
	ID           string
	Name         string
	Running      bool
	Status       string
	ExitCode     int
	OOMKilled    bool
	Error        string
	Health       string
	RestartCount uint64
	Labels       map[string]string
	NetworkIPv4  map[string]string
	Mounts       []ObservedMount
}

type ObservedMount struct {
	Type        string
	Name        string
	Destination string
	ReadWrite   bool
	NoCopy      bool
	Subpath     string
}

type Volume struct {
	Name    string
	Driver  string
	Options map[string]string
	Labels  map[string]string
}

type Mount struct {
	Source   string
	ReadOnly bool
	NoCopy   bool
	Subpath  string
}

type Healthcheck struct {
	Test          []string
	Interval      time.Duration
	Timeout       time.Duration
	StartPeriod   time.Duration
	StartInterval time.Duration
	Retries       int
}

type ContainerSpec struct {
	Name           string
	Image          string
	User           string
	Environment    map[string]string
	Labels         map[string]string
	Mounts         map[string]Mount
	Capabilities   []string
	DNS            []string
	DNSOptions     []string
	Devices        []string
	ReadOnlyRootFS bool
	Tmpfs          map[string]string
	Networks       []string
	NetworkMode    string
	PidsLimit      int64
	MemoryBytes    int64
	NanoCPUs       int64
	CPUShares      int64
	StopTimeout    int
	SecurityOpt    []string
	RestartPolicy  string
	Healthcheck    Healthcheck
}

type Driver struct {
	engine   Engine
	config   Config
	images   *ImagePolicy
	createMu sync.Mutex
	capacity atomic.Value
}

func NewDriver(engine Engine, config Config) (*Driver, error) {
	if engine == nil {
		return nil, fmt.Errorf("docker engine is required")
	}
	config.ControllerScope = strings.TrimSpace(config.ControllerScope)
	config.ManagementNetwork = strings.TrimSpace(config.ManagementNetwork)
	config.SystemSkillsVolume = strings.TrimSpace(config.SystemSkillsVolume)
	if config.ControllerScope == "" || config.ManagementNetwork == "" || config.SystemSkillsVolume == "" {
		return nil, fmt.Errorf("controller scope, management network, and system Skills volume are required")
	}
	images, err := ParseImagePolicy(config.AllowedImages)
	if err != nil {
		return nil, err
	}
	if config.StopGraceSeconds == 0 {
		config.StopGraceSeconds = RuntimeStopGraceSeconds
	}
	if config.StopGraceSeconds < 20 || config.StopGraceSeconds > 120 {
		return nil, fmt.Errorf("runtime stop grace %d must be a whole second value within [20, 120]", config.StopGraceSeconds)
	}
	driver := &Driver{engine: engine, config: config, images: images}
	driver.capacity.Store(platform.Capacity{})
	return driver, nil
}

func (d *Driver) Ready(ctx context.Context) error {
	if err := d.engine.Ping(ctx); err != nil {
		return err
	}
	managed, err := d.engine.ListManagedContainers(ctx)
	if err != nil {
		return err
	}
	if _, err := d.migrateLegacyRuntimes(ctx, managed); err != nil {
		return err
	}
	if err := d.engine.InspectNetwork(ctx, d.config.ManagementNetwork); err != nil {
		return fmt.Errorf("inspect Runtime management network: %w", err)
	}
	if _, err := d.engine.InspectVolume(ctx, d.config.SystemSkillsVolume); err != nil {
		return fmt.Errorf("inspect system Skills volume: %w", err)
	}
	d.refreshCapacityWithInventory(ctx, managed)
	return nil
}

func (d *Driver) migrateLegacyRuntimes(ctx context.Context, managed []Container) (int, error) {
	renamer, ok := d.engine.(interface {
		RenameContainer(context.Context, string, string) error
	})
	migrated := 0
	for _, container := range managed {
		if !d.owns(container.Labels) {
			continue
		}
		agentLabel := strings.TrimSpace(container.Labels[labelAgentID])
		scoped := runtimeContainerName(d.config.ControllerScope, agentLabel)
		if container.Name == scoped {
			continue
		}
		if !managedRuntimeName(d.config.ControllerScope, container.Name, agentLabel) {
			return migrated, fmt.Errorf("managed Runtime container %q does not match its scope identity", container.Name)
		}
		if _, _, err := managedIdentity(container.Labels); err != nil {
			return migrated, fmt.Errorf("normalize managed Runtime container for migration: %w", err)
		}
		if !ok {
			continue
		}
		existing, err := d.engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), scoped)
		if err == nil {
			return migrated, fmt.Errorf("legacy Runtime container %q conflicts with existing %q", container.Name, existing.Name)
		}
		if !errors.Is(err, ErrNotFound) {
			return migrated, fmt.Errorf("inspect scoped Runtime name %q: %w", scoped, err)
		}
		if err := renamer.RenameContainer(ctx, container.ID, scoped); err != nil {
			return migrated, fmt.Errorf("rename legacy Runtime container %q: %w", container.Name, err)
		}
		migrated++
	}
	return migrated, nil
}

func ownedRuntimeContainer(ctx context.Context, engine interface {
	InspectContainer(context.Context, string) (Container, error)
}, scope, agentID string) (Container, error) {
	scoped, err := engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), runtimeContainerName(scope, agentID))
	if err == nil {
		return scoped, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Container{}, err
	}
	legacy, err := engine.InspectContainer(telemetry.WithExpectedDockerAbsence(ctx), containerName(agentID))
	if err != nil {
		return Container{}, err
	}
	if legacy.Labels[labelManaged] != "runtime" || legacy.Labels[labelScope] != scope {
		return Container{}, ErrNotFound
	}
	return legacy, nil
}

func (d *Driver) inspectRuntimeContainer(ctx context.Context, agentID string) (Container, error) {
	return ownedRuntimeContainer(ctx, d.engine, d.config.ControllerScope, agentID)
}

func (d *Driver) DeploymentDigest(value deployment.Deployment) (string, error) {
	key := deployment.Key{
		AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation,
	}
	if err := value.ValidateFor(key); err != nil {
		return "", err
	}
	return d.digestForNames(value, d.scopedNames(value.RuntimeSpec.AgentID))
}

func (d *Driver) digestForNames(value deployment.Deployment, names resourceNames) (string, error) {
	key := deployment.Key{
		AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation,
	}
	if err := value.ValidateFor(key); err != nil {
		return "", err
	}
	logical := value
	logical.PreparedMaterialization = nil
	spec, err := d.containerSpec(logical, "", names)
	if err != nil {
		return "", err
	}
	delete(spec.Labels, labelSpecDigest)
	return deployment.DigestValue(struct {
		Revision           uint32                        `json:"revision"`
		Platform           string                        `json:"platform"`
		Name               string                        `json:"name"`
		Request            createContainerRequest        `json:"request"`
		PreparedSkills     *skillset.PreparedReference   `json:"prepared_skills,omitempty"`
		ManagedMCPTemplate *deployment.MCPTemplateSource `json:"managed_mcp_template,omitempty"`
	}{Revision: 1, Platform: "docker", Name: spec.Name, Request: dockerCreateRequest(spec), PreparedSkills: value.PreparedSkills, ManagedMCPTemplate: value.ManagedMCPTemplate})
}

func (d *Driver) scopedNames(agentID string) resourceNames {
	return resourceNames{
		container: runtimeContainerName(d.config.ControllerScope, agentID),
		workspace: workspaceVolumeName(d.config.ControllerScope, agentID),
	}
}

func (d *Driver) legacyDeploymentDigest(value deployment.Deployment) (string, error) {
	return d.digestForNames(value, resourceNames{
		container: containerName(value.RuntimeSpec.AgentID),
		workspace: workspaceVolume(value.RuntimeSpec.AgentID),
	})
}

func (d *Driver) Create(
	ctx context.Context, value deployment.Deployment, digest string,
) deployment.EffectOutcome {
	key := deployment.Key{AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation}
	if err := value.ValidateFor(key); err != nil {
		return failed(deployment.EffectNotStarted, "invalid_request", err)
	}
	if (value.PreparedSkills == nil) != (value.PreparedMaterialization == nil) || value.PreparedSkills != nil && d.config.SkillMountGate == nil {
		return failed(deployment.EffectNotStarted, "invalid_request", errors.New("prepared Skill materialization and mount gate are required"))
	}
	if value.PreparedSkills != nil {
		logical, physical := value.PreparedSkills, value.PreparedMaterialization
		if logical.Scope != physical.Key.Scope || logical.OrganizationID != physical.Key.OrganizationID || logical.AgentID != physical.Key.AgentID ||
			logical.SkillSetDigest != physical.Key.SkillSetDigest || logical.LayoutVersion != physical.Key.LayoutVersion {
			return failed(deployment.EffectNotStarted, "invalid_request", errors.New("prepared Skill logical and physical identities differ"))
		}
	}
	computed, err := d.DeploymentDigest(value)
	if err == nil && computed != digest {
		if legacy, legacyErr := d.legacyDeploymentDigest(value); legacyErr == nil && legacy == digest {
			computed = digest
		}
	}
	if err != nil || computed != digest {
		return failed(deployment.EffectNotStarted, "invalid_request", errors.New("deployment digest mismatch"))
	}
	workspace, err := d.requireCreateStorage(ctx, key.AgentID, value.PreparedMaterialization, value.Resources)
	if err != nil {
		switch {
		case errors.Is(err, deployment.ErrIdentityConflict):
			return failed(deployment.EffectNotStarted, "storage_ownership_conflict", err)
		case errors.Is(err, ErrNotFound):
			return failed(deployment.EffectNotStarted, "storage_not_found", err)
		default:
			return dockerFailure("platform_unavailable", err, false)
		}
	}
	if d.config.InstanceMountGate != nil || value.RuntimeSpec.Authentication != nil {
		if d.config.InstanceMountGate == nil || value.RuntimeSpec.Authentication == nil || value.InstanceAuthentication == nil || value.InstanceAuthentication.ConnectionID != value.RuntimeSpec.Authentication.ConnectionID || value.InstanceAuthentication.ReceiverDigest != value.RuntimeSpec.Authentication.ReceiverDigest || value.InstanceAuthentication.Tunnel == nil || value.InstanceAuthentication.Tunnel.Descriptor() != value.RuntimeSpec.Authentication.Tunnel {
			return failed(deployment.EffectNotStarted, "invalid_request", errors.New("accepted instance authority and mount gate are required"))
		}
		if err := d.config.InstanceMountGate.Prepare(ctx, key, value.InstanceAuthentication); err != nil {
			return dockerFailure("instance_receiver_preparation_failed", err, true)
		}
	}

	if deployment.HasMCPSecrets(value.RuntimeSpec.MCPServers) {
		if d.config.MCPMountGate == nil {
			return failed(deployment.EffectNotStarted, "invalid_request", errors.New("managed MCP bootstrap dependency is not configured"))
		}
		if err := d.config.MCPMountGate.Prepare(ctx, key, value.ManagedMCPTemplate, value.RuntimeSpec.MCPServers); err != nil {
			return dockerFailure("platform_unavailable", err, true)
		}
	}
	if d.config.ResolverMountGate == nil {
		return failed(deployment.EffectNotStarted, "invalid_request", errors.New("resolver mount gate is required"))
	}
	if err := d.config.ResolverMountGate.Prepare(ctx, key, value.RuntimeSpec.Network.ResolverIPv4); err != nil {
		return dockerFailure("platform_unavailable", err, true)
	}

	name := runtimeContainerName(d.config.ControllerScope, key.AgentID)
	existing, err := d.inspectRuntimeContainer(ctx, key.AgentID)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return dockerFailure("platform_unavailable", err, false)
	}
	if err == nil {
		return d.convergeContainer(ctx, existing, key, digest, value.PreparedMaterialization, value.RuntimeSpec.Authentication, value.ManagedMCPTemplate, value.RuntimeSpec.MCPServers, value.RuntimeSpec.Network.ResolverIPv4)
	}

	spec, err := d.containerSpec(value, digest, resourceNames{container: name, workspace: workspace.Name})
	if err != nil {
		return failed(deployment.EffectNotStarted, "invalid_request", err)
	}
	d.createMu.Lock()
	if capacityErr := d.admitRuntimeCapacity(ctx); capacityErr != nil {
		d.createMu.Unlock()
		return failed(deployment.EffectNotStarted, "runtime_capacity_exhausted", capacityErr)
	}
	containerID, err := d.engine.CreateContainer(ctx, spec)
	if err != nil {
		d.createMu.Unlock()
		existing, inspectErr := d.engine.InspectContainer(ctx, name)
		if inspectErr == nil {
			return d.convergeContainer(ctx, existing, key, digest, value.PreparedMaterialization, value.RuntimeSpec.Authentication, value.ManagedMCPTemplate, value.RuntimeSpec.MCPServers, value.RuntimeSpec.Network.ResolverIPv4)
		}
		if isIPAMExhaustion(err) {
			return failed(deployment.EffectNotStarted, "runtime_capacity_exhausted", errors.Join(err, inspectErr))
		}
		return dockerFailure(
			"platform_unavailable", errors.Join(err, inspectErr), errors.Is(err, ErrConflict),
		)
	}
	defer d.createMu.Unlock()
	if prepared := value.PreparedMaterialization; prepared != nil {
		if err := d.config.SkillMountGate.VerifyRuntimeMount(ctx, prepared.Key, containerID, prepared.ManifestDigest); err != nil {
			return failed(deployment.EffectUnknown, "skill_mount_verification_failed",
				errors.Join(err, d.removeRejectedSkillCandidate(containerID, key, digest)))
		}
	}
	if auth := value.RuntimeSpec.Authentication; auth != nil {
		if err := d.config.InstanceMountGate.VerifyRuntimeMount(ctx, key, auth, containerID); err != nil {
			return failed(deployment.EffectUnknown, "instance_mount_verification_failed", errors.Join(err, d.removeRejectedSkillCandidate(containerID, key, digest)))
		}
	}
	if deployment.HasMCPSecrets(value.RuntimeSpec.MCPServers) {
		if err := d.config.MCPMountGate.VerifyRuntimeMount(ctx, key, value.ManagedMCPTemplate, value.RuntimeSpec.MCPServers, containerID); err != nil {
			return failed(deployment.EffectUnknown, "platform_unavailable", errors.Join(err, d.removeRejectedSkillCandidate(containerID, key, digest)))
		}
	}
	if err := d.config.ResolverMountGate.VerifyRuntimeMount(ctx, key, value.RuntimeSpec.Network.ResolverIPv4, containerID); err != nil {
		return failed(deployment.EffectUnknown, "platform_unavailable", errors.Join(err, d.removeRejectedSkillCandidate(containerID, key, digest)))
	}
	if err := d.engine.StartContainer(ctx, containerID); err != nil {
		existing, inspectErr := d.engine.InspectContainer(ctx, name)
		if inspectErr == nil && d.matches(existing, key, digest) && existing.Running {
			return d.convergeContainer(ctx, existing, key, digest, value.PreparedMaterialization, value.RuntimeSpec.Authentication, value.ManagedMCPTemplate, value.RuntimeSpec.MCPServers, value.RuntimeSpec.Network.ResolverIPv4)
		}
		if isIPAMExhaustion(err) {
			if cleanupErr := d.removeRejectedSkillCandidate(containerID, key, digest); cleanupErr != nil {
				return failed(deployment.EffectUnknown, "runtime_capacity_exhausted", errors.Join(err, inspectErr, cleanupErr))
			}
			return failed(deployment.EffectNotStarted, "runtime_capacity_exhausted", err)
		}
		return dockerFailure("platform_unavailable", errors.Join(err, inspectErr), true)
	}
	d.refreshCapacity(ctx)
	return completed()
}

// A failed mount gate leaves an operation unknown, but a candidate created by
// this call can be removed before it starts. Never remove a changed or running
// container, and never infer permission to delete its mounted volume here.
func (d *Driver) removeRejectedSkillCandidate(containerID string, key deployment.Key, digest string) error {
	cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	candidate, err := d.engine.InspectContainer(cleanup, containerID)
	if err != nil {
		return fmt.Errorf("inspect rejected Runtime candidate: %w", err)
	}
	if candidate.ID != containerID || candidate.Name != runtimeContainerName(d.config.ControllerScope, key.AgentID) ||
		!d.matches(candidate, key, digest) || candidate.Status != "created" || candidate.Running {
		return errors.New("rejected Runtime candidate changed before cleanup")
	}
	if err := d.engine.RemoveContainer(cleanup, containerID); err != nil {
		return fmt.Errorf("remove rejected Runtime candidate: %w", err)
	}
	return nil
}

func (d *Driver) convergeContainer(
	ctx context.Context, existing Container, key deployment.Key, digest string, prepared *skillset.PreparedMaterialization, auth *deployment.RuntimeAuthentication, source *deployment.MCPTemplateSource, servers []deployment.MCPServer, resolverIPv4 string,
) deployment.EffectOutcome {
	if !d.matches(existing, key, digest) {
		return failed(
			deployment.EffectNotStarted,
			"runtime_drift",
			errors.New("managed Runtime has another immutable identity"),
		)
	}
	if prepared != nil {
		if err := d.config.SkillMountGate.VerifyRuntimeMount(ctx, prepared.Key, existing.ID, prepared.ManifestDigest); err != nil {
			return failed(deployment.EffectUnknown, "skill_mount_verification_failed", err)
		}
	}
	if auth != nil {
		if err := d.config.InstanceMountGate.VerifyRuntimeMount(ctx, key, auth, existing.ID); err != nil {
			return failed(deployment.EffectUnknown, "instance_mount_verification_failed", err)
		}
	}
	if deployment.HasMCPSecrets(servers) {
		if d.config.MCPMountGate == nil {
			return failed(deployment.EffectNotStarted, "invalid_request", errors.New("managed MCP mount gate is required"))
		}
		if err := d.config.MCPMountGate.VerifyRuntimeMount(ctx, key, source, servers, existing.ID); err != nil {
			return failed(deployment.EffectUnknown, "platform_unavailable", err)
		}
	}
	if err := d.config.ResolverMountGate.VerifyRuntimeMount(ctx, key, resolverIPv4, existing.ID); err != nil {
		return failed(deployment.EffectUnknown, "platform_unavailable", err)
	}
	if existing.Running {
		return completed()
	}
	needsAddress := existing.NetworkIPv4[d.config.ManagementNetwork] == ""
	if needsAddress {
		d.createMu.Lock()
		if err := d.admitRuntimeCapacity(ctx); err != nil {
			d.createMu.Unlock()
			return failed(deployment.EffectNotStarted, "runtime_capacity_exhausted", err)
		}
	}
	err := d.engine.StartContainer(ctx, existing.ID)
	if err != nil {
		if needsAddress {
			d.createMu.Unlock()
		}
		current, inspectErr := d.engine.InspectContainer(ctx, existing.Name)
		if inspectErr == nil && d.matches(current, key, digest) && current.Running {
			return completed()
		}
		if isIPAMExhaustion(err) {
			if inspectErr == nil && d.matches(current, key, digest) && !current.Running {
				return failed(deployment.EffectNotStarted, "runtime_capacity_exhausted", err)
			}
			return failed(deployment.EffectUnknown, "runtime_capacity_exhausted", errors.Join(err, inspectErr))
		}
		return dockerFailure("platform_unavailable", errors.Join(err, inspectErr), true)
	}
	if needsAddress {
		d.refreshCapacity(ctx)
		d.createMu.Unlock()
	}
	return completed()
}

func (d *Driver) Inspect(
	ctx context.Context, key deployment.Key,
) (deployment.Inspection, error) {
	container, err := d.inspectRuntimeContainer(ctx, key.AgentID)
	if errors.Is(err, ErrNotFound) {
		return deployment.Inspection{
			AgentID: key.AgentID, Generation: key.Generation,
			PlatformPhase: deployment.PhaseAbsent, Health: deployment.HealthAbsent,
			ObservedAt: time.Now().UTC(),
		}, nil
	}
	if err != nil {
		return deployment.Inspection{}, err
	}
	if !d.matchesIdentity(container, key) {
		return deployment.Inspection{}, deployment.ErrIdentityConflict
	}
	return d.inspectContainer(container)
}

func (d *Driver) Delete(
	ctx context.Context, key deployment.Key, digest string,
) deployment.EffectOutcome {
	if err := key.Validate(); err != nil || deployment.ValidateDigest(digest) != nil {
		return failed(deployment.EffectNotStarted, "invalid_request", errors.New("invalid Runtime identity"))
	}
	container, err := d.inspectRuntimeContainer(ctx, key.AgentID)
	if errors.Is(err, ErrNotFound) {
		if d.config.MCPMountGate != nil {
			if err := d.config.MCPMountGate.Remove(ctx, key); err != nil {
				return dockerFailure("platform_unavailable", err, true)
			}
		}
		if d.config.InstanceMountGate != nil {
			if err := d.config.InstanceMountGate.Remove(ctx, key); err != nil {
				return dockerFailure("instance_receiver_cleanup_failed", err, true)
			}
		}
		if d.config.ResolverMountGate != nil {
			if err := d.config.ResolverMountGate.Remove(ctx, key); err != nil {
				return dockerFailure("platform_unavailable", err, true)
			}
		}
		return completed()
	}
	if err != nil {
		return dockerFailure("platform_unavailable", err, false)
	}
	if !d.matches(container, key, digest) {
		return failed(
			deployment.EffectNotStarted,
			"runtime_drift",
			errors.New("managed Runtime has another immutable identity"),
		)
	}
	if container.Running {
		var stopErr error
		if graceful, ok := d.engine.(interface {
			StopContainerWithGrace(context.Context, string, int) error
		}); ok {
			stopErr = graceful.StopContainerWithGrace(ctx, container.ID, d.config.StopGraceSeconds)
		} else if d.config.StopGraceSeconds == RuntimeStopGraceSeconds {
			stopErr = d.engine.StopContainer(ctx, container.ID)
		} else {
			return failed(deployment.EffectNotStarted, "platform_unavailable",
				fmt.Errorf("configured stop grace %d requires an engine supporting StopContainerWithGrace", d.config.StopGraceSeconds))
		}
		if err := stopErr; err != nil && !errors.Is(err, ErrNotFound) {
			return dockerFailure("platform_unavailable", err, true)
		}
	}
	if err := d.engine.RemoveContainer(ctx, container.ID); err != nil && !errors.Is(err, ErrNotFound) {
		return dockerFailure("platform_unavailable", err, true)
	}
	if d.config.MCPMountGate != nil {
		if err := d.config.MCPMountGate.Remove(ctx, key); err != nil {
			return dockerFailure("platform_unavailable", err, true)
		}
	}
	if d.config.InstanceMountGate != nil {
		if err := d.config.InstanceMountGate.Remove(ctx, key); err != nil {
			return dockerFailure("instance_receiver_cleanup_failed", err, true)
		}
	}
	if d.config.ResolverMountGate != nil {
		if err := d.config.ResolverMountGate.Remove(ctx, key); err != nil {
			return dockerFailure("platform_unavailable", err, true)
		}
	}
	return completed()
}

func (d *Driver) EnsureStorage(ctx context.Context, agentID string, limits ...deployment.ResourceLimits) deployment.EffectOutcome {
	name := workspaceVolumeName(d.config.ControllerScope, agentID)
	volume, err := d.workspaceSelection(ctx, agentID, true)
	if errors.Is(err, ErrNotFound) {
		labels := d.workspaceLabels(agentID)
		var createErr error
		if d.config.WorkspaceVolumeDriver != "" {
			bytes := strconv.FormatUint(requestedWorkspaceBytes(limits), 10)
			labels["io.antnest.workspace-bytes"] = bytes
			createErr = d.engine.CreateQuotaVolume(ctx, name, labels, d.config.WorkspaceVolumeDriver, map[string]string{d.config.WorkspaceQuotaOption: bytes})
		} else {
			createErr = d.engine.CreateVolume(ctx, name, labels)
		}
		volume, err = d.engine.InspectVolume(ctx, name)
		if err != nil {
			possiblyExists := createErr == nil || errors.Is(createErr, ErrConflict)
			return dockerFailure("platform_unavailable", errors.Join(createErr, err), possiblyExists)
		}
	}
	if err != nil {
		return dockerFailure("platform_unavailable", err, false)
	}
	if !d.workspaceOwned(volume, agentID) {
		return failed(deployment.EffectNotStarted, "storage_ownership_conflict",
			errors.New("workspace volume ownership labels differ"))
	}
	if err := d.workspaceQuotaMatches(volume, limits); err != nil {
		return failed(deployment.EffectNotStarted, "storage_ownership_conflict", err)
	}
	return completed()
}

func (d *Driver) VerifyStorage(ctx context.Context, agentID string, limits ...deployment.ResourceLimits) deployment.EffectOutcome {
	if _, err := d.requireWorkspace(ctx, agentID, limits...); err != nil {
		switch {
		case errors.Is(err, deployment.ErrIdentityConflict):
			return failed(deployment.EffectNotStarted, "storage_ownership_conflict", err)
		case errors.Is(err, ErrNotFound):
			return failed(deployment.EffectNotStarted, "storage_not_found", err)
		default:
			return dockerFailure("platform_unavailable", err, false)
		}
	}
	return completed()
}

func (d *Driver) DeleteStorage(ctx context.Context, agentID string) deployment.EffectOutcome {
	containers, err := d.engine.ListManagedContainers(ctx)
	if err != nil {
		return dockerFailure("platform_unavailable", err, false)
	}
	for _, container := range containers {
		if d.owns(container.Labels) && container.Labels[labelAgentID] == agentID {
			return failed(deployment.EffectNotStarted, "storage_in_use", errors.New("managed Runtime still exists"))
		}
	}
	scopedName := workspaceVolumeName(d.config.ControllerScope, agentID)
	for index, name := range []string{scopedName, workspaceVolume(agentID)} {
		volume, err := d.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), name)
		if errors.Is(err, ErrNotFound) {
			continue
		}
		if err != nil {
			return dockerFailure("platform_unavailable", err, false)
		}
		if !d.workspaceOwned(volume, agentID) {
			if index == 0 {
				return failed(deployment.EffectNotStarted, "storage_ownership_conflict",
					errors.New("workspace volume ownership labels differ"))
			}
			continue
		}
		if err := d.engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, ErrNotFound) {
			return dockerFailure("platform_unavailable", err, true)
		}
	}
	return completed()
}

func (d *Driver) List(ctx context.Context) ([]deployment.Inspection, error) {
	containers, err := d.engine.ListManagedContainers(ctx)
	if err != nil {
		return nil, err
	}
	migrated, err := d.migrateLegacyRuntimes(ctx, containers)
	if err != nil {
		return nil, err
	}
	if migrated > 0 {
		containers, err = d.engine.ListManagedContainers(ctx)
		if err != nil {
			return nil, err
		}
	}
	d.refreshCapacityWithInventory(ctx, containers)
	result := make([]deployment.Inspection, 0, len(containers))
	for _, container := range containers {
		if !d.owns(container.Labels) {
			continue
		}
		inspection, inspectErr := d.inspectContainer(container)
		if inspectErr != nil {
			return nil, inspectErr
		}
		result = append(result, inspection)
	}
	return result, nil
}

func (d *Driver) Watch(
	ctx context.Context,
	since time.Time,
	ready func(context.Context) error,
	emit func(context.Context, deployment.Observation) error,
) error {
	if ready == nil || emit == nil {
		return fmt.Errorf("docker observation readiness and sink callbacks are required")
	}
	return d.engine.WatchManagedEvents(ctx, since, func() error { return ready(ctx) }, func(event ContainerEvent) error {
		if !d.owns(event.Attributes) {
			return nil
		}
		key, digest, err := managedIdentity(event.Attributes)
		if err != nil {
			return fmt.Errorf("normalize managed Runtime event: %w", err)
		}
		kind, ok := observationKind(event.Action)
		if !ok {
			return nil
		}
		observedAt := event.ObservedAt
		if observedAt.IsZero() {
			observedAt = time.Now().UTC()
		}
		return emit(ctx, deployment.Observation{
			AgentID: key.AgentID, Generation: key.Generation,
			SpecDigest:         digest,
			PlatformResourceID: event.ID, Kind: kind,
			Source: "docker_event", ObservedAt: observedAt.UTC(),
		})
	})
}

func (d *Driver) inspectContainer(container Container) (deployment.Inspection, error) {
	key, digest, err := managedIdentity(container.Labels)
	if err != nil {
		return deployment.Inspection{}, fmt.Errorf("normalize managed Runtime container: %w", err)
	}
	if container.ID == "" || !managedRuntimeName(d.config.ControllerScope, container.Name, key.AgentID) {
		return deployment.Inspection{}, fmt.Errorf("normalize managed Runtime container: resource identity is malformed")
	}
	port, err := strconv.ParseUint(container.Labels["io.antnest.runtime-port"], 10, 16)
	if err != nil || port == 0 {
		return deployment.Inspection{}, fmt.Errorf("normalize managed Runtime container: Runtime port is malformed")
	}
	condition := containerCondition(container)
	peer := container.NetworkIPv4[d.config.ManagementNetwork]
	// Docker also reports Running for a restarting container; its restart
	// condition, not a missing address, is the diagnosis.
	if condition.phase == deployment.PhaseRunning {
		address, err := netip.ParseAddr(peer)
		if err != nil || !address.Is4() || !address.IsGlobalUnicast() || address.String() != peer {
			peer = ""
			condition.health = deployment.HealthUnknown
			condition.reason = "runtime_peer_unavailable"
			condition.detail = "Runtime management IPv4 is missing or invalid"
		}
	} else {
		peer = ""
	}
	// Docker resource names can exceed a DNS label after scope isolation.
	// Route HTTP only to the current, validated management-network peer.
	var statusEndpoint, mcpEndpoint string
	if peer != "" {
		base := "http://" + net.JoinHostPort(peer, strconv.FormatUint(port, 10))
		statusEndpoint, mcpEndpoint = base+"/status", base+"/mcp"
	}
	return deployment.Inspection{
		AgentID: key.AgentID, Generation: key.Generation,
		SpecDigest: digest, PlatformResourceID: container.ID,
		PlatformPhase: condition.phase, Health: condition.health, Reason: condition.reason,
		DiagnosticSummary: condition.detail, StatusEndpoint: statusEndpoint,
		MCPEndpoint: mcpEndpoint, RestartCount: container.RestartCount,
		RuntimeEndpoint: peer,
		ObservedAt:      time.Now().UTC(),
	}, nil
}

func managedIdentity(labels map[string]string) (deployment.Key, string, error) {
	if labels[labelManaged] != "runtime" {
		return deployment.Key{}, "", deployment.ErrIdentityConflict
	}
	generation, err := strconv.ParseUint(labels[labelGeneration], 10, 64)
	if err != nil {
		return deployment.Key{}, "", deployment.ErrIdentityConflict
	}
	key := deployment.Key{AgentID: strings.TrimSpace(labels[labelAgentID]), Generation: generation}
	digest := strings.TrimSpace(labels[labelSpecDigest])
	if key.Validate() != nil || deployment.ValidateDigest(digest) != nil {
		return deployment.Key{}, "", deployment.ErrIdentityConflict
	}
	return key, digest, nil
}

func (d *Driver) workspaceSelection(ctx context.Context, agentID string, expectedAbsence bool) (Volume, error) {
	volume, err := d.engine.InspectVolume(telemetry.WithExpectedDockerAbsence(ctx), workspaceVolumeName(d.config.ControllerScope, agentID))
	if err == nil {
		return volume, nil
	}
	if !errors.Is(err, ErrNotFound) {
		return Volume{}, err
	}
	probe := ctx
	if expectedAbsence {
		probe = telemetry.WithExpectedDockerAbsence(ctx)
	}
	legacy, err := d.engine.InspectVolume(probe, workspaceVolume(agentID))
	if err != nil {
		return Volume{}, err
	}
	if legacy.Labels[labelManaged] != "workspace" || legacy.Labels[labelScope] != d.config.ControllerScope {
		return Volume{}, ErrNotFound
	}
	return legacy, nil
}

func (d *Driver) requireWorkspace(ctx context.Context, agentID string, limits ...deployment.ResourceLimits) (Volume, error) {
	workspace, err := d.workspaceSelection(ctx, agentID, false)
	if err != nil {
		return Volume{}, fmt.Errorf("workspace volume: %w", err)
	}
	if !d.workspaceOwned(workspace, agentID) {
		return Volume{}, fmt.Errorf("workspace volume: %w", deployment.ErrIdentityConflict)
	}
	if err := d.workspaceQuotaMatches(workspace, limits); err != nil {
		return Volume{}, fmt.Errorf("workspace volume: %w", deployment.ErrIdentityConflict)
	}
	return workspace, nil
}

func (d *Driver) requireCreateStorage(ctx context.Context, agentID string, prepared *skillset.PreparedMaterialization, limits ...deployment.ResourceLimits) (Volume, error) {
	workspace, err := d.requireWorkspace(ctx, agentID, limits...)
	if err != nil {
		return Volume{}, err
	}
	if prepared != nil {
		name, err := prepared.Key.VolumeName()
		if err != nil || name != prepared.VolumeName || prepared.Key.Scope != d.config.ControllerScope || prepared.Key.AgentID != agentID {
			return Volume{}, deployment.ErrIdentityConflict
		}
		volume, err := d.engine.InspectVolume(ctx, name)
		if err != nil {
			return Volume{}, fmt.Errorf("prepared system Skills volume: %w", err)
		}
		if !matchLabels(volume.Labels, skillVolumeLabels(prepared.Key)) {
			return Volume{}, deployment.ErrIdentityConflict
		}
		return workspace, nil
	}
	if _, err := d.engine.InspectVolume(ctx, d.config.SystemSkillsVolume); err != nil {
		return Volume{}, fmt.Errorf("system Skills volume: %w", err)
	}
	return workspace, nil
}

type resourceNames struct {
	container string
	workspace string
}

func (d *Driver) containerSpec(value deployment.Deployment, digest string, names resourceNames) (ContainerSpec, error) {
	runtimeSpec, err := json.Marshal(value.RuntimeSpec)
	if err != nil {
		return ContainerSpec{}, fmt.Errorf("encode RuntimeSpec: %w", err)
	}
	environment := map[string]string{"ANTNEST_RUNTIME_SPEC": string(runtimeSpec)}
	for key, raw := range d.config.RuntimeOTEL {
		environment[key] = raw
	}
	if value.RuntimeSpec.Authentication != nil {
		for key, raw := range d.config.RuntimeAuthentication {
			environment[key] = raw
		}
	}
	if value.ImageReference != "" {
		environment["ANTNEST_RUNTIME_IMAGE_REFERENCE"] = value.ImageReference
		environment["ANTNEST_RUNTIME_IMAGE_ID"] = value.ImageRef
	}
	port := strconv.FormatUint(uint64(value.RuntimeSpec.Listen.Port), 10)
	skillsVolume := d.config.SystemSkillsVolume
	skillsNoCopy := false
	if value.PreparedSkills != nil {
		skillsVolume = "antnest-prepared-skill-set"
		skillsNoCopy = true
		if value.PreparedMaterialization != nil {
			skillsVolume = value.PreparedMaterialization.VolumeName
		}
	}
	cpuMillis := value.Resources.EffectiveCPUMillis()
	backend := d.config.WorkspaceVolumeDriver
	if backend == "" {
		backend = "local"
	}
	spec := ContainerSpec{
		Name: names.container, Image: value.ImageRef, User: "0:0",
		Environment: environment,
		Labels: map[string]string{
			labelManaged: "runtime", labelScope: d.config.ControllerScope,
			labelAgentID:    value.RuntimeSpec.AgentID,
			labelGeneration: strconv.FormatUint(value.RuntimeSpec.Generation, 10),
			labelSpecDigest: digest, "io.antnest.runtime-port": port,
			"io.antnest.workspace-backend":      backend,
			"io.antnest.workspace-quota-option": d.config.WorkspaceQuotaOption,
			"io.antnest.workspace-bytes":        strconv.FormatUint(value.Resources.EffectiveWorkspaceBytes(), 10),
		},
		Mounts: map[string]Mount{
			value.RuntimeSpec.Filesystem.Workspace: {
				Source: names.workspace,
			},
			value.RuntimeSpec.Filesystem.SystemSkills: {
				Source: skillsVolume, ReadOnly: true, NoCopy: skillsNoCopy,
			},
			"/etc/resolv.conf": {
				Source:   resolverVolumeName(d.config.ControllerScope, value.RuntimeSpec.AgentID, value.RuntimeSpec.Generation),
				ReadOnly: true, NoCopy: true, Subpath: "resolv.conf",
			},
		},
		Capabilities: []string{
			"CHOWN", "DAC_OVERRIDE", "KILL", "NET_ADMIN", "SETGID", "SETPCAP", "SETUID",
		},
		DNS: []string{value.RuntimeSpec.Network.ResolverIPv4}, DNSOptions: []string{"use-vc"},
		Devices: []string{"/dev/net/tun"}, ReadOnlyRootFS: true,
		Tmpfs: map[string]string{
			"/tmp":         fmt.Sprintf("rw,noexec,nosuid,nodev,size=%d", value.Resources.TmpfsBytes),
			"/run/antnest": "rw,noexec,nosuid,nodev,size=16777216,mode=0700,uid=0,gid=0",
		},
		Networks:  []string{d.config.ManagementNetwork},
		PidsLimit: int64(value.Resources.PidsLimit), MemoryBytes: int64(value.Resources.MemoryBytes),
		NanoCPUs:      int64(cpuMillis) * 1000000,
		CPUShares:     max(int64(2), int64(cpuMillis)*1024/1000),
		StopTimeout:   d.config.StopGraceSeconds,
		SecurityOpt:   []string{"no-new-privileges=true", runtimeSeccompOption()},
		RestartPolicy: "unless-stopped",
		Healthcheck: Healthcheck{
			Test:          []string{"CMD", "curl", "--fail", "--silent", "http://127.0.0.1:" + port + "/status"},
			Interval:      10 * time.Second,
			Timeout:       2 * time.Second,
			StartPeriod:   30 * time.Second,
			StartInterval: 2 * time.Second,
			Retries:       3,
		},
	}
	if value.RuntimeSpec.Authentication != nil {
		spec.Mounts[instanceauth.Directory] = Mount{Source: instanceVolumeName(instanceauth.Identity{Scope: d.config.ControllerScope, AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation}), ReadOnly: true, NoCopy: true}
		spec.Healthcheck.Test = []string{"CMD", "curl", "--fail", "--silent", "http://127.0.0.1:" + port + "/status/live"}
	}
	if len(value.RuntimeSpec.MCPServers) > 0 {
		spec.Tmpfs["/run/antnest-mcp-home"] = fmt.Sprintf("rw,exec,nosuid,nodev,size=%d,mode=0711,uid=0,gid=0", value.Resources.TmpfsBytes)
	}
	if deployment.HasMCPSecrets(value.RuntimeSpec.MCPServers) {
		spec.Mounts[mcpSecretDirectory] = Mount{Source: mcpVolumeName(d.config.ControllerScope, deployment.Key{AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation}), ReadOnly: true, NoCopy: true}
	}

	return spec, nil
}

func (d *Driver) matches(container Container, key deployment.Key, digest string) bool {
	return d.matchesIdentity(container, key) &&
		container.Labels[labelSpecDigest] == digest
}

func (d *Driver) matchesIdentity(container Container, key deployment.Key) bool {
	return d.owns(container.Labels) &&
		container.Labels[labelAgentID] == key.AgentID &&
		container.Labels[labelGeneration] == strconv.FormatUint(key.Generation, 10)
}

func (d *Driver) owns(labels map[string]string) bool {
	return labels[labelManaged] == "runtime" && labels[labelScope] == d.config.ControllerScope
}

func observationKind(action string) (deployment.ObservationKind, bool) {
	switch strings.TrimSpace(action) {
	case "start", "health_status: starting":
		return deployment.ObservationStarting, true
	case "restart":
		return deployment.ObservationRestarted, true
	case "health_status: healthy":
		return deployment.ObservationHealthy, true
	case "health_status: unhealthy":
		return deployment.ObservationUnhealthy, true
	case "die", "stop", "kill":
		return deployment.ObservationExited, true
	case "destroy":
		return deployment.ObservationRuntimeDeleted, true
	default:
		return "", false
	}
}

func containerName(agentID string) string   { return "antnest-runtime-" + strings.TrimSpace(agentID) }
func workspaceVolume(agentID string) string { return "antnest-workspace-" + strings.TrimSpace(agentID) }

func resolverVolumeName(scope, agentID string, generation uint64) string {
	digest := instanceauth.Digest([]byte(strconv.Itoa(len(scope)) + ":" + scope + "\x00" + agentID + "\x00" + strconv.FormatUint(generation, 10)))
	return "antnest-runtime-resolver-" + digest[7:39]
}

func (d *Driver) workspaceLabels(agentID string) map[string]string {
	return map[string]string{
		labelManaged: "workspace", labelScope: d.config.ControllerScope, labelAgentID: agentID,
	}
}

func (d *Driver) workspaceOwned(volume Volume, agentID string) bool {
	return volume.Labels[labelManaged] == "workspace" &&
		volume.Labels[labelScope] == d.config.ControllerScope &&
		volume.Labels[labelAgentID] == agentID
}

func (d *Driver) DiskQuotaEnforced() bool {
	return d.config.WorkspaceVolumeDriver != ""
}

func requestedWorkspaceBytes(limits []deployment.ResourceLimits) uint64 {
	if len(limits) == 0 {
		return deployment.ResourceLimits{}.EffectiveWorkspaceBytes()
	}
	return limits[0].EffectiveWorkspaceBytes()
}

func (d *Driver) workspaceQuotaMatches(volume Volume, limits []deployment.ResourceLimits) error {
	if d.config.WorkspaceVolumeDriver == "" {
		if (volume.Driver != "" && volume.Driver != "local") || len(volume.Options) > 0 {
			return fmt.Errorf("workspace volume backend %q is not the default local driver", volume.Driver)
		}
		return nil
	}
	if volume.Driver != d.config.WorkspaceVolumeDriver {
		return fmt.Errorf("workspace volume driver %q does not match the configured quota backend", volume.Driver)
	}
	raw := volume.Labels["io.antnest.workspace-bytes"]
	declared, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || declared < 67108864 || declared > 1099511627776 {
		return errors.New("workspace volume byte limit label is missing or out of range")
	}
	if volume.Options[d.config.WorkspaceQuotaOption] != raw {
		return errors.New("workspace volume quota option does not match the declared byte limit")
	}
	if len(limits) > 0 && declared != limits[0].EffectiveWorkspaceBytes() {
		return errors.New("workspace volume byte limit differs from the requested resources")
	}
	return nil
}

func completed() deployment.EffectOutcome {
	return deployment.EffectOutcome{State: deployment.EffectCompleted}
}

func dockerFailure(code string, err error, sideEffectStarted bool) deployment.EffectOutcome {
	state := deployment.EffectNotStarted
	if sideEffectStarted || IsUncertain(err) {
		state = deployment.EffectUnknown
	}
	return failed(state, code, err)
}

func failed(state deployment.EffectState, code string, err error) deployment.EffectOutcome {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	return deployment.EffectOutcome{State: state, Code: code, Detail: detail, Cause: err}
}

type uncertainError struct{ cause error }

func (e uncertainError) Error() string { return e.cause.Error() }
func (e uncertainError) Unwrap() error { return e.cause }

func Uncertain(err error) error {
	if err == nil {
		return nil
	}
	return uncertainError{cause: err}
}

func IsUncertain(err error) bool {
	var target uncertainError
	return errors.As(err, &target)
}
