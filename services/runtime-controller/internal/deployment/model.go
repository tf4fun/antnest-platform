package deployment

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/netip"
	"path"
	"slices"
	"strings"
	"time"

	"github.com/distribution/reference"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/instanceauth"
	"github.com/tf4fun/antnest-platform/services/runtime-controller/internal/skillset"
)

var (
	ErrInvalid          = errors.New("invalid Runtime deployment")
	ErrIdentityConflict = errors.New("runtime identity conflict")
	ErrStatusUnverified = errors.New("runtime status could not be verified")
)

type Key struct {
	AgentID    string `json:"agent_id"`
	Generation uint64 `json:"generation"`
}

func (k Key) Validate() error {
	if err := validateIdentifier("agent_id", k.AgentID); err != nil {
		return err
	}
	if k.Generation == 0 {
		return invalid("generation must be positive")
	}
	if k.Generation > math.MaxInt64 {
		return invalid("generation exceeds the supported persistence range")
	}
	return nil
}

type Deployment struct {
	ManagedMCPTemplate      *MCPTemplateSource                `json:"managed_mcp_template,omitempty"`
	InstanceAuthentication  *instanceauth.Record              `json:"-"`
	ImageReference          string                            `json:"image_reference,omitempty"`
	ImageRef                string                            `json:"image_ref"`
	RuntimeSpec             RuntimeSpec                       `json:"runtime_spec"`
	Resources               ResourceLimits                    `json:"resources"`
	PreparedSkills          *skillset.PreparedReference       `json:"prepared_skills,omitempty"`
	PreparedMaterialization *skillset.PreparedMaterialization `json:"-"`
}

// Configuration is the caller-owned policy input. Deployment identity and
// Runtime image invariants are injected by Runtime Controller.
type Configuration struct {
	ManagedMCPTemplate  *MCPTemplateSource     `json:"managed_mcp_template,omitempty"`
	MCPServers          []MCPServer            `json:"mcp_servers,omitempty"`
	ImageRef            string                 `json:"image_ref"`
	Network             NetworkSpec            `json:"network"`
	Resources           ResourceLimits         `json:"resources"`
	OrganizationID      string                 `json:"organization_id,omitempty"`
	SystemSkills        []skillset.FrozenSkill `json:"system_skills,omitempty"`
	PreparedSkillSet    *skillset.PreparedSet  `json:"prepared_skill_set,omitempty"`
	PreparedReferenceID string                 `json:"prepared_reference_id,omitempty"`
	SkillScope          string                 `json:"-"`
}

func (c Configuration) Resolve(agentID string, generation uint64) (Deployment, error) {
	if err := c.validatePreparedSkills(); err != nil {
		return Deployment{}, err
	}
	value := Deployment{
		ImageRef: c.ImageRef,
		RuntimeSpec: RuntimeSpec{
			MCPServers: CloneMCPServers(c.MCPServers),
			AgentID:    agentID, Generation: generation,
			Listen:     SocketAddress{Host: "0.0.0.0", Port: 8093},
			Network:    c.Network,
			Filesystem: FilesystemSpec{Workspace: "/workspace", SystemSkills: "/skills"},
		},
		Resources: c.Resources,
	}
	if c.ManagedMCPTemplate != nil {
		source := *c.ManagedMCPTemplate
		value.ManagedMCPTemplate = &source
	}
	if c.PreparedSkillSet != nil {
		value.PreparedSkills = &skillset.PreparedReference{Scope: c.SkillScope, OrganizationID: c.OrganizationID, AgentID: agentID,
			SkillSetDigest: c.PreparedSkillSet.SkillSetDigest, LayoutVersion: c.PreparedSkillSet.LayoutVersion,
			ReferenceID: c.PreparedReferenceID, SystemSkills: slices.Clone(c.SystemSkills)}
	}
	if err := value.ValidateFor(Key{AgentID: agentID, Generation: generation}); err != nil {
		return Deployment{}, err
	}
	return value, nil
}

func (c Configuration) validatePreparedSkills() error {
	if c.OrganizationID == "" && c.SystemSkills == nil && c.PreparedSkillSet == nil && c.PreparedReferenceID == "" {
		return nil
	}
	if c.OrganizationID == "" || c.SystemSkills == nil || c.PreparedSkillSet == nil || len(c.PreparedReferenceID) != 36 || !strings.HasPrefix(c.PreparedReferenceID, "psr_") {
		return invalid("complete prepared Skill set identity is required")
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(c.PreparedReferenceID, "psr_")); err != nil {
		return invalid("prepared_reference_id is invalid")
	}
	digest, err := skillset.Digest(c.OrganizationID, c.PreparedSkillSet.LayoutVersion, c.SystemSkills)
	if err != nil || digest != c.PreparedSkillSet.SkillSetDigest {
		return invalid("prepared Skill set differs from frozen metadata")
	}
	return nil
}

func (c Configuration) Validate() error {
	_, err := c.Resolve("validation-probe", 1)
	return err
}

type RuntimeSpec struct {
	Authentication            *RuntimeAuthentication `json:"authentication,omitempty"`
	MCPServers                []MCPServer            `json:"mcp_servers,omitempty"`
	SkillMaintenanceVerifiers *MaintenanceVerifiers  `json:"skill_maintenance_verifiers,omitempty"`
	AgentID                   string                 `json:"agent_id"`
	Generation                uint64                 `json:"generation"`
	Listen                    SocketAddress          `json:"listen"`
	Network                   NetworkSpec            `json:"network"`
	Filesystem                FilesystemSpec         `json:"filesystem"`
}

// RuntimeAuthentication is nonsecret bootstrap identity. Bearers never enter RuntimeSpec.
type RuntimeAuthentication struct {
	ConnectionID   string `json:"connection_id"`
	CallersFile    string `json:"callers_file"`
	ReceiverDigest string `json:"receiver_digest"`
}

type SocketAddress struct {
	Host string `json:"host"`
	Port uint16 `json:"port"`
}

type IPv4Endpoint struct {
	IPv4 string `json:"ipv4"`
	Port uint16 `json:"port"`
}

type NetworkSpec struct {
	PacketContractRevision uint32       `json:"packet_contract_revision"`
	EgressEndpoint         IPv4Endpoint `json:"egress_endpoint"`
	TunnelIPv4             string       `json:"tunnel_ipv4"`
	ResolverIPv4           string       `json:"resolver_ipv4"`
}

type FilesystemSpec struct {
	Workspace    string `json:"workspace"`
	SystemSkills string `json:"system_skills"`
}

type ResourceLimits struct {
	MemoryBytes uint64 `json:"memory_bytes"`
	PidsLimit   uint32 `json:"pids_limit"`
	TmpfsBytes  uint64 `json:"tmpfs_bytes"`
}

func (d Deployment) ValidateFor(key Key) error {
	if err := key.Validate(); err != nil {
		return err
	}
	if !validImageRef(d.ImageRef) {
		return invalid("image_ref must be a valid image name, tag, or digest reference")
	}
	if d.RuntimeSpec.AgentID != key.AgentID || d.RuntimeSpec.Generation != key.Generation {
		return invalid("path identity and runtime_spec identity differ")
	}
	if auth := d.RuntimeSpec.Authentication; auth != nil {
		if !instanceauth.ValidConnectionID(auth.ConnectionID) || auth.CallersFile != instanceauth.CallersFile || ValidateDigest(auth.ReceiverDigest) != nil {
			return invalid("authentication bootstrap identity is invalid")
		}
	}
	if err := validateSocketAddress("listen", d.RuntimeSpec.Listen); err != nil {
		return err
	}
	if err := d.RuntimeSpec.Network.validate(); err != nil {
		return err
	}
	if err := d.RuntimeSpec.Filesystem.validate(); err != nil {
		return err
	}
	if err := validateMCPServers(d.RuntimeSpec.MCPServers); err != nil {
		return err
	}
	if HasMCPSecrets(d.RuntimeSpec.MCPServers) {
		if err := d.ManagedMCPTemplate.Validate(); err != nil {
			return err
		}
	} else if d.ManagedMCPTemplate != nil {
		return invalid("managed MCP Template source without secrets")
	}
	if verifiers := d.RuntimeSpec.SkillMaintenanceVerifiers; verifiers != nil {
		canonical, err := verifiers.Normalize()
		if err != nil {
			return err
		}
		if !slices.Equal(verifiers.Keys, canonical.Keys) {
			return invalid("skill_maintenance_verifiers keys must be sorted by kid")
		}
	}
	if d.Resources.MemoryBytes < 128<<20 {
		return invalid("resources.memory_bytes must be at least 134217728")
	}
	if d.Resources.MemoryBytes > math.MaxInt64 {
		return invalid("resources.memory_bytes exceeds the deployment platform range")
	}
	if d.Resources.PidsLimit < 16 || d.Resources.PidsLimit > 32768 {
		return invalid("resources.pids_limit must be between 16 and 32768")
	}
	if d.Resources.TmpfsBytes < 16<<20 {
		return invalid("resources.tmpfs_bytes must be at least 16777216")
	}
	if d.Resources.TmpfsBytes > math.MaxInt64 {
		return invalid("resources.tmpfs_bytes exceeds the deployment platform range")
	}
	return nil
}

func DigestValue(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", fmt.Errorf("encode digest input: %w", err)
	}
	digest := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(digest[:]), nil
}

func (n NetworkSpec) validate() error {
	if n.PacketContractRevision != 1 {
		return invalid("network.packet_contract_revision must be 1")
	}
	if err := validateIPv4Endpoint("network.egress_endpoint", n.EgressEndpoint); err != nil {
		return err
	}
	tunnel, err := parseUsableIPv4("network.tunnel_ipv4", n.TunnelIPv4)
	if err != nil {
		return err
	}
	resolver, err := parseUsableIPv4("network.resolver_ipv4", n.ResolverIPv4)
	if err != nil {
		return err
	}
	if tunnel == resolver {
		return invalid("network tunnel and resolver addresses must differ")
	}
	return nil
}

func (f FilesystemSpec) validate() error {
	workspace, err := normalizedAbsolutePath("filesystem.workspace", f.Workspace)
	if err != nil {
		return err
	}
	skills, err := normalizedAbsolutePath("filesystem.system_skills", f.SystemSkills)
	if err != nil {
		return err
	}
	if rootsOverlap(workspace, skills) {
		return invalid("filesystem roots must not overlap")
	}
	return nil
}

func normalizedAbsolutePath(name, value string) (string, error) {
	if value == "" || !strings.HasPrefix(value, "/") || path.Clean(value) != value {
		return "", invalid(name + " must be a normalized absolute path")
	}
	return value, nil
}

func rootsOverlap(left, right string) bool {
	if left == right || left == "/" || right == "/" {
		return true
	}
	return strings.HasPrefix(left, right+"/") || strings.HasPrefix(right, left+"/")
}

func validateSocketAddress(name string, value SocketAddress) error {
	if strings.TrimSpace(value.Host) != "0.0.0.0" {
		return invalid(name + ".host must be 0.0.0.0")
	}
	if value.Port == 0 {
		return invalid(name + ".port must be positive")
	}
	return nil
}

func validImageRef(value string) bool {
	if value == "" || len(value) > 512 || value != strings.TrimSpace(value) {
		return false
	}
	_, err := reference.ParseAnyReference(value)
	return err == nil
}

func ValidateDigest(value string) error {
	if !strings.HasPrefix(value, "sha256:") {
		return invalid("digest must use sha256")
	}
	hexDigest := strings.TrimPrefix(value, "sha256:")
	if len(hexDigest) != 64 {
		return invalid("digest must contain 64 hexadecimal characters")
	}
	for _, character := range []byte(hexDigest) {
		if character >= '0' && character <= '9' ||
			character >= 'a' && character <= 'f' || character >= 'A' && character <= 'F' {
			continue
		}
		return invalid("digest must contain only hexadecimal characters")
	}
	return nil
}

func validateIPv4Endpoint(name string, value IPv4Endpoint) error {
	if _, err := parseUsableIPv4(name+".ipv4", value.IPv4); err != nil {
		return err
	}
	if value.Port == 0 {
		return invalid(name + ".port must be positive")
	}
	return nil
}

func parseUsableIPv4(name, value string) (netip.Addr, error) {
	address, err := netip.ParseAddr(strings.TrimSpace(value))
	if err != nil || !address.Is4() || !address.IsGlobalUnicast() {
		return netip.Addr{}, invalid(name + " must be a usable IPv4 address")
	}
	return address, nil
}

func validateIdentifier(name, value string) error {
	if value == "" || len(value) > 200 {
		return invalid(name + " must contain 1-200 deployment-safe ASCII bytes")
	}
	for index, character := range []byte(value) {
		letter := character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z'
		digit := character >= '0' && character <= '9'
		if letter || digit || index > 0 && (character == '_' || character == '.' || character == '-') {
			continue
		}
		return invalid(name + " must start with an alphanumeric byte and contain only alphanumeric, '_', '.', or '-'")
	}
	return nil
}

func invalid(message string) error {
	return fmt.Errorf("%w: %s", ErrInvalid, message)
}

type EffectState string

const (
	EffectCompleted  EffectState = "completed"
	EffectNotStarted EffectState = "not_started"
	EffectUnknown    EffectState = "unknown"
)

type EffectOutcome struct {
	State  EffectState `json:"state"`
	Code   string      `json:"code,omitempty"`
	Detail string      `json:"detail,omitempty"`
	Cause  error       `json:"-"`
}

func (o EffectOutcome) Validate() error {
	switch o.State {
	case EffectCompleted:
		if o.Code != "" || o.Detail != "" {
			return invalid("completed effect cannot carry an error")
		}
	case EffectNotStarted, EffectUnknown:
		if strings.TrimSpace(o.Code) == "" {
			return invalid("non-completed effect requires an error code")
		}
	default:
		return invalid("unknown effect state")
	}
	return nil
}

type PlatformPhase string

const (
	PhaseAbsent  PlatformPhase = "absent"
	PhaseCreated PlatformPhase = "created"
	PhaseRunning PlatformPhase = "running"
	PhaseExited  PlatformPhase = "exited"
	PhaseUnknown PlatformPhase = "unknown"
)

type HealthState string

const (
	HealthAbsent    HealthState = "absent"
	HealthStarting  HealthState = "starting"
	HealthHealthy   HealthState = "healthy"
	HealthUnhealthy HealthState = "unhealthy"
	HealthUnknown   HealthState = "unknown"
)

type RuntimeRevision string

func RevisionFor(requestID, requestDigest string) RuntimeRevision {
	digest := sha256.Sum256([]byte("antnest-runtime-revision-v1\x00" + requestID + "\x00" + requestDigest))
	return RuntimeRevision("rtv_" + hex.EncodeToString(digest[:16]))
}

func ValidateRevision(value RuntimeRevision) error {
	raw := string(value)
	if len(raw) != 36 || !strings.HasPrefix(raw, "rtv_") {
		return invalid("runtime_revision is malformed")
	}
	if _, err := hex.DecodeString(raw[4:]); err != nil {
		return invalid("runtime_revision is malformed")
	}
	return nil
}

type LifecycleState string

const (
	LifecycleUninitialized LifecycleState = "uninitialized"
	LifecycleInitializing  LifecycleState = "initializing"
	LifecycleProvisioned   LifecycleState = "provisioned"
	LifecycleUpdating      LifecycleState = "updating"
	LifecycleDisabling     LifecycleState = "disabling"
	LifecycleDisabled      LifecycleState = "disabled"
	LifecycleEnabling      LifecycleState = "enabling"
	LifecycleDeleting      LifecycleState = "deleting"
	LifecycleDeleted       LifecycleState = "deleted"
	LifecycleFailed        LifecycleState = "failed"
	LifecycleUnknown       LifecycleState = "unknown"
)

func LifecycleTransition(kind OperationKind, from LifecycleState) (LifecycleState, LifecycleState, error) {
	switch kind {
	case OperationInitializeRuntime:
		if from == LifecycleUninitialized {
			return LifecycleInitializing, LifecycleProvisioned, nil
		}
	case OperationUpdateRuntime:
		if from == LifecycleProvisioned {
			return LifecycleUpdating, LifecycleProvisioned, nil
		}
	case OperationDisableRuntime:
		if from == LifecycleProvisioned {
			return LifecycleDisabling, LifecycleDisabled, nil
		}
	case OperationEnableRuntime:
		if from == LifecycleDisabled {
			return LifecycleEnabling, LifecycleProvisioned, nil
		}
	case OperationDeleteRuntime:
		if from == LifecycleProvisioned || from == LifecycleDisabled || from == LifecycleFailed {
			return LifecycleDeleting, LifecycleDeleted, nil
		}
	}
	return "", "", invalid(fmt.Sprintf("%s is not valid from lifecycle state %s", kind, from))
}

type Inspection struct {
	Reason             string        `json:"-"`
	DiagnosticSummary  string        `json:"-"`
	AgentID            string        `json:"-"`
	Generation         uint64        `json:"-"`
	SpecDigest         string        `json:"-"`
	PlatformResourceID string        `json:"-"`
	PlatformPhase      PlatformPhase `json:"-"`
	Health             HealthState   `json:"-"`
	MCPEndpoint        string        `json:"-"`
	RuntimeExecutionID string        `json:"-"`
	RestartCount       uint64        `json:"-"`
	ObservedAt         time.Time     `json:"-"`
	StatusEndpoint     string        `json:"-"`
}

func (i Inspection) RuntimeKey() Key {
	return Key{AgentID: i.AgentID, Generation: i.Generation}
}

type Environment struct {
	Phase              PlatformPhase
	Reason             string
	DiagnosticSummary  string
	AgentID            string
	RuntimeRevision    RuntimeRevision
	LifecycleState     LifecycleState
	Health             HealthState
	MCPEndpoint        string
	RuntimeExecutionID string
	RestartCount       uint64
	ObservedAt         time.Time

	Generation  uint64
	SpecDigest  string
	OperationID string
}

func (e Environment) RuntimeKey() (Key, bool) {
	key := Key{AgentID: e.AgentID, Generation: e.Generation}
	return key, key.Validate() == nil
}

func (e Environment) WithInspection(value Inspection) Environment {
	e.Phase = value.PlatformPhase
	e.Reason, e.DiagnosticSummary = value.Reason, value.DiagnosticSummary
	e.Health = value.Health
	e.MCPEndpoint = value.MCPEndpoint
	e.RuntimeExecutionID = value.RuntimeExecutionID
	e.RestartCount = value.RestartCount
	e.ObservedAt = value.ObservedAt
	return e
}

type OperationKind string

const (
	OperationInitializeRuntime OperationKind = "initialize_runtime"
	OperationUpdateRuntime     OperationKind = "update_runtime"
	OperationDisableRuntime    OperationKind = "disable_runtime"
	OperationEnableRuntime     OperationKind = "enable_runtime"
	OperationDeleteRuntime     OperationKind = "delete_runtime"
)

type OperationState string

const (
	OperationRunning   OperationState = "running"
	OperationCompleted OperationState = "completed"
	OperationFailed    OperationState = "failed"
	OperationUnknown   OperationState = "unknown"
)

type Operation struct {
	InstanceAuthentication *instanceauth.Record `json:"-"`
	ImageReference         string
	ImageID                string
	MaintenanceVerifiers   *MaintenanceVerifiers
	RequestID              string
	RequestDigest          string
	Kind                   OperationKind
	AgentID                string
	RuntimeRevision        RuntimeRevision
	State                  OperationState
	Effect                 EffectState
	Inspection             *Environment
	ErrorCode              string
	ErrorDetail            string
	CreatedAt              time.Time
	UpdatedAt              time.Time

	Attempt                 uint64
	ExpectedRevision        RuntimeRevision
	SourceState             LifecycleState
	SourceRevision          RuntimeRevision
	SourceGeneration        uint64
	SourceSpecDigest        string
	Generation              uint64
	SpecDigest              string
	Transition              LifecycleState
	PreparedReference       *skillset.PreparedReference
	PreparedSetID           int64
	PreparedVolumeName      string
	PreparedMaterialization int64
	PreparedManifestDigest  string
	PreparedReferenceID     string
}

func (o Operation) RuntimeKey() Key {
	return Key{AgentID: o.AgentID, Generation: o.Generation}
}

func (o Operation) SourceKey() (Key, bool) {
	key := Key{AgentID: o.AgentID, Generation: o.SourceGeneration}
	return key, key.Validate() == nil
}

func (o Operation) SuccessState() (LifecycleState, error) {
	_, success, err := LifecycleTransition(o.Kind, o.SourceState)
	return success, err
}

func (o Operation) CreatesCompute() bool {
	return o.Kind == OperationInitializeRuntime || o.Kind == OperationUpdateRuntime || o.Kind == OperationEnableRuntime
}

type ObservationKind string

const (
	ObservationInitialized      ObservationKind = "initialized"
	ObservationUpdated          ObservationKind = "updated"
	ObservationDisabled         ObservationKind = "disabled"
	ObservationEnabled          ObservationKind = "enabled"
	ObservationHealthy          ObservationKind = "healthy"
	ObservationStarting         ObservationKind = "starting"
	ObservationUnhealthy        ObservationKind = "unhealthy"
	ObservationRestarted        ObservationKind = "restarted"
	ObservationExited           ObservationKind = "exited"
	ObservationDeleted          ObservationKind = "deleted"
	ObservationRuntimeDeleted   ObservationKind = "runtime_deleted"
	ObservationStorageMissing   ObservationKind = "storage_missing"
	ObservationStorageDrift     ObservationKind = "storage_drift"
	ObservationGap              ObservationKind = "observation_gap"
	ObservationReconciled       ObservationKind = "reconciled"
	ObservationStatusUnverified ObservationKind = "status_unverified"
	ObservationRuntimeMissing   ObservationKind = "runtime_missing"
)

type Observation struct {
	Sequence           uint64
	AgentID            string
	RuntimeRevision    RuntimeRevision
	RuntimeExecutionID string
	Kind               ObservationKind
	DiagnosticSummary  string
	ObservedAt         time.Time

	Generation         uint64
	SpecDigest         string
	PlatformResourceID string
	Source             string
}

// ObservationWindow is one consistent view of the retained journal and its
// sequence bounds. Sequence zero means the journal is currently empty.
type ObservationWindow struct {
	Observations   []Observation
	OldestSequence uint64
	LatestSequence uint64
}

func (o Observation) RuntimeKey() (Key, bool) {
	if observationScope(o.Kind) != observationRuntime {
		return Key{}, false
	}
	key := Key{AgentID: o.AgentID, Generation: o.Generation}
	return key, key.Validate() == nil
}

func (o Observation) Validate() error {
	if strings.TrimSpace(o.Source) == "" || o.ObservedAt.IsZero() {
		return invalid("observation source and observed_at are required")
	}
	switch observationScope(o.Kind) {
	case observationService:
		if o.AgentID != "" || o.RuntimeRevision != "" || o.Generation != 0 || o.SpecDigest != "" ||
			o.PlatformResourceID != "" || o.RuntimeExecutionID != "" {
			return invalid("service-wide observation must not carry Runtime identity")
		}
		return nil
	case observationEnvironment:
		if err := validateIdentifier("agent_id", o.AgentID); err != nil {
			return invalid("Environment observation requires a valid Agent identity")
		}
		if err := ValidateRevision(o.RuntimeRevision); err != nil {
			return invalid("Environment observation requires a valid Runtime revision")
		}
		if o.Generation != 0 || o.SpecDigest != "" || o.PlatformResourceID != "" ||
			o.RuntimeExecutionID != "" {
			return invalid("Environment observation must not carry generation identity")
		}
		return nil
	case observationRuntime:
		if _, ok := o.RuntimeKey(); !ok {
			return invalid("Runtime observation requires a valid generation identity")
		}
		if err := ValidateDigest(o.SpecDigest); err != nil {
			return invalid("Runtime observation requires a valid spec digest")
		}
		if err := ValidateRevision(o.RuntimeRevision); err != nil {
			return invalid("Runtime observation requires a valid Runtime revision")
		}
		return nil
	default:
		return invalid("unknown observation kind")
	}
}

type observationIdentityScope uint8

const (
	observationInvalid observationIdentityScope = iota
	observationService
	observationEnvironment
	observationRuntime
)

func observationScope(kind ObservationKind) observationIdentityScope {
	switch kind {
	case ObservationGap, ObservationReconciled:
		return observationService
	case ObservationInitialized, ObservationUpdated, ObservationDisabled, ObservationEnabled,
		ObservationDeleted, ObservationStorageMissing, ObservationStorageDrift:
		return observationEnvironment
	case ObservationHealthy, ObservationStarting, ObservationUnhealthy, ObservationRestarted, ObservationExited,
		ObservationRuntimeDeleted, ObservationStatusUnverified, ObservationRuntimeMissing:
		return observationRuntime
	default:
		return observationInvalid
	}
}
