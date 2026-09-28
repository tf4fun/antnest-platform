package rpc

import (
	"slices"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/control"
	"soft/antnest-platform/services/runtime-controller/internal/deployment"
	"soft/antnest-platform/services/runtime-controller/internal/skillset"
)

type configurationDTO struct {
	MCPServers          []deployment.MCPServer `json:"mcp_servers,omitempty"`
	ImageRef            string                 `json:"image_ref"`
	Network             networkDTO             `json:"network"`
	Resources           resourceLimitsDTO      `json:"resources"`
	OrganizationID      string                 `json:"organization_id,omitempty"`
	SystemSkills        []skillset.FrozenSkill `json:"system_skills,omitempty"`
	PreparedSkillSet    *skillset.PreparedSet  `json:"prepared_skill_set,omitempty"`
	PreparedReferenceID string                 `json:"prepared_reference_id,omitempty"`
}

type networkDTO struct {
	PacketContractRevision uint32          `json:"packet_contract_revision"`
	EgressEndpoint         ipv4EndpointDTO `json:"egress_endpoint"`
	TunnelIPv4             string          `json:"tunnel_ipv4"`
	ResolverIPv4           string          `json:"resolver_ipv4"`
}

type ipv4EndpointDTO struct {
	IPv4 string `json:"ipv4"`
	Port uint16 `json:"port"`
}

type resourceLimitsDTO struct {
	MemoryBytes uint64 `json:"memory_bytes"`
	PidsLimit   uint32 `json:"pids_limit"`
	TmpfsBytes  uint64 `json:"tmpfs_bytes"`
}

func (d configurationDTO) domain() deployment.Configuration {
	return deployment.Configuration{
		MCPServers: deployment.CloneMCPServers(d.MCPServers),
		ImageRef:   d.ImageRef,
		Network: deployment.NetworkSpec{
			PacketContractRevision: d.Network.PacketContractRevision,
			EgressEndpoint: deployment.IPv4Endpoint{
				IPv4: d.Network.EgressEndpoint.IPv4,
				Port: d.Network.EgressEndpoint.Port,
			},
			TunnelIPv4:   d.Network.TunnelIPv4,
			ResolverIPv4: d.Network.ResolverIPv4,
		},
		Resources: deployment.ResourceLimits{
			MemoryBytes: d.Resources.MemoryBytes,
			PidsLimit:   d.Resources.PidsLimit,
			TmpfsBytes:  d.Resources.TmpfsBytes,
		},
		OrganizationID: d.OrganizationID, SystemSkills: slices.Clone(d.SystemSkills),
		PreparedSkillSet: d.PreparedSkillSet, PreparedReferenceID: d.PreparedReferenceID,
	}
}

type initializeRequest struct {
	Configuration configurationDTO `json:"configuration"`
}

type revisionRequest struct {
	ExpectedRevision deployment.RuntimeRevision `json:"expected_revision"`
}

type revisionConfigurationRequest struct {
	ExpectedRevision deployment.RuntimeRevision `json:"expected_revision"`
	Configuration    configurationDTO           `json:"configuration"`
}

type readinessResponse struct {
	Status           string `json:"status"`
	Live             bool   `json:"live"`
	Ready            bool   `json:"ready"`
	DatabaseReady    bool   `json:"database_ready"`
	PlatformReady    bool   `json:"platform_ready"`
	ObservationReady bool   `json:"observation_ready"`
}

func readinessFromDomain(status string, value control.Readiness) readinessResponse {
	return readinessResponse{
		Status: status, Live: true, Ready: value.Ready(),
		DatabaseReady: value.DatabaseReady, PlatformReady: value.PlatformReady,
		ObservationReady: value.ObservationReady,
	}
}

type runtimeInspectionDTO struct {
	Phase              deployment.PlatformPhase   `json:"phase"`
	Reason             string                     `json:"reason,omitempty"`
	DiagnosticSummary  string                     `json:"diagnostic_summary,omitempty"`
	AgentID            string                     `json:"agent_id"`
	RuntimeRevision    deployment.RuntimeRevision `json:"runtime_revision"`
	LifecycleState     deployment.LifecycleState  `json:"lifecycle_state"`
	Health             deployment.HealthState     `json:"health"`
	MCPEndpoint        string                     `json:"mcp_endpoint,omitempty"`
	RuntimeExecutionID string                     `json:"runtime_execution_id,omitempty"`
	RestartCount       uint64                     `json:"restart_count"`
	ObservedAt         time.Time                  `json:"observed_at"`
}

func runtimeInspectionFromDomain(value deployment.Environment) runtimeInspectionDTO {
	if value.Phase == "" {
		value.Phase = deployment.PhaseUnknown
	}
	return runtimeInspectionDTO{
		Phase: value.Phase, Reason: value.Reason, DiagnosticSummary: value.DiagnosticSummary,
		AgentID: value.AgentID, RuntimeRevision: value.RuntimeRevision,
		LifecycleState: value.LifecycleState, Health: value.Health,
		MCPEndpoint: value.MCPEndpoint, RuntimeExecutionID: value.RuntimeExecutionID,
		RestartCount: value.RestartCount, ObservedAt: value.ObservedAt,
	}
}

type runtimesResponse struct {
	Runtimes []runtimeInspectionDTO `json:"runtimes"`
}

func runtimesFromDomain(values []deployment.Environment) []runtimeInspectionDTO {
	result := make([]runtimeInspectionDTO, 0, len(values))
	for _, value := range values {
		result = append(result, runtimeInspectionFromDomain(value))
	}
	return result
}

type operationDTO struct {
	ImageReference string                     `json:"image_reference,omitempty"`
	ImageID        string                     `json:"image_id,omitempty"`
	RequestID      string                     `json:"request_id"`
	Kind           deployment.OperationKind   `json:"kind"`
	AgentID        string                     `json:"agent_id"`
	TargetRevision deployment.RuntimeRevision `json:"target_revision"`
	State          deployment.OperationState  `json:"state"`
	Effect         deployment.EffectState     `json:"effect"`
	Inspection     *runtimeInspectionDTO      `json:"inspection,omitempty"`
	ErrorCode      string                     `json:"error_code,omitempty"`
	ErrorDetail    string                     `json:"error_detail,omitempty"`
	CreatedAt      time.Time                  `json:"created_at"`
	UpdatedAt      time.Time                  `json:"updated_at"`
}

func operationFromDomain(value deployment.Operation) operationDTO {
	result := operationDTO{
		ImageReference: value.ImageReference, ImageID: value.ImageID,
		RequestID: value.RequestID, Kind: value.Kind, AgentID: value.AgentID,
		TargetRevision: value.RuntimeRevision, State: value.State, Effect: value.Effect,
		ErrorCode: value.ErrorCode, ErrorDetail: value.ErrorDetail,
		// Match persisted timestamp precision so replay does not change the wire result.
		CreatedAt: value.CreatedAt.Truncate(time.Microsecond), UpdatedAt: value.UpdatedAt.Truncate(time.Microsecond),
	}
	if value.Inspection != nil {
		inspection := runtimeInspectionFromDomain(*value.Inspection)
		result.Inspection = &inspection
	}
	return result
}

type observationDTO struct {
	Sequence           uint64                     `json:"sequence"`
	AgentID            string                     `json:"agent_id,omitempty"`
	RuntimeRevision    deployment.RuntimeRevision `json:"runtime_revision,omitempty"`
	RuntimeExecutionID string                     `json:"runtime_execution_id,omitempty"`
	Kind               deployment.ObservationKind `json:"kind"`
	DiagnosticSummary  string                     `json:"diagnostic_summary,omitempty"`
	ObservedAt         time.Time                  `json:"observed_at"`
}

func observationFromDomain(value deployment.Observation) observationDTO {
	return observationDTO{
		Sequence: value.Sequence, AgentID: value.AgentID,
		RuntimeRevision: value.RuntimeRevision, RuntimeExecutionID: value.RuntimeExecutionID,
		Kind: value.Kind, DiagnosticSummary: value.DiagnosticSummary, ObservedAt: value.ObservedAt,
	}
}

func observationsFromDomain(values []deployment.Observation) []observationDTO {
	result := make([]observationDTO, 0, len(values))
	for _, value := range values {
		result = append(result, observationFromDomain(value))
	}
	return result
}

type observationsResponse struct {
	Observations   []observationDTO `json:"observations"`
	OldestSequence uint64           `json:"oldest_sequence"`
	LatestSequence uint64           `json:"latest_sequence"`
	NextSequence   uint64           `json:"next_sequence"`
}

type errorResponse struct {
	Code          string  `json:"code"`
	Message       string  `json:"message"`
	Retryable     bool    `json:"retryable"`
	ResetSequence *uint64 `json:"reset_sequence,omitempty"`
}
