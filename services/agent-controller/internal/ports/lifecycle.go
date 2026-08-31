package ports

import (
	"context"
	"fmt"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

const (
	EventAgentCreateRequested = "agent_create_requested"
	EventAgentReady           = "agent_ready"
	EventAgentBuildFailed     = "agent_build_failed"
)

type AgentSpecSource interface {
	GetTemplateRevision(context.Context, string, int64) (domain.TemplateRevision, error)
	GetModelProfileRevision(context.Context, string) (domain.ModelProfileRevision, error)
}

type NetworkAttachment struct {
	AgentID                string `json:"agent_id"`
	TunnelIPv4             string `json:"tunnel_ipv4"`
	ResolverIPv4           string `json:"resolver_ipv4"`
	PacketContractRevision uint32 `json:"packet_contract_revision"`
	EgressIPv4             string `json:"egress_ipv4"`
	EgressPort             uint16 `json:"egress_port"`
	State                  string `json:"state"`
}

type RuntimeConfiguration struct {
	ImageRef  string
	Network   NetworkAttachment
	Resources domain.RuntimeResources
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

type EgressClient interface {
	EnsureAgentNetwork(context.Context, string) (NetworkAttachment, error)
}

type RuntimeClient interface {
	InitializeRuntime(context.Context, string, string, RuntimeConfiguration) (RuntimeOperation, error)
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
	AccessSubject  string
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
	RequestID            string
	RequestFingerprint   string
	AgentID              string
	Kind                 domain.OperationKind
	Phase                domain.OperationPhase
	State                domain.OperationState
	TargetSpecRevisionID string
	ChildRequestID       string
	NetworkAttachment    *NetworkAttachment
	RuntimeResult        *RuntimeOperation
	InitialTraceParent   string
	Attempt              int64
	ErrorCode            string
	ErrorDetail          string
	Retryable            bool
	CreatedAt            time.Time
	UpdatedAt            time.Time
}

type AgentEventRecord struct {
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

type BeginAgentCreate struct {
	Agent          AgentRecord
	Access         AgentAccessRecord
	Spec           AgentSpecRecord
	Operation      LifecycleOperationRecord
	RequestedEvent AgentEventRecord
}

type PublishAgentCreate struct {
	RequestID   string
	Fingerprint string
	Execution   ExecutionRecord
	ReadyEvent  AgentEventRecord
	Now         time.Time
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

type LifecycleStore interface {
	ReplayAgentCreate(context.Context, string, string) (AgentCreateState, bool, error)
	BeginAgentCreate(context.Context, BeginAgentCreate) (AgentCreateState, bool, error)
	RecordCreateNetwork(context.Context, string, string, NetworkAttachment, string, time.Time) (AgentCreateState, error)
	RecordCreateRuntime(context.Context, string, string, RuntimeOperation, string, time.Time) (AgentCreateState, error)
	PublishAgentCreate(context.Context, PublishAgentCreate) (AgentCreateState, error)
	FailAgentCreate(context.Context, FailAgentCreate) (AgentCreateState, error)
}
