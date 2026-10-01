package ports

import (
	"context"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

const (
	NetworkStateActive      = "active"
	NetworkStateQuarantined = "quarantined"

	NetworkAttachmentClosed = "closed"
	NetworkAttachmentOpen   = "open"

	NetworkReleaseQuarantined       = "quarantined"
	NetworkReleaseAuthoritativeNone = "authoritative_absent"

	EventAgentCreateRequested         = "agent_create_requested"
	EventAgentReady                   = "agent_ready"
	EventAgentCreated                 = "agent_created"
	EventAgentBuildFailed             = "agent_build_failed"
	EventAgentRebuildRequested        = "agent_rebuild_requested"
	EventAgentRebuilt                 = "agent_rebuilt"
	EventAgentDisableRequested        = "agent_disable_requested"
	EventAgentDisabled                = "agent_disabled"
	EventAgentDisableFailed           = "agent_disable_failed"
	EventAgentEnableRequested         = "agent_enable_requested"
	EventAgentEnabled                 = "agent_enabled"
	EventAgentEnableFailed            = "agent_enable_failed"
	EventAgentDeleteRequested         = "agent_delete_requested"
	EventAgentDeleted                 = "agent_deleted"
	EventAgentLifecycleQuarantined    = "agent_lifecycle_quarantined"
	EventAgentRuntimeRestarted        = "agent_runtime_restarted"
	EventAgentRuntimeMissing          = "agent_runtime_missing"
	EventAgentRuntimeConditionChanged = "agent_runtime_condition_changed"
	EventAgentOwnerRevoked            = "agent_owner_revoked"
)

type AgentSpecSource interface {
	GetTemplateRevision(context.Context, string, int64) (domain.TemplateRevision, error)
	GetCurrentModelProfileRevision(context.Context, string) (domain.ModelProfileRevision, error)
}

type NetworkAttachment struct {
	AgentID                   string `json:"agent_id"`
	TunnelIPv4                string `json:"tunnel_ipv4"`
	ResolverIPv4              string `json:"resolver_ipv4"`
	PacketContractRevision    uint32 `json:"packet_contract_revision"`
	EgressIPv4                string `json:"egress_ipv4"`
	EgressPort                uint16 `json:"egress_port"`
	State                     string `json:"state"`
	NetworkResourceVersion    uint64 `json:"network_resource_version"`
	AttachmentState           string `json:"attachment_state"`
	AttachmentResourceVersion uint64 `json:"attachment_resource_version"`
}

type RuntimeConfiguration struct {
	ImageRef            string
	Network             NetworkAttachment
	Resources           domain.RuntimeResources
	MCPServers          []domain.MCPServer
	OrganizationID      string
	SystemSkills        []domain.FrozenSkill
	PreparedSkillSet    *PreparedSkillSet
	PreparedReferenceID string
}

type RuntimeOperation struct {
	State              string `json:"state"`
	Effect             string `json:"effect,omitempty"`
	RuntimeRevision    string `json:"runtime_revision,omitempty"`
	RuntimeExecutionID string `json:"runtime_execution_id,omitempty"`
	MCPEndpoint        string `json:"mcp_endpoint,omitempty"`
	LifecycleState     string `json:"lifecycle_state,omitempty"`
	Health             string `json:"health,omitempty"`
	ErrorCode          string `json:"error_code,omitempty"`
	ErrorDetail        string `json:"error_detail,omitempty"`
}

type RuntimeInspection struct {
	Phase              string    `json:"phase"`
	Reason             string    `json:"reason,omitempty"`
	DiagnosticSummary  string    `json:"diagnostic_summary,omitempty"`
	ObservedAt         time.Time `json:"observed_at"`
	AgentID            string    `json:"agent_id"`
	RuntimeRevision    string    `json:"runtime_revision"`
	RuntimeExecutionID string    `json:"runtime_execution_id,omitempty"`
	MCPEndpoint        string    `json:"mcp_endpoint,omitempty"`
	LifecycleState     string    `json:"lifecycle_state"`
	Health             string    `json:"health"`
}

type RuntimeAbsenceProof struct {
	Reason          string    `json:"reason"`
	RuntimeRevision string    `json:"runtime_revision,omitempty"`
	ObservedAt      time.Time `json:"observed_at"`
}

type EgressClient interface {
	GetAgentNetwork(context.Context, string) (NetworkAttachment, error)
	EnsureAgentNetwork(context.Context, string) (NetworkAttachment, error)
	SetAgentNetworkAttachment(context.Context, string, string, uint64) (NetworkAttachment, error)
	ReleaseAgentNetwork(context.Context, string, uint64) (NetworkAttachment, error)
}

type RuntimeClient interface {
	InitializeRuntime(context.Context, string, string, RuntimeConfiguration) (RuntimeOperation, error)
	UpdateRuntime(context.Context, string, string, string, RuntimeConfiguration) (RuntimeOperation, error)
	DisableRuntime(context.Context, string, string, string) (RuntimeOperation, error)
	EnableRuntime(context.Context, string, string, string, RuntimeConfiguration) (RuntimeOperation, error)
	DeleteRuntime(context.Context, string, string, string) (RuntimeOperation, error)
	InspectRuntime(context.Context, string) (RuntimeInspection, error)
}

type DependencyError struct {
	Service   string
	Code      string
	Retryable bool
	Cause     error `json:"-"`
}

func (failure *DependencyError) Unwrap() error { return failure.Cause }

func (failure *DependencyError) Error() string {
	return fmt.Sprintf("%s dependency failed with %s", failure.Service, failure.Code)
}

type AgentRecord struct {
	ActivationState                   domain.ActivationState
	RuntimeState                      domain.RuntimeState
	RuntimeReason                     string
	RuntimeDetail                     string
	RuntimeObservedAt                 *time.Time
	AgentID                           string
	OrganizationID                    string
	OwnerUserID                       string
	Name                              string
	DesiredState                      domain.DesiredState
	LifecycleState                    domain.AgentState
	AccessRevision                    string
	AgentSpecRevisionID               string
	ExecutionRevisionID               string
	LastSuccessfulExecutionRevisionID string
	RuntimeRevision                   string
	RuntimeExecutionID                string
	RuntimeMCPEndpoint                string
	ActiveOperationRequestID          string
	FailureStage                      string
	FailureCode                       string
	FailureDetail                     string
	AggregateSequence                 int64
	CreatedAt                         time.Time
	UpdatedAt                         time.Time
	OwnerAuthorizationSequence        int64
	IdentityRevocationSequence        int64
}

func (record AgentRecord) IdentityRevoked() bool {
	return record.IdentityRevocationSequence > record.OwnerAuthorizationSequence
}

func (record AgentRecord) Status() domain.AgentStatus {
	return domain.AgentStatus{Lifecycle: record.LifecycleState, Activation: record.ActivationState, Runtime: record.RuntimeState}
}

// ExecutionReady is the Agent-local prerequisite; model availability is separate.
func (record AgentRecord) ExecutionReady() bool {
	return record.Status().RuntimeReady() && record.DesiredState == domain.DesiredEnabled &&
		!record.IdentityRevoked() && record.OwnerUserID != "" && record.ActiveOperationRequestID == "" &&
		record.AgentSpecRevisionID != "" && record.ExecutionRevisionID != "" &&
		record.RuntimeRevision != "" && record.RuntimeExecutionID != "" && record.RuntimeMCPEndpoint != ""
}

func (record AgentRecord) AllowsDisableRequest() bool {
	return record.DesiredState == domain.DesiredEnabled ||
		(record.DesiredState == domain.DesiredDisabled && record.IdentityRevoked())
}

type AgentAccessRecord struct {
	AgentID        string
	PrincipalID    string
	AccessRevision string
	Active         bool
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type AgentSpecRecord struct {
	ID              string
	AgentID         string
	Revision        int64
	Snapshot        domain.AgentSpecSnapshot
	CanonicalDigest string
	CreatedAt       time.Time
}

type LifecycleOperationRecord struct {
	DrainDeadlineAt           *time.Time
	SettlementOutcome         string
	OwnerRevocationSequence   int64
	RequestID                 string
	RequestFingerprint        string
	AgentID                   string
	Kind                      domain.OperationKind
	Phase                     domain.OperationPhase
	State                     domain.OperationState
	SourceSpecRevisionID      string
	SourceExecutionRevisionID string
	SourceRuntimeRevision     string
	SourceRuntimeAbsent       bool
	TargetSpecRevisionID      string
	ChildRequestID            string
	NetworkAttachment         *NetworkAttachment
	SourceRuntimeInspection   *RuntimeInspection
	SourceRuntimeAbsenceProof *RuntimeAbsenceProof
	RuntimeResult             *RuntimeOperation
	NetworkReleaseOutcome     string
	ErrorCode                 string
	ErrorDetail               string
	Retryable                 bool
	CreatedAt                 time.Time
	UpdatedAt                 time.Time
}

type AgentEventRecord struct {
	GlobalSequence     int64
	EventID            string
	AgentID            string
	AggregateSequence  int64
	SchemaVersion      int
	EventType          string
	OperationRequestID string
	TraceID            string
	Data               map[string]any
	OccurredAt         time.Time
}

type ExecutionRecord struct {
	ID                     string
	AgentID                string
	Revision               int64
	AgentSpecRevisionID    string
	RuntimeRevision        string
	RuntimeExecutionID     string
	RuntimeMCPEndpoint     string
	RuntimeMCPSourceDigest string
	ChangeSummary          map[string]any
	PublishedAt            time.Time
}

type AgentCreateState struct {
	Agent     AgentRecord
	Access    AgentAccessRecord
	Spec      AgentSpecRecord
	Operation LifecycleOperationRecord
}

type AgentLifecycleBase struct {
	Agent                 AgentRecord
	ConfiguredSpec        AgentSpecRecord
	SourceExecution       ExecutionRecord
	NextSpecRevision      int64
	NextExecutionRevision int64
}

// AgentRuntimeSource is immutable lineage, not permission to execute a Run.
type AgentRuntimeSource struct {
	Spec      AgentSpecRecord
	Execution ExecutionRecord
}

type AgentRebuildState struct {
	Agent           AgentRecord
	SourceSpec      AgentSpecRecord
	SourceExecution ExecutionRecord
	TargetSpec      AgentSpecRecord
	Operation       LifecycleOperationRecord
}

type AgentDisableState struct {
	Agent           AgentRecord
	SourceSpec      AgentSpecRecord
	SourceExecution ExecutionRecord
	Operation       LifecycleOperationRecord
}

type AgentEnableBase struct {
	Agent                   AgentRecord
	Spec                    AgentSpecRecord
	LastSuccessfulExecution ExecutionRecord
	NextSpecRevision        int64
	NextExecutionRevision   int64
}

type AgentEnableState struct {
	Agent                   AgentRecord
	Spec                    AgentSpecRecord
	SourceSpec              AgentSpecRecord
	LastSuccessfulExecution ExecutionRecord
	Operation               LifecycleOperationRecord
}

type AgentDeleteBase struct {
	Agent AgentRecord
}

type AgentDeleteState struct {
	Agent     AgentRecord
	Operation LifecycleOperationRecord
}

type BeginAgentCreate struct {
	Agent          AgentRecord
	Access         AgentAccessRecord
	Spec           AgentSpecRecord
	Operation      LifecycleOperationRecord
	RequestedEvent AgentEventRecord
}

type PublishAgentCreate struct {
	RequestID         string
	Fingerprint       string
	NetworkAttachment NetworkAttachment
	CreatedEvent      AgentEventRecord
	Now               time.Time
}

type FailAgentCreate struct {
	RequestID   string
	Fingerprint string
	Stage       domain.OperationPhase
	Code        string
	Detail      string
	Retryable   bool
	FailedEvent AgentEventRecord
	Now         time.Time
}

type BeginAgentRebuild struct {
	AgentID                     string
	ExpectedAggregateSequence   int64
	ExpectedSpecRevisionID      string
	ExpectedExecutionRevisionID string
	ExpectedRuntimeRevision     string
	TargetSpec                  AgentSpecRecord
	Operation                   LifecycleOperationRecord
	RequestedEvent              AgentEventRecord
	Now                         time.Time
}

type AdvanceAgentRebuild struct {
	RequestID          string
	Fingerprint        string
	ExpectedPhase      domain.OperationPhase
	NextPhase          domain.OperationPhase
	NextChildRequestID string
	NetworkAttachment  *NetworkAttachment
	RuntimeResult      *RuntimeOperation
	Now                time.Time
}

// LifecycleAdvanceResult contains mutable projections only, not execution snapshots.
type LifecycleAdvanceResult struct {
	Agent     AgentRecord
	Operation LifecycleOperationRecord
}

type PublishAgentRebuild struct {
	RequestID      string
	Fingerprint    string
	AccessRevision string
	RebuiltEvent   AgentEventRecord
	Now            time.Time
}

type FailAgentRebuild struct {
	RequestID                 string
	Fingerprint               string
	ExpectedAggregateSequence int64
	Stage                     domain.OperationPhase
	Code                      string
	Detail                    string
	Retryable                 bool
	PreserveExecutable        bool
	RuntimeAbsenceProof       *RuntimeAbsenceProof
	FailedEvent               AgentEventRecord
	Now                       time.Time
}

type BeginAgentDisable struct {
	AgentID                     string
	ExpectedAggregateSequence   int64
	ExpectedSpecRevisionID      string
	ExpectedExecutionRevisionID string
	ExpectedRuntimeRevision     string
	Operation                   LifecycleOperationRecord
	RequestedEvent              AgentEventRecord
	Now                         time.Time
}

type AdvanceAgentDisable struct {
	RequestID          string
	Fingerprint        string
	ExpectedPhase      domain.OperationPhase
	NextPhase          domain.OperationPhase
	NextChildRequestID string
	NetworkAttachment  *NetworkAttachment
	RuntimeResult      *RuntimeOperation
	Now                time.Time
}

type PublishAgentDisable struct {
	RequestID     string
	Fingerprint   string
	DisabledEvent AgentEventRecord
	Now           time.Time
}

type FailAgentDisable struct {
	RequestID                 string
	Fingerprint               string
	ExpectedAggregateSequence int64
	Stage                     domain.OperationPhase
	Code                      string
	Detail                    string
	PreserveExecutable        bool
	SourceRuntimeInspection   *RuntimeInspection
	RuntimeAbsenceProof       *RuntimeAbsenceProof
	FailedEvent               AgentEventRecord
	Now                       time.Time
}

type BeginAgentEnable struct {
	OwnerAuthorizationSequence  int64
	AgentID                     string
	ExpectedAggregateSequence   int64
	ExpectedSpecRevisionID      string
	ExpectedExecutionRevisionID string
	ExpectedRuntimeRevision     string
	Operation                   LifecycleOperationRecord
	RequestedEvent              AgentEventRecord
	Now                         time.Time
}

type AdvanceAgentEnable struct {
	RequestID          string
	Fingerprint        string
	ExpectedPhase      domain.OperationPhase
	NextPhase          domain.OperationPhase
	NextChildRequestID string
	NetworkAttachment  *NetworkAttachment
	RuntimeResult      *RuntimeOperation
	Now                time.Time
}

type PublishAgentEnable struct {
	RequestID    string
	Fingerprint  string
	EnabledEvent AgentEventRecord
	Now          time.Time
}

type FailAgentEnable struct {
	RequestID               string
	Fingerprint             string
	Stage                   domain.OperationPhase
	Code                    string
	Detail                  string
	SourceRuntimeInspection *RuntimeInspection
	FailedEvent             AgentEventRecord
	Now                     time.Time
}

type BeginAgentDelete struct {
	AgentID                   string
	ExpectedAggregateSequence int64
	ExpectedDesiredState      domain.DesiredState
	ExpectedLifecycleState    domain.AgentState
	ExpectedRuntimeRevision   string
	Operation                 LifecycleOperationRecord
	RequestedEvent            AgentEventRecord
	Now                       time.Time
}

type AdvanceAgentDelete struct {
	SourceRuntimeInspection   *RuntimeInspection
	SourceRuntimeAbsenceProof *RuntimeAbsenceProof
	RequestID                 string
	Fingerprint               string
	ExpectedPhase             domain.OperationPhase
	NextPhase                 domain.OperationPhase
	NextChildRequestID        string
	NetworkAttachment         *NetworkAttachment
	RuntimeResult             *RuntimeOperation
	NetworkReleaseOutcome     string
	Now                       time.Time
}

type PublishAgentDelete struct {
	RequestID    string
	Fingerprint  string
	DeletedEvent AgentEventRecord
	Now          time.Time
}

type LifecycleStore interface {
	ConfirmLifecycleDrain(context.Context, ConfirmLifecycleDrain) (LifecycleOperationRecord, error)
	QuarantineLifecycleOperation(context.Context, QuarantineLifecycleOperation) error
	GetLifecycleOperation(context.Context, string) (LifecycleOperationRecord, error)
	GetAgentLifecycleBase(context.Context, string) (AgentLifecycleBase, error)
	ReplayAgentCreate(context.Context, string, string) (AgentCreateState, bool, error)
	BeginAgentCreate(context.Context, BeginAgentCreate) (AgentCreateState, bool, error)
	RecordCreateNetwork(context.Context, string, string, NetworkAttachment, string, time.Time) (AgentCreateState, error)
	RecordCreateRuntime(context.Context, string, string, RuntimeOperation, string, time.Time) (AgentCreateState, error)
	PublishAgentCreate(context.Context, PublishAgentCreate) (AgentCreateState, error)
	FailAgentCreate(context.Context, FailAgentCreate) (AgentCreateState, error)
	ReplayAgentRebuild(context.Context, string, string) (AgentRebuildState, bool, error)
	BeginAgentRebuild(context.Context, BeginAgentRebuild) (AgentRebuildState, bool, error)
	AdvanceAgentRebuild(context.Context, AdvanceAgentRebuild) (LifecycleAdvanceResult, error)
	PublishAgentRebuild(context.Context, PublishAgentRebuild) (AgentRebuildState, error)
	FailAgentRebuild(context.Context, FailAgentRebuild) (AgentRebuildState, error)
	ReplayAgentDisable(context.Context, string, string) (AgentDisableState, bool, error)
	BeginAgentDisable(context.Context, BeginAgentDisable) (AgentDisableState, bool, error)
	AdvanceAgentDisable(context.Context, AdvanceAgentDisable) (AgentDisableState, error)
	PublishAgentDisable(context.Context, PublishAgentDisable) (AgentDisableState, error)
	FailAgentDisable(context.Context, FailAgentDisable) (AgentDisableState, error)
	GetAgentEnableBase(context.Context, string) (AgentEnableBase, error)
	ReplayAgentEnable(context.Context, string, string) (AgentEnableState, bool, error)
	BeginAgentEnable(context.Context, BeginAgentEnable) (AgentEnableState, bool, error)
	AdvanceAgentEnable(context.Context, AdvanceAgentEnable) (AgentEnableState, error)
	PublishAgentEnable(context.Context, PublishAgentEnable) (AgentEnableState, error)
	FailAgentEnable(context.Context, FailAgentEnable) (AgentEnableState, error)
	GetAgentDeleteBase(context.Context, string) (AgentDeleteBase, error)
	ReplayAgentDelete(context.Context, string, string) (AgentDeleteState, bool, error)
	BeginAgentDelete(context.Context, BeginAgentDelete) (AgentDeleteState, bool, error)
	AdvanceAgentDelete(context.Context, AdvanceAgentDelete) (AgentDeleteState, error)
	PublishAgentDelete(context.Context, PublishAgentDelete) (AgentDeleteState, error)
}
