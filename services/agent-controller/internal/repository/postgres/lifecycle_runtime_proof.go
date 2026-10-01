package postgres

import (
	"time"

	"github.com/tf4fun/antnest-platform/services/agent-controller/internal/ports"
)

func validRuntimeRemovalProof(operation ports.LifecycleOperationRecord, proof *ports.RuntimeAbsenceProof, now time.Time) bool {
	return proof.Reason == "runtime_deleted" &&
		proof.RuntimeRevision == operation.SourceRuntimeRevision &&
		!proof.ObservedAt.IsZero() && !proof.ObservedAt.After(now)
}
