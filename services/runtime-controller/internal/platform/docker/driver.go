package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/platform"
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
	ControllerScope    string
	ManagementNetwork  string
	SystemSkillsVolume string
	RuntimeOTEL        map[string]string
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
	Health       string
	RestartCount uint64
	Labels       map[string]string
}

type Volume struct {
	Name   string
	Labels map[string]string
}

type Mount struct {
	Source   string
	ReadOnly bool
}

type Healthcheck struct {
	Test        []string
	Interval    time.Duration
	Timeout     time.Duration
	StartPeriod time.Duration
	Retries     int
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
	PidsLimit      int64
	MemoryBytes    int64
	RestartPolicy  string
	Healthcheck    Healthcheck
}

type Driver struct {
	engine Engine
	config Config
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
	return &Driver{engine: engine, config: config}, nil
}

func (d *Driver) Ready(ctx context.Context) error {
	if err := d.engine.Ping(ctx); err != nil {
		return err
	}
	if _, err := d.engine.ListManagedContainerIDs(ctx); err != nil {
		return err
	}
	if err := d.engine.InspectNetwork(ctx, d.config.ManagementNetwork); err != nil {
		return fmt.Errorf("inspect Runtime management network: %w", err)
	}
	if _, err := d.engine.InspectVolume(ctx, d.config.SystemSkillsVolume); err != nil {
		return fmt.Errorf("inspect system Skills volume: %w", err)
	}
	return nil
}

func (d *Driver) DeploymentDigest(value deployment.Deployment) (string, error) {
	key := deployment.Key{
		AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation,
	}
	if err := value.ValidateFor(key); err != nil {
		return "", err
	}
	spec, err := d.containerSpec(value, "")
	if err != nil {
		return "", err
	}
	delete(spec.Labels, labelSpecDigest)
	return deployment.DigestValue(struct {
		Revision uint32                 `json:"revision"`
		Platform string                 `json:"platform"`
		Name     string                 `json:"name"`
		Request  createContainerRequest `json:"request"`
	}{Revision: 1, Platform: "docker", Name: spec.Name, Request: dockerCreateRequest(spec)})
}

func (d *Driver) Create(
	ctx context.Context, value deployment.Deployment, digest string,
) deployment.EffectOutcome {
	key := deployment.Key{AgentID: value.RuntimeSpec.AgentID, Generation: value.RuntimeSpec.Generation}
	if err := value.ValidateFor(key); err != nil {
		return failed(deployment.EffectNotStarted, "invalid_request", err)
	}
	computed, err := d.DeploymentDigest(value)
	if err != nil || computed != digest {
		return failed(deployment.EffectNotStarted, "invalid_request", errors.New("deployment digest mismatch"))
	}
	if err := d.requireCreateStorage(ctx, key.AgentID); err != nil {
		switch {
		case errors.Is(err, deployment.ErrIdentityConflict):
			return failed(deployment.EffectNotStarted, "storage_ownership_conflict", err)
		case errors.Is(err, ErrNotFound):
			return failed(deployment.EffectNotStarted, "storage_not_found", err)
		default:
			return dockerFailure("platform_unavailable", err, false)
		}
	}

	name := containerName(key.AgentID)
	existing, err := d.engine.InspectContainer(ctx, name)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return dockerFailure("platform_unavailable", err, false)
	}
	if err == nil {
		return d.convergeContainer(ctx, existing, key, digest)
	}

	spec, err := d.containerSpec(value, digest)
	if err != nil {
		return failed(deployment.EffectNotStarted, "invalid_request", err)
	}
	containerID, err := d.engine.CreateContainer(ctx, spec)
	if err != nil {
		existing, inspectErr := d.engine.InspectContainer(ctx, name)
		if inspectErr == nil {
			return d.convergeContainer(ctx, existing, key, digest)
		}
		return dockerFailure(
			"platform_unavailable", errors.Join(err, inspectErr), errors.Is(err, ErrConflict),
		)
	}
	if err := d.engine.StartContainer(ctx, containerID); err != nil {
		existing, inspectErr := d.engine.InspectContainer(ctx, name)
		if inspectErr == nil && d.matches(existing, key, digest) && existing.Running {
			return completed()
		}
		return dockerFailure("platform_unavailable", errors.Join(err, inspectErr), true)
	}
	return completed()
}

func (d *Driver) convergeContainer(
	ctx context.Context, existing Container, key deployment.Key, digest string,
) deployment.EffectOutcome {
	if !d.matches(existing, key, digest) {
		return failed(
			deployment.EffectNotStarted,
			"runtime_drift",
			errors.New("managed Runtime has another immutable identity"),
		)
	}
	if existing.Running {
		return completed()
	}
	if err := d.engine.StartContainer(ctx, existing.ID); err != nil {
		current, inspectErr := d.engine.InspectContainer(ctx, existing.Name)
		if inspectErr == nil && d.matches(current, key, digest) && current.Running {
			return completed()
		}
		return dockerFailure("platform_unavailable", errors.Join(err, inspectErr), true)
	}
	return completed()
}

func (d *Driver) Inspect(
	ctx context.Context, key deployment.Key,
) (deployment.Inspection, error) {
	container, err := d.engine.InspectContainer(ctx, containerName(key.AgentID))
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
	container, err := d.engine.InspectContainer(ctx, containerName(key.AgentID))
	if errors.Is(err, ErrNotFound) {
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
		if err := d.engine.StopContainer(ctx, container.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return dockerFailure("platform_unavailable", err, true)
		}
	}
	if err := d.engine.RemoveContainer(ctx, container.ID); err != nil && !errors.Is(err, ErrNotFound) {
		return dockerFailure("platform_unavailable", err, true)
	}
	return completed()
}

func (d *Driver) EnsureStorage(ctx context.Context, agentID string) deployment.EffectOutcome {
	name := workspaceVolume(agentID)
	volume, err := d.engine.InspectVolume(ctx, name)
	if errors.Is(err, ErrNotFound) {
		createErr := d.engine.CreateVolume(ctx, name, d.workspaceLabels(agentID))
		volume, err = d.engine.InspectVolume(ctx, name)
		if err != nil {
			possiblyExists := createErr == nil || errors.Is(createErr, ErrConflict)
			return dockerFailure("platform_unavailable", errors.Join(createErr, err), possiblyExists)
		}
	}
	if err != nil {
		return dockerFailure("platform_unavailable", err, false)
	}
	if !d.workspaceOwnedBy(volume, agentID) {
		return failed(deployment.EffectNotStarted, "storage_ownership_conflict",
			errors.New("workspace volume ownership labels differ"))
	}
	return completed()
}

func (d *Driver) VerifyStorage(ctx context.Context, agentID string) deployment.EffectOutcome {
	if err := d.requireWorkspace(ctx, agentID); err != nil {
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
	name := workspaceVolume(agentID)
	volume, err := d.engine.InspectVolume(ctx, name)
	if errors.Is(err, ErrNotFound) {
		return completed()
	}
	if err != nil {
		return dockerFailure("platform_unavailable", err, false)
	}
	if !d.workspaceOwnedBy(volume, agentID) {
		return failed(deployment.EffectNotStarted, "storage_ownership_conflict",
			errors.New("workspace volume ownership labels differ"))
	}
	if err := d.engine.RemoveVolume(ctx, name); err != nil && !errors.Is(err, ErrNotFound) {
		return dockerFailure("platform_unavailable", err, true)
	}
	return completed()
}

func (d *Driver) List(ctx context.Context) ([]deployment.Inspection, error) {
	containers, err := d.engine.ListManagedContainers(ctx)
	if err != nil {
		return nil, err
	}
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
	if container.ID == "" || container.Name != containerName(key.AgentID) {
		return deployment.Inspection{}, fmt.Errorf("normalize managed Runtime container: resource identity is malformed")
	}
	port, err := strconv.ParseUint(container.Labels["io.antnest.runtime-port"], 10, 16)
	if err != nil || port == 0 {
		return deployment.Inspection{}, fmt.Errorf("normalize managed Runtime container: Runtime port is malformed")
	}
	phase := deployment.PhaseExited
	health := deployment.HealthUnknown
	if container.Running {
		phase = deployment.PhaseRunning
		switch container.Health {
		case "healthy":
			health = deployment.HealthHealthy
		case "starting":
			health = deployment.HealthStarting
		case "unhealthy":
			health = deployment.HealthUnhealthy
		}
	}
	base := "http://" + container.Name + ":" + strconv.FormatUint(port, 10)
	return deployment.Inspection{
		AgentID: key.AgentID, Generation: key.Generation,
		SpecDigest: digest, PlatformResourceID: container.ID,
		PlatformPhase: phase, Health: health, StatusEndpoint: base + "/status",
		MCPEndpoint: base + "/mcp", RestartCount: container.RestartCount,
		ObservedAt: time.Now().UTC(),
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

func (d *Driver) requireWorkspace(ctx context.Context, agentID string) error {
	workspace, err := d.engine.InspectVolume(ctx, workspaceVolume(agentID))
	if err != nil {
		return fmt.Errorf("workspace volume: %w", err)
	}
	if !d.workspaceOwnedBy(workspace, agentID) {
		return fmt.Errorf("workspace volume: %w", deployment.ErrIdentityConflict)
	}
	return nil
}

func (d *Driver) requireCreateStorage(ctx context.Context, agentID string) error {
	if err := d.requireWorkspace(ctx, agentID); err != nil {
		return err
	}
	if _, err := d.engine.InspectVolume(ctx, d.config.SystemSkillsVolume); err != nil {
		return fmt.Errorf("system Skills volume: %w", err)
	}
	return nil
}

func (d *Driver) containerSpec(value deployment.Deployment, digest string) (ContainerSpec, error) {
	runtimeSpec, err := json.Marshal(value.RuntimeSpec)
	if err != nil {
		return ContainerSpec{}, fmt.Errorf("encode RuntimeSpec: %w", err)
	}
	environment := map[string]string{"ANTNEST_RUNTIME_SPEC": string(runtimeSpec)}
	for key, raw := range d.config.RuntimeOTEL {
		environment[key] = raw
	}
	port := strconv.FormatUint(uint64(value.RuntimeSpec.Listen.Port), 10)
	return ContainerSpec{
		Name: containerName(value.RuntimeSpec.AgentID), Image: value.ImageRef, User: "0:0",
		Environment: environment,
		Labels: map[string]string{
			labelManaged: "runtime", labelScope: d.config.ControllerScope,
			labelAgentID:    value.RuntimeSpec.AgentID,
			labelGeneration: strconv.FormatUint(value.RuntimeSpec.Generation, 10),
			labelSpecDigest: digest, "io.antnest.runtime-port": port,
		},
		Mounts: map[string]Mount{
			value.RuntimeSpec.Filesystem.Workspace: {
				Source: workspaceVolume(value.RuntimeSpec.AgentID),
			},
			value.RuntimeSpec.Filesystem.SystemSkills: {
				Source: d.config.SystemSkillsVolume, ReadOnly: true,
			},
		},
		Capabilities: []string{
			"CHOWN", "DAC_OVERRIDE", "KILL", "NET_ADMIN", "SETGID", "SETPCAP", "SETUID",
		},
		DNS: []string{value.RuntimeSpec.Network.ResolverIPv4}, DNSOptions: []string{"use-vc"},
		Devices: []string{"/dev/net/tun"}, ReadOnlyRootFS: false,
		Tmpfs: map[string]string{
			"/tmp": fmt.Sprintf("rw,exec,nosuid,nodev,size=%d", value.Resources.TmpfsBytes),
		},
		Networks:  []string{d.config.ManagementNetwork},
		PidsLimit: int64(value.Resources.PidsLimit), MemoryBytes: int64(value.Resources.MemoryBytes),
		RestartPolicy: "unless-stopped",
		Healthcheck: Healthcheck{
			Test:     []string{"CMD", "curl", "--fail", "--silent", "http://127.0.0.1:" + port + "/status"},
			Interval: 2 * time.Second, Timeout: 2 * time.Second, StartPeriod: 2 * time.Second, Retries: 15,
		},
	}, nil
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

func (d *Driver) workspaceLabels(agentID string) map[string]string {
	return map[string]string{
		labelManaged: "workspace", labelScope: d.config.ControllerScope, labelAgentID: agentID,
	}
}

func (d *Driver) workspaceOwnedBy(volume Volume, agentID string) bool {
	return volume.Name == workspaceVolume(agentID) &&
		volume.Labels[labelManaged] == "workspace" &&
		volume.Labels[labelScope] == d.config.ControllerScope &&
		volume.Labels[labelAgentID] == agentID
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
