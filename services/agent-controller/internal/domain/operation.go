package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type OperationKind string

const (
	OperationCreate  OperationKind = "create"
	OperationRebuild OperationKind = "rebuild"
	OperationDisable OperationKind = "disable"
	OperationEnable  OperationKind = "enable"
	OperationDelete  OperationKind = "delete"
)

type OperationState string

const (
	OperationRunning   OperationState = "running"
	OperationCompleted OperationState = "completed"
	OperationFailed    OperationState = "failed"
)

type OperationPhase string

const (
	PhaseDrain             OperationPhase = "drain"
	PhaseNetworkEnsure     OperationPhase = "network_ensure"
	PhaseNetworkFence      OperationPhase = "network_fence"
	PhaseFlowReset         OperationPhase = "flow_reset"
	PhaseRuntimeInitialize OperationPhase = "runtime_initialize"
	PhaseRuntimeUpdate     OperationPhase = "runtime_update"
	PhaseRuntimeDisable    OperationPhase = "runtime_disable"
	PhaseRuntimeEnable     OperationPhase = "runtime_enable"
	PhaseRuntimeDelete     OperationPhase = "runtime_delete"
	PhaseNetworkRelease    OperationPhase = "network_release"
	PhasePublish           OperationPhase = "publish"
	PhaseCompleted         OperationPhase = "completed"
)

var operationPlans = map[OperationKind][]OperationPhase{
	OperationCreate: {
		PhaseNetworkEnsure,
		PhaseRuntimeInitialize,
		PhasePublish,
	},
	OperationRebuild: {
		PhaseDrain,
		PhaseNetworkFence,
		PhaseFlowReset,
		PhaseRuntimeUpdate,
		PhaseNetworkEnsure,
		PhasePublish,
	},
	OperationDisable: {
		PhaseDrain,
		PhaseNetworkFence,
		PhaseRuntimeDisable,
		PhasePublish,
	},
	OperationEnable: {
		PhaseNetworkEnsure,
		PhaseRuntimeEnable,
		PhasePublish,
	},
	OperationDelete: {
		PhaseDrain,
		PhaseNetworkFence,
		PhaseFlowReset,
		PhaseRuntimeDelete,
		PhaseNetworkRelease,
		PhasePublish,
	},
}

type NewLifecycleOperationInput struct {
	RequestID             string
	RequestFingerprint    string
	AgentID               string
	Kind                  OperationKind
	SourceSpecRevision    string
	SourceRuntimeRevision string
	SourceRuntimeAbsent   bool
	TargetSpecRevision    string
	InitialTraceParent    string
	Now                   time.Time
}

type LifecycleOperation struct {
	input          NewLifecycleOperationInput
	plan           []OperationPhase
	phaseIndex     int
	state          OperationState
	childRequestID string
	errorCode      string
	errorDetail    string
	retryable      bool
	updatedAt      time.Time
}

func NewLifecycleOperation(input NewLifecycleOperationInput) (*LifecycleOperation, error) {
	if err := validateOperationInput(input); err != nil {
		return nil, err
	}
	plan, err := operationPlanFor(input)
	if err != nil {
		return nil, err
	}
	operation := &LifecycleOperation{
		input:     input,
		plan:      plan,
		state:     OperationRunning,
		updatedAt: input.Now,
	}
	operation.childRequestID = childRequestID(input.RequestID, plan[0])
	return operation, nil
}

func OperationPlan(kind OperationKind) ([]OperationPhase, error) {
	plan, ok := operationPlans[kind]
	if !ok {
		return nil, fmt.Errorf("unknown operation kind %q", kind)
	}
	return append([]OperationPhase(nil), plan...), nil
}

func (operation *LifecycleOperation) Phase() OperationPhase {
	if operation.state == OperationCompleted {
		return PhaseCompleted
	}
	return operation.plan[operation.phaseIndex]
}

func (operation *LifecycleOperation) State() OperationState {
	return operation.state
}

func (operation *LifecycleOperation) ChildRequestID() string {
	return operation.childRequestID
}

func (operation *LifecycleOperation) ApplyPhaseSuccess(phase OperationPhase, now time.Time) error {
	if operation.state != OperationRunning {
		return fmt.Errorf("operation is %s", operation.state)
	}
	if phase != operation.Phase() {
		return fmt.Errorf("operation phase is %s, not %s", operation.Phase(), phase)
	}
	operation.phaseIndex++
	operation.updatedAt = now
	if operation.phaseIndex == len(operation.plan) {
		operation.state = OperationCompleted
		operation.childRequestID = ""
		return nil
	}
	operation.childRequestID = childRequestID(operation.input.RequestID, operation.Phase())
	return nil
}

func (operation *LifecycleOperation) Fail(code string, detail string, retryable bool, now time.Time) error {
	if operation.state != OperationRunning {
		return fmt.Errorf("operation is %s", operation.state)
	}
	if strings.TrimSpace(code) == "" {
		return fmt.Errorf("failure code is required")
	}
	operation.state = OperationFailed
	operation.errorCode = code
	operation.errorDetail = detail
	operation.retryable = retryable
	operation.updatedAt = now
	return nil
}

func (operation *LifecycleOperation) Retry(now time.Time) error {
	if operation.state != OperationFailed || !operation.retryable {
		return fmt.Errorf("operation cannot be retried")
	}
	operation.state = OperationRunning
	operation.errorCode = ""
	operation.errorDetail = ""
	operation.retryable = false
	operation.updatedAt = now
	return nil
}

func validateOperationInput(input NewLifecycleOperationInput) error {
	if strings.TrimSpace(input.RequestID) == "" || strings.TrimSpace(input.RequestFingerprint) == "" ||
		strings.TrimSpace(input.AgentID) == "" {
		return fmt.Errorf("request, fingerprint, and Agent identities are required")
	}
	if input.Now.IsZero() {
		return fmt.Errorf("operation time is required")
	}
	sourceSpec := strings.TrimSpace(input.SourceSpecRevision)
	sourceRuntime := strings.TrimSpace(input.SourceRuntimeRevision)
	targetSpec := strings.TrimSpace(input.TargetSpecRevision)
	switch input.Kind {
	case OperationCreate:
		if targetSpec == "" || sourceSpec != "" || sourceRuntime != "" || input.SourceRuntimeAbsent {
			return fmt.Errorf("create operation requires only a target Agent spec revision")
		}
	case OperationRebuild:
		if sourceSpec == "" || sourceRuntime == "" || targetSpec == "" || input.SourceRuntimeAbsent {
			return fmt.Errorf("rebuild operation requires source Agent spec, source Runtime, and target Agent spec revisions")
		}
	case OperationDisable:
		if sourceSpec == "" || sourceRuntime == "" || targetSpec != "" || input.SourceRuntimeAbsent {
			return fmt.Errorf("disable operation requires only source Agent spec and Runtime revisions")
		}
	case OperationEnable:
		if sourceSpec == "" || sourceRuntime == "" || targetSpec == "" || input.SourceRuntimeAbsent {
			return fmt.Errorf("enable operation requires source Agent spec, source Runtime, and target Agent spec revisions")
		}
	case OperationDelete:
		if targetSpec != "" || (sourceRuntime != "") == input.SourceRuntimeAbsent {
			return fmt.Errorf("delete operation requires exactly one of a source Runtime revision or proof that Runtime is absent")
		}
		if sourceRuntime != "" && sourceSpec == "" {
			return fmt.Errorf("delete operation with a source Runtime requires its source Agent spec revision")
		}
	default:
		return fmt.Errorf("unknown operation kind %q", input.Kind)
	}
	return nil
}

func operationPlanFor(input NewLifecycleOperationInput) ([]OperationPhase, error) {
	plan, err := OperationPlan(input.Kind)
	if err != nil {
		return nil, err
	}
	if input.Kind != OperationDelete || !input.SourceRuntimeAbsent {
		return plan, nil
	}
	result := make([]OperationPhase, 0, len(plan)-1)
	for _, phase := range plan {
		if phase != PhaseRuntimeDelete {
			result = append(result, phase)
		}
	}
	return result, nil
}

func childRequestID(requestID string, phase OperationPhase) string {
	digest := sha256.Sum256([]byte(requestID + "\x00" + string(phase)))
	return "acr_" + hex.EncodeToString(digest[:16])
}
