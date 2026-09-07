package ports

import (
	"context"
	"errors"
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

	RunReleaseOutcomeReleased   = "released"
	RunReleaseOutcomeNotBlocked = "not_blocked"
	RunReleaseOutcomeRetained   = "retained_source_not_runtime_mcp"

	EventAgentCreateRequested      = "agent_create_requested"
	EventAgentReady                = "agent_ready"
	EventAgentBuildFailed          = "agent_build_failed"
	EventAgentRebuildRequested     = "agent_rebuild_requested"
	EventAgentRebuilt              = "agent_rebuilt"
	EventAgentDisableRequested     = "agent_disable_requested"
	EventAgentDisabled             = "agent_disabled"
	EventAgentDisableFailed        = "agent_disable_failed"
	EventAgentEnableRequested      = "agent_enable_requested"
	EventAgentEnabled              = "agent_enabled"
	EventAgentEnableFailed         = "agent_enable_failed"
	EventAgentDeleteRequested      = "agent_delete_requested"
	EventAgentDeleted              = "agent_deleted"
	EventAgentLifecycleQuarantined = "agent_lifecycle_quarantined"
	EventAgentRuntimeRestarted     = "agent_runtime_restarted"
)

var ErrRunAdmissionRuntimeMismatch = errors.New("run admission Runtime does not match lifecycle barrier")

type AgentSpecSource interface {
	GetTemplateRevision(context.Context, string, int64) (domain.TemplateRevision, error)
	GetModelProfileRevision(context.Context, string) (domain.ModelProfileRevision, error)
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
	ImageRef   string
	Network    NetworkAttachment
	Resources  domain.RuntimeResources
	MCPServers []domain.MCPServer
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
	AgentID            string `json:"agent_id"`
	RuntimeRevision    string `json:"runtime_revision"`
	RuntimeExecutionID string `json:"runtime_execution_id,omitempty"`
	MCPEndpoint        string `json:"mcp_endpoint,omitempty"`
	LifecycleState     string `json:"lifecycle_state"`
	Health             string `json:"health"`
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
}

func (failure *DependencyError) Error() string {
	return fmt.Sprintf("%s dependency failed with %s", failure.Service, failure.Code)
}

type AgentRecord struct {
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
}

type AgentAccessRecord struct {
	AccessSubject      string
	AgentID            string
	PrincipalID        string
	AccessRevision     string
	PromptCapabilities PromptCapabilities
	Active             bool
	CreatedAt          time.Time
	UpdatedAt          time.Time
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
	RequestID                   string
	RequestFingerprint          string
	AgentID                     string
	Kind                        domain.OperationKind
	Phase                       domain.OperationPhase
	State                       domain.OperationState
	SourceSpecRevisionID        string
	SourceExecutionRevisionID   string
	SourceRuntimeRevision       string
	SourceRuntimeAbsent         bool
	TargetSpecRevisionID        string
	ChildRequestID              string
	NetworkAttachment           *NetworkAttachment
	SourceRuntimeInspection     *RuntimeInspection
	SourceRuntimeAbsenceProof   *RuntimeAbsenceProof
	RuntimeResult               *RuntimeOperation
	NetworkReleaseOutcome       string
	InitialTraceParent          string
	PreviousRecoveryTraceParent string
	Attempt                     int64
	RecoveryOwner               string
	RecoveryLeaseUntil          *time.Time
	RecoveryAfter               time.Time
	RecoveryFailureCount        int64
	ErrorCode                   string
	ErrorDetail                 string
	Retryable                   bool
	CreatedAt                   time.Time
	UpdatedAt                   time.Time
}

type AgentEventRecord struct {
	GlobalSequence     int64
	EventID            string
	AgentID            string
	AggregateSequence  int64
	SchemaVersion      int
	EventType          string
	OperationRequestID string
	AdmissionID        string
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
	ExecutableSpec        AgentSpecRecord
	ExecutableExecution   ExecutionRecord
	NextSpecRevision      int64
	NextExecutionRevision int64
}

type AgentRebuildState struct {
	Agent             AgentRecord
	SourceSpec        AgentSpecRecord
	SourceExecution   ExecutionRecord
	TargetSpec        AgentSpecRecord
	Operation         LifecycleOperationRecord
	RunReleaseOutcome string
}

type AgentDisableState struct {
	Agent             AgentRecord
	SourceSpec        AgentSpecRecord
	SourceExecution   ExecutionRecord
	Operation         LifecycleOperationRecord
	RunReleaseOutcome string
}

type AgentEnableBase struct {
	Agent                   AgentRecord
	Spec                    AgentSpecRecord
	LastSuccessfulExecution ExecutionRecord
	NextExecutionRevision   int64
}

type AgentEnableState struct {
	Agent                   AgentRecord
	Spec                    AgentSpecRecord
	LastSuccessfulExecution ExecutionRecord
	Operation               LifecycleOperationRecord
}

type AgentDeleteBase struct {
	Agent AgentRecord
}

type AgentDeleteState struct {
	Agent             AgentRecord
	Operation         LifecycleOperationRecord
	RunReleaseOutcome string
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
	Execution         ExecutionRecord
	ReadyEvent        AgentEventRecord
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
	RunReleaseEvent    RunAdmissionEvent
	Now                time.Time
}

type PublishAgentRebuild struct {
	RequestID          string
	Fingerprint        string
	AccessRevision     string
	PromptCapabilities PromptCapabilities
	Execution          ExecutionRecord
	RebuiltEvent       AgentEventRecord
	Now                time.Time
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
	RunReleaseEvent           RunAdmissionEvent
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
	RunReleaseEvent    RunAdmissionEvent
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
	RunReleaseEvent           RunAdmissionEvent
	FailedEvent               AgentEventRecord
	Now                       time.Time
}

type BeginAgentEnable struct {
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
	Execution    ExecutionRecord
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
	RequestID             string
	Fingerprint           string
	ExpectedPhase         domain.OperationPhase
	NextPhase             domain.OperationPhase
	NextChildRequestID    string
	NetworkAttachment     *NetworkAttachment
	RuntimeResult         *RuntimeOperation
	RunReleaseEvent       RunAdmissionEvent
	NetworkReleaseOutcome string
	Now                   time.Time
}

type PublishAgentDelete struct {
	RequestID    string
	Fingerprint  string
	DeletedEvent AgentEventRecord
	Now          time.Time
}

type LifecycleStore interface {
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
	SettleAgentRebuildDrain(context.Context, string, string, string, time.Time) (AgentRebuildState, error)
	AdvanceAgentRebuild(context.Context, AdvanceAgentRebuild) (AgentRebuildState, error)
	PublishAgentRebuild(context.Context, PublishAgentRebuild) (AgentRebuildState, error)
	FailAgentRebuild(context.Context, FailAgentRebuild) (AgentRebuildState, error)
	ReplayAgentDisable(context.Context, string, string) (AgentDisableState, bool, error)
	BeginAgentDisable(context.Context, BeginAgentDisable) (AgentDisableState, bool, error)
	SettleAgentDisableDrain(context.Context, string, string, string, time.Time) (AgentDisableState, error)
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
	SettleAgentDeleteDrain(context.Context, string, string, string, time.Time) (AgentDeleteState, error)
	AdvanceAgentDelete(context.Context, AdvanceAgentDelete) (AgentDeleteState, error)
	PublishAgentDelete(context.Context, PublishAgentDelete) (AgentDeleteState, error)
}
