package application

import (
	"context"
	"fmt"

	"soft/antnest-platform/services/agent-controller/internal/domain"
	"soft/antnest-platform/services/agent-controller/internal/ports"
)

const legacyMigrationProofLostCode = "legacy_migration_proof_lost"

// Once Runtime has changed, a lost migration grant cannot be retried with the
// bound proof. Fence the actual attachment before ending the operation; if
// fencing is inconclusive, retain the running operation for a later retry.
func (service *LifecycleService) settleLegacyMigrationProofLoss(ctx context.Context, operation ports.LifecycleOperationRecord) error {
	attachment, err := service.setCurrentNetworkAttachmentState(ctx, operation, ports.NetworkAttachmentClosed)
	if err != nil {
		return fmt.Errorf("%w: close network after lost legacy migration proof: %v", ErrDependencyUnavailable, err)
	}
	if !networkAttachmentInState(attachment, operation.AgentID, ports.NetworkStateActive, ports.NetworkAttachmentClosed) {
		return fmt.Errorf("%w: network close after lost legacy migration proof was not confirmed", ErrDependencyUnavailable)
	}
	return service.store.QuarantineLifecycleOperation(ctx, ports.QuarantineLifecycleOperation{
		RequestID: operation.RequestID, Fingerprint: operation.RequestFingerprint,
		ExpectedPhase: domain.PhasePublish, ErrorCode: legacyMigrationProofLostCode,
		ErrorDetail: "Bound legacy migration proof is no longer valid; reconcile Runtime before retrying",
		EventID:     domain.DeriveResourceID("event", "event-legacy-migration-proof-lost", operation.RequestID),
		TraceID:     currentTraceID(ctx),
	})
}
