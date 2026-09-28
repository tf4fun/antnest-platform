package ports

import "time"

// BeginLegacySourceRecovery binds a pre-cutover Agent to an observed, exact RC
// source before any drain, network, or Runtime effect.
type BeginLegacySourceRecovery struct {
	RequestID                  string
	Fingerprint                string
	AgentID                    string
	OrganizationID             string
	ActorPrincipalID           string
	ExpectedAggregateSequence  int64
	SourceSpecRevisionID       string
	SourceRuntimeRevision      string
	ObservedRuntimeExecutionID string
	ObservedAttachmentVersion  uint64
	ChildRequestID             string
	DrainDeadlineAt            time.Time
	Now                        time.Time
}

type LegacySourceRecoveryRecord struct {
	RequestID                  string
	Fingerprint                string
	AgentID                    string
	OrganizationID             string
	ActorPrincipalID           string
	AdmittedAgentSequence      int64
	SourceSpecRevisionID       string
	SourceRuntimeRevision      string
	ObservedRuntimeExecutionID string
	ObservedAttachmentVersion  uint64
	ClosedAttachmentVersion    uint64
	ChildRequestID             string
	DisabledRuntimeRevision    string
	DisabledRuntimeResult      *RuntimeOperation
	DrainDeadlineAt            time.Time
	State                      string
	Phase                      string
	ErrorCode                  string
	ManualReason               string
	CreatedAt                  time.Time
	UpdatedAt                  time.Time
}
