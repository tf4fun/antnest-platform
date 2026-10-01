package ports

import "github.com/tf4fun/antnest-platform/services/agent-controller/internal/domain"

type QuarantineLifecycleOperation struct {
	RequestID     string
	Fingerprint   string
	ExpectedPhase domain.OperationPhase
	ErrorCode     string
	ErrorDetail   string
	EventID       string
	TraceID       string
}
