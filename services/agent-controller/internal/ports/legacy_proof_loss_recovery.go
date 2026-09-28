package ports

import "time"

// BeginLegacyProofLossRecovery is the immutable, pre-effect admission snapshot.
// The application must inspect the actual RC target and closed Egress
// attachment before asking the repository to reserve this recovery.
type BeginLegacyProofLossRecovery struct {
	RequestID                  string
	Fingerprint                string
	AgentID                    string
	OrganizationID             string
	ActorPrincipalID           string
	FailedMigrationRequestID   string
	TargetRuntimeRevision      string
	ObservedRuntimeExecutionID string
	ClosedAttachmentVersion    uint64
	ExpectedAggregateSequence  int64
	ChildRequestID             string
	Now                        time.Time
}

type LegacyProofLossRecoveryRecord struct {
	RequestID                  string
	Fingerprint                string
	AgentID                    string
	OrganizationID             string
	ActorPrincipalID           string
	FailedMigrationRequestID   string
	TargetRuntimeRevision      string
	ObservedRuntimeExecutionID string
	ClosedAttachmentVersion    uint64
	ChildRequestID             string
	DisabledRuntimeRevision    string
	DisabledRuntimeResult      *RuntimeOperation
	State                      string
	Phase                      string
	ErrorCode                  string
	ManualReason               string
	CreatedAt                  time.Time
	UpdatedAt                  time.Time
}
