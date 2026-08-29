package dockerengine

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"

	"soft/antnest-platform/services/runtime-provider-docker/internal/protocol"
)

const (
	labelAgentID       = "io.antnest.agent-id"
	labelGeneration    = "io.antnest.runtime-generation"
	labelInstanceID    = "io.antnest.runtime-instance-id"
	systemSkillsVolume = "antnest-system-skills"
)

var ErrNotFound = errors.New("docker resource was not found")

type Engine interface {
	InspectContainer(context.Context, string) (Container, error)
	EnsureVolume(context.Context, string) error
	CreateContainer(context.Context, ContainerSpec) (string, error)
	StartContainer(context.Context, string) error
	StopContainer(context.Context, string) error
	RemoveContainer(context.Context, string) error
	RemoveVolume(context.Context, string) error
}

type Container struct {
	ID      string
	Name    string
	Running bool
	Labels  map[string]string
}

type Mount struct {
	Source   string
	ReadOnly bool
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
}

type Driver struct {
	engine Engine
}

func NewDriver(engine Engine) (*Driver, error) {
	if engine == nil {
		return nil, fmt.Errorf("Docker engine is required")
	}
	return &Driver{engine: engine}, nil
}

func (d *Driver) Ensure(
	ctx context.Context, request protocol.EnsureRequest,
) (result protocol.DriverResult) {
	if err := validateEnsureRequest(request); err != nil {
		return failed(protocol.EffectNotStarted, "invalid_runtime_spec", err)
	}
	name := containerName(request.AgentID)
	existing, err := d.engine.InspectContainer(ctx, name)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return driverError("inspect_failed", err, false)
	}
	if err == nil && matches(existing, request) {
		if existing.Running {
			return completed(existing.ID)
		}
		if err := d.engine.StartContainer(ctx, existing.ID); err != nil {
			return driverError("start_failed", err, true)
		}
		return completed(existing.ID)
	}
	if err == nil {
		if existing.Running {
			if err := d.engine.StopContainer(ctx, existing.ID); err != nil && !errors.Is(err, ErrNotFound) {
				return driverError("replace_stop_failed", err, true)
			}
		}
		if err := d.engine.RemoveContainer(ctx, existing.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return driverError("replace_remove_failed", err, true)
		}
	}

	workspace := workspaceVolume(request.AgentID)
	if err := d.engine.EnsureVolume(ctx, workspace); err != nil {
		return driverError("workspace_failed", err, false)
	}
	if err := d.engine.EnsureVolume(ctx, systemSkillsVolume); err != nil {
		return driverError("system_skills_failed", err, false)
	}
	containerID, err := d.engine.CreateContainer(ctx, containerSpec(request, name, workspace))
	if err != nil {
		return driverError("create_failed", err, false)
	}
	if err := d.engine.StartContainer(ctx, containerID); err != nil {
		return driverError("start_failed", err, true)
	}
	return completed(containerID)
}

func (d *Driver) Stop(ctx context.Context, target protocol.RuntimeTarget) protocol.DriverResult {
	container, err := d.resolveTarget(ctx, target)
	if errors.Is(err, ErrNotFound) {
		return completed("")
	}
	if err != nil {
		return driverError("inspect_failed", err, false)
	}
	if container.Running {
		if err := d.engine.StopContainer(ctx, container.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return driverError("stop_failed", err, true)
		}
	}
	return completed(container.ID)
}

func (d *Driver) Remove(
	ctx context.Context, target protocol.RuntimeTarget, purgeWorkspace bool,
) protocol.DriverResult {
	container, err := d.resolveTarget(ctx, target)
	if err != nil && !errors.Is(err, ErrNotFound) {
		return driverError("inspect_failed", err, false)
	}
	if err == nil {
		if container.Running {
			if err := d.engine.StopContainer(ctx, container.ID); err != nil && !errors.Is(err, ErrNotFound) {
				return driverError("stop_failed", err, true)
			}
		}
		if err := d.engine.RemoveContainer(ctx, container.ID); err != nil && !errors.Is(err, ErrNotFound) {
			return driverError("remove_failed", err, true)
		}
	}
	if purgeWorkspace {
		if err := d.engine.RemoveVolume(ctx, workspaceVolume(target.AgentID)); err != nil && !errors.Is(err, ErrNotFound) {
			return driverError("workspace_purge_failed", err, true)
		}
	}
	return completed(target.ContainerID)
}

func (d *Driver) resolveTarget(
	ctx context.Context, target protocol.RuntimeTarget,
) (Container, error) {
	identifier := strings.TrimSpace(target.ContainerID)
	if identifier == "" {
		identifier = containerName(target.AgentID)
	}
	return d.engine.InspectContainer(ctx, identifier)
}

func validateEnsureRequest(request protocol.EnsureRequest) error {
	if protocol.ValidateAgentID(request.AgentID) != nil || request.Generation == 0 ||
		strings.TrimSpace(request.RuntimeInstanceID) == "" || strings.TrimSpace(request.ImageRef) == "" ||
		request.NetworkPolicyEpoch == 0 || request.AllocatorEpoch == 0 ||
		strings.TrimSpace(request.AdvertisedEndpoint) == "" || strings.TrimSpace(request.EgressEndpoint) == "" ||
		strings.TrimSpace(request.ManagementNetwork) == "" ||
		len(request.BootstrapToken) < 32 {
		return fmt.Errorf("runtime identity, image, networks, endpoint, and token are required")
	}
	if request.NetworkMode != protocol.NetworkRestricted && request.NetworkMode != protocol.NetworkUnrestricted {
		return fmt.Errorf("runtime network mode is invalid")
	}
	for name, raw := range map[string]string{"tunnel IPv4": request.TunnelIPv4, "DNS IPv4": request.DNSIPv4} {
		address, err := netip.ParseAddr(strings.TrimSpace(raw))
		if err != nil || !address.Is4() || address.IsUnspecified() {
			return fmt.Errorf("%s must be usable IPv4", name)
		}
	}
	return nil
}

func matches(container Container, request protocol.EnsureRequest) bool {
	return container.Labels[labelAgentID] == request.AgentID &&
		container.Labels[labelGeneration] == strconv.FormatUint(request.Generation, 10) &&
		container.Labels[labelInstanceID] == request.RuntimeInstanceID
}

func containerSpec(
	request protocol.EnsureRequest, name, workspace string,
) ContainerSpec {
	return ContainerSpec{
		Name: name, Image: request.ImageRef, User: "0:0", ReadOnlyRootFS: true,
		Environment: map[string]string{
			"HOME":                                "/workspace",
			"ANTNEST_RUNTIME_INSTANCE_ID":         request.RuntimeInstanceID,
			"ANTNEST_RUNTIME_GENERATION":          strconv.FormatUint(request.Generation, 10),
			"ANTNEST_RUNTIME_ADMISSION_TOKEN":     request.BootstrapToken,
			"ANTNEST_RUNTIME_ADVERTISED_ENDPOINT": request.AdvertisedEndpoint,
			"ANTNEST_RUNTIME_EGRESS_ENDPOINT":     request.EgressEndpoint,
			"ANTNEST_RUNTIME_TUNNEL_IPV4":         request.TunnelIPv4,
			"ANTNEST_RUNTIME_DNS_IPV4":            request.DNSIPv4,
		},
		Labels: map[string]string{
			labelAgentID:    request.AgentID,
			labelGeneration: strconv.FormatUint(request.Generation, 10),
			labelInstanceID: request.RuntimeInstanceID,
		},
		Mounts: map[string]Mount{
			"/workspace": {Source: workspace},
			"/skills":    {Source: systemSkillsVolume, ReadOnly: true},
		},
		Capabilities: []string{"NET_ADMIN", "SETUID", "SETGID", "SETPCAP"},
		DNS:          []string{request.DNSIPv4},
		DNSOptions:   []string{"use-vc"},
		Devices:      []string{"/dev/net/tun"},
		Tmpfs:        map[string]string{"/tmp": "rw,exec,nosuid,nodev,size=536870912"},
		Networks:     []string{request.ManagementNetwork},
		PidsLimit:    512, MemoryBytes: 2 << 30,
	}
}

func containerName(agentID string) string   { return "antnest-runtime-" + strings.TrimSpace(agentID) }
func workspaceVolume(agentID string) string { return "antnest-workspace-" + strings.TrimSpace(agentID) }

func completed(containerID string) protocol.DriverResult {
	return protocol.DriverResult{
		Outcome: protocol.EffectOutcome{State: protocol.EffectCompleted}, ContainerID: containerID,
	}
}

func driverError(code string, err error, sideEffectStarted bool) protocol.DriverResult {
	state := protocol.EffectNotStarted
	if sideEffectStarted || IsUncertain(err) {
		state = protocol.EffectUnknown
	}
	return failed(state, code, err)
}

func failed(state protocol.EffectState, code string, err error) protocol.DriverResult {
	detail := ""
	if err != nil {
		detail = err.Error()
	}
	return protocol.DriverResult{Outcome: protocol.EffectOutcome{State: state, Code: code, Detail: detail}}
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
	var uncertain uncertainError
	return errors.As(err, &uncertain)
}
