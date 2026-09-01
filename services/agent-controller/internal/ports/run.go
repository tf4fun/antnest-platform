package ports

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"time"

	"soft/antnest-platform/services/agent-controller/internal/domain"
)

var runDigestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

var (
	ErrRunAccessDenied      = errors.New("run access denied")
	ErrAgentBusy            = errors.New("agent run admission occupied")
	ErrAgentRebuilding      = errors.New("agent lifecycle operation active")
	ErrAgentBuildFailed     = errors.New("agent build failed")
	ErrAgentNotReady        = errors.New("agent is not executable")
	ErrAdmissionNotFound    = errors.New("run admission not found")
	ErrCredentialNotAllowed = errors.New("credential is not allowed for admission")
)

const (
	EventRunAdmissionUnresolved = "run_admission_unresolved"
	EventRunAdmissionReleased   = "run_admission_released"
)

type PromptCapabilities struct {
	Image           bool `json:"image"`
	EmbeddedContext bool `json:"embedded_context"`
}

type AgentAccessResolution struct {
	PrincipalID        string
	AgentID            string
	AccessRevision     string
	PromptCapabilities PromptCapabilities
}

type SkillInstruction struct {
	SkillKey     string `json:"skill_key"`
	Version      string `json:"version"`
	Instructions string `json:"instructions"`
}

type AdmittedRuntime struct {
	RuntimeRevision    string `json:"runtime_revision"`
	RuntimeExecutionID string `json:"runtime_execution_id"`
	MCPEndpoint        string `json:"mcp_endpoint"`
}

type AdmittedExecutionSpec struct {
	SystemPrompt         string             `json:"system_prompt"`
	ContextPolicyVersion string             `json:"context_policy_version"`
	SkillInstructions    []SkillInstruction `json:"skill_instructions"`
	Model                domain.ModelSpec   `json:"model"`
	MaxModelRequests     int                `json:"max_model_requests"`
	CredentialRef        string             `json:"credential_ref"`
}

type RunExecutionSnapshot struct {
	AgentSpecRevisionID      string                `json:"agent_spec_revision"`
	ExecutionRevisionID      string                `json:"execution_revision"`
	RuntimeMCPSourceDigest   string                `json:"runtime_mcp_source_digest"`
	AgentExecutionSpecDigest string                `json:"agent_execution_spec_digest"`
	CredentialVersion        string                `json:"credential_version"`
	Runtime                  AdmittedRuntime       `json:"runtime"`
	ExecutionSpec            AdmittedExecutionSpec `json:"execution_spec"`
}

func ValidateRunExecutionSnapshot(snapshot RunExecutionSnapshot) error {
	endpoint, err := url.Parse(snapshot.Runtime.MCPEndpoint)
	if err != nil || endpoint.Host == "" ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.User != nil {
		return fmt.Errorf("runtime MCP endpoint is invalid")
	}
	if strings.TrimSpace(snapshot.AgentSpecRevisionID) == "" ||
		strings.TrimSpace(snapshot.ExecutionRevisionID) == "" ||
		!runDigestPattern.MatchString(snapshot.RuntimeMCPSourceDigest) ||
		!runDigestPattern.MatchString(snapshot.AgentExecutionSpecDigest) ||
		strings.TrimSpace(snapshot.CredentialVersion) == "" ||
		strings.TrimSpace(snapshot.Runtime.RuntimeRevision) == "" ||
		strings.TrimSpace(snapshot.Runtime.RuntimeExecutionID) == "" ||
		snapshot.ExecutionSpec.ContextPolicyVersion != domain.ContextPolicyV1 ||
		len(snapshot.ExecutionSpec.SkillInstructions) != 0 ||
		snapshot.ExecutionSpec.MaxModelRequests < 1 ||
		snapshot.ExecutionSpec.MaxModelRequests > 128 ||
		strings.TrimSpace(snapshot.ExecutionSpec.CredentialRef) == "" {
		return fmt.Errorf("run execution snapshot is incomplete")
	}
	if err := domain.ValidateModelSpec(snapshot.ExecutionSpec.Model); err != nil {
		return fmt.Errorf("run execution snapshot model: %w", err)
	}
	return nil
}

type AcquireRunRecord struct {
	RequestID              string
	RequestFingerprint     string
	AdmissionID            string
	AgentID                string
	PrincipalID            string
	ExpectedAccessRevision string
	SessionID              string
	Deadline               time.Time
	Now                    time.Time
}

type RunAdmissionRecord struct {
	AdmissionID                  string
	RequestID                    string
	RequestFingerprint           string
	AgentID                      string
	SessionID                    string
	PrincipalID                  string
	AccessRevision               string
	State                        domain.AdmissionState
	Deadline                     time.Time
	RuntimeRevision              string
	Snapshot                     RunExecutionSnapshot
	TerminalReport               *domain.TerminalReport
	FinishedAt                   *time.Time
	ReleasedByOperationRequestID string
	ReleasedAt                   *time.Time
	CreatedAt                    time.Time
	UpdatedAt                    time.Time
}

type FinishRunCommand struct {
	RequestID   string
	AdmissionID string
	Report      domain.TerminalReport
	Event       *RunAdmissionEvent
	Now         time.Time
}

type RunAdmissionEvent struct {
	EventID    string
	EventType  string
	TraceID    string
	Data       map[string]any
	OccurredAt time.Time
}

type FinishRunRecord struct {
	Status         string
	AdmissionState domain.AdmissionState
}

type AdmissionCredential struct {
	Identity   CredentialIdentity
	SecretType string
	Sealed     SealedSecret
}

type CredentialOpener interface {
	Open(context.Context, CredentialIdentity, SealedSecret) (string, error)
}

type RunStore interface {
	ResolveAgentAccess(context.Context, string) (AgentAccessResolution, error)
	AcquireRun(context.Context, AcquireRunRecord) (RunAdmissionRecord, bool, error)
	FinishRun(context.Context, FinishRunCommand) (FinishRunRecord, error)
	GetAdmissionCredential(context.Context, string, string, time.Time) (AdmissionCredential, error)
}
