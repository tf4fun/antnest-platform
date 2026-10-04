package ports

import (
	"context"
	"encoding/base64"
	"net/url"
	"regexp"
	"strconv"
)

var runtimeConnectionID = regexp.MustCompile(`^rci_[0-9a-f]{32}$`)
var runtimeConnectionRevision = regexp.MustCompile(`^rtv_[0-9a-f]{32}$`)
var runtimeConnectionAgent = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$`)
var runtimeConnectionEndpoint = regexp.MustCompile(`^https?://(?:[A-Za-z0-9][A-Za-z0-9_.-]*|\[[0-9a-fA-F:]+\])(?::[0-9]{1,5})?/mcp$`)

const maximumRuntimeConnectionEndpointBytes = 1024

// RuntimeConnection is a private, volatile RC-to-ACP handoff. It must never be
// persisted by Controller or returned through ordinary inspection/audit DTOs.
type RuntimeConnection struct {
	AgentID            string            `json:"agent_id"`
	RuntimeRevision    string            `json:"runtime_revision"`
	RuntimeExecutionID string            `json:"runtime_execution_id"`
	ConnectionID       string            `json:"connection_id"`
	MCPEndpoint        string            `json:"mcp_endpoint"`
	Credential         RuntimeCredential `json:"credential"`
}

type RuntimeCredential struct {
	Caller string `json:"caller"`
	Token  string `json:"token"`
}

func (credential RuntimeCredential) String() string   { return "RuntimeCredential(<redacted>)" }
func (credential RuntimeCredential) GoString() string { return credential.String() }

func (credential RuntimeCredential) Valid() bool {
	if credential.Caller != "agent-acp-service" || len(credential.Token) < 43 || len(credential.Token) > 86 {
		return false
	}
	raw, err := base64.RawURLEncoding.Strict().DecodeString(credential.Token)
	return err == nil && len(raw) >= 32 && len(raw) <= 64 && base64.RawURLEncoding.EncodeToString(raw) == credential.Token
}

func (connection RuntimeConnection) Valid() bool {
	return runtimeConnectionAgent.MatchString(connection.AgentID) &&
		runtimeConnectionRevision.MatchString(connection.RuntimeRevision) &&
		executionIdentifier.MatchString(connection.RuntimeExecutionID) &&
		runtimeConnectionID.MatchString(connection.ConnectionID) &&
		validRuntimeConnectionEndpoint(connection.MCPEndpoint) &&
		connection.Credential.Valid()
}

func (connection RuntimeConnection) Matches(agentID string, binding ExecutionRuntime) bool {
	return connection.Valid() && connection.AgentID == agentID &&
		connection.RuntimeRevision == binding.RuntimeRevision &&
		connection.RuntimeExecutionID == binding.RuntimeExecutionID &&
		connection.MCPEndpoint == binding.MCPEndpoint
}

func validRuntimeConnectionEndpoint(value string) bool {
	if len(value) > maximumRuntimeConnectionEndpointBytes || !runtimeConnectionEndpoint.MatchString(value) {
		return false
	}
	endpoint, err := url.Parse(value)
	if err != nil || endpoint.User != nil || endpoint.Opaque != "" || endpoint.RawQuery != "" || endpoint.ForceQuery || endpoint.Fragment != "" ||
		(endpoint.Scheme != "http" && endpoint.Scheme != "https") || endpoint.Path != "/mcp" || endpoint.RawPath != "" ||
		!executionEndpoint(value) || endpoint.String() != value {
		return false
	}
	// Endpoint ownership comes from exact equality with the persisted binding,
	// not from deriving a destination or credential from a request/tool URL.
	if endpoint.Port() == "" {
		return true
	}
	port, err := strconv.ParseUint(endpoint.Port(), 10, 16)
	return err == nil && port > 0 && strconv.FormatUint(port, 10) == endpoint.Port()
}

// The resolver is deliberately separate from lifecycle RuntimeClient: it has
// no request ID, generation allocation, end-user actor or mutation semantics.
type RuntimeConnectionResolver interface {
	ResolveRuntimeConnection(context.Context, string, string, string) (RuntimeConnection, error)
}

func ValidateRuntimeConnectionRequest(agentID, revision, executionID string) error {
	if !runtimeConnectionAgent.MatchString(agentID) || !runtimeConnectionRevision.MatchString(revision) ||
		!executionIdentifier.MatchString(executionID) {
		return ErrInvalidExecutionConfiguration
	}
	return nil
}

// Validate checks the local projection before network resolution.
// ValidateForPublication checks the completed private wire payload. Incomplete
// executable projections are never accepted by the ACP HTTP client.
func (snapshot ExecutionSnapshot) ValidateForPublication() error {
	if err := snapshot.Validate(); err != nil {
		return err
	}
	for _, agent := range snapshot.Agents {
		if !agent.AcceptingRuns {
			if agent.Runtime != nil && agent.Runtime.Credential != nil {
				return ErrInvalidExecutionConfiguration
			}
			continue
		}
		if agent.Runtime == nil || agent.Runtime.Credential == nil {
			return ErrInvalidExecutionConfiguration
		}
		runtime := agent.Runtime
		connection := RuntimeConnection{AgentID: agent.AgentID, RuntimeRevision: runtime.RuntimeRevision,
			RuntimeExecutionID: runtime.RuntimeExecutionID, ConnectionID: runtime.ConnectionID,
			MCPEndpoint: runtime.MCPEndpoint, Credential: *runtime.Credential}
		if !connection.Valid() {
			return ErrInvalidExecutionConfiguration
		}
	}
	return nil
}
