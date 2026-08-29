package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"time"
)

type LifecycleCommand struct {
	AgentID        string
	Kind           OperationKind
	IdempotencyKey string
	OperationID    string
	Now            time.Time
}

type LifecyclePlan struct {
	Runtime         Runtime
	Operation       Operation
	RetainWorkspace bool
	Replayed        bool
}

func PlanLifecycle(current Runtime, existing *Operation, command LifecycleCommand) (LifecyclePlan, error) {
	command = normalizeLifecycle(command)
	if err := validateLifecycle(current, command); err != nil {
		return LifecyclePlan{}, err
	}
	digest := lifecycleDigest(command)
	if existing != nil {
		if existing.AgentID != command.AgentID || existing.Kind != command.Kind || existing.RequestDigest != digest {
			return LifecyclePlan{}, ErrIdempotencyConflict
		}
		return LifecyclePlan{
			Runtime: current, Operation: *existing,
			RetainWorkspace: command.Kind != OperationPurge, Replayed: true,
		}, nil
	}

	desired, status, retain := lifecycleTarget(command.Kind)
	current.DesiredState = desired
	current.Status = status
	current.ResourceVersion++
	current.UpdatedAt = command.Now

	operationID := command.OperationID
	if operationID == "" {
		operationID = command.IdempotencyKey
	}
	operation := Operation{
		ID: operationID, AgentID: command.AgentID, Kind: command.Kind,
		Status: OperationPending, Generation: current.DesiredGeneration,
		IdempotencyKey: command.IdempotencyKey, RequestDigest: digest,
		CreatedAt: command.Now, UpdatedAt: command.Now,
	}
	return LifecyclePlan{Runtime: current, Operation: operation, RetainWorkspace: retain}, nil
}

type NetworkPolicyCommand struct {
	AgentID        string
	NetworkMode    NetworkMode
	IdempotencyKey string
	OperationID    string
	Now            time.Time
}

type NetworkPolicyPlan struct {
	Runtime    Runtime
	Generation *RuntimeGeneration
	Operation  Operation
	Replayed   bool
}

func PlanNetworkPolicy(current Runtime, existing *Operation, command NetworkPolicyCommand) (NetworkPolicyPlan, error) {
	command.AgentID = strings.TrimSpace(command.AgentID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	command.OperationID = strings.TrimSpace(command.OperationID)
	command.Now = command.Now.UTC()
	if err := ValidateAgentID(command.AgentID); err != nil {
		return NetworkPolicyPlan{}, err
	}
	if current.AgentID != command.AgentID {
		return NetworkPolicyPlan{}, fmt.Errorf("runtime does not belong to agent %q", command.AgentID)
	}
	if err := validateIdempotencyKey(command.IdempotencyKey); err != nil {
		return NetworkPolicyPlan{}, err
	}
	if command.Now.IsZero() {
		return NetworkPolicyPlan{}, fmt.Errorf("request time is required")
	}
	if command.NetworkMode != NetworkRestricted && command.NetworkMode != NetworkUnrestricted {
		return NetworkPolicyPlan{}, fmt.Errorf("unsupported network mode %q", command.NetworkMode)
	}
	if current.DesiredState != DesiredActive {
		return NetworkPolicyPlan{}, fmt.Errorf("network policy can only change for an active runtime")
	}
	digest := hashParts(string(command.NetworkMode))
	if existing != nil {
		if existing.AgentID != command.AgentID || existing.Kind != OperationUpdateNetwork || existing.RequestDigest != digest {
			return NetworkPolicyPlan{}, ErrIdempotencyConflict
		}
		return NetworkPolicyPlan{Runtime: current, Operation: *existing, Replayed: true}, nil
	}

	status := OperationSucceeded
	var generation *RuntimeGeneration
	if current.NetworkMode != command.NetworkMode {
		status = OperationPending
		current.NetworkMode = command.NetworkMode
		current.NetworkPolicyEpoch++
		if current.NetworkPolicyEpoch == 0 {
			current.NetworkPolicyEpoch = 1
		}
		current.DesiredGeneration++
		if current.DesiredGeneration == 0 {
			current.DesiredGeneration = 1
		}
		current.SpecDigest = runtimeSpecDigest(current.ImageRef, command.NetworkMode)
		current.Status = RuntimePending
		generation = &RuntimeGeneration{
			AgentID: current.AgentID, Number: current.DesiredGeneration,
			ImageRef: current.ImageRef, SpecDigest: current.SpecDigest,
			NetworkPolicyEpoch: current.NetworkPolicyEpoch,
			Status:             GenerationPending, WorkEpochFloor: 1, ResourceVersion: 1,
			CreatedAt: command.Now, UpdatedAt: command.Now,
		}
	} else if current.Status != RuntimeReady ||
		current.ObservedPolicyEpoch != current.NetworkPolicyEpoch {
		status = OperationPending
	}
	current.ResourceVersion++
	current.UpdatedAt = command.Now

	operationID := command.OperationID
	if operationID == "" {
		operationID = command.IdempotencyKey
	}
	return NetworkPolicyPlan{
		Runtime: current, Generation: generation,
		Operation: Operation{
			ID: operationID, AgentID: command.AgentID, Kind: OperationUpdateNetwork,
			Status: status, Generation: current.DesiredGeneration,
			IdempotencyKey: command.IdempotencyKey, RequestDigest: digest,
			CreatedAt: command.Now, UpdatedAt: command.Now,
		},
	}, nil
}

func normalizeLifecycle(command LifecycleCommand) LifecycleCommand {
	command.AgentID = strings.TrimSpace(command.AgentID)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	command.OperationID = strings.TrimSpace(command.OperationID)
	command.Now = command.Now.UTC()
	return command
}

func validateLifecycle(current Runtime, command LifecycleCommand) error {
	if err := ValidateAgentID(command.AgentID); err != nil {
		return err
	}
	if current.AgentID != command.AgentID {
		return fmt.Errorf("runtime does not belong to agent %q", command.AgentID)
	}
	if err := validateIdempotencyKey(command.IdempotencyKey); err != nil {
		return err
	}
	if command.Now.IsZero() {
		return fmt.Errorf("request time is required")
	}
	switch command.Kind {
	case OperationStop, OperationRetire, OperationPurge:
		return nil
	default:
		return fmt.Errorf("unsupported lifecycle operation %q", command.Kind)
	}
}

func lifecycleTarget(kind OperationKind) (DesiredState, RuntimeStatus, bool) {
	switch kind {
	case OperationStop:
		return DesiredStopped, RuntimeStopping, true
	case OperationRetire:
		return DesiredRetired, RuntimeRetiring, true
	default:
		return DesiredPurged, RuntimePurging, false
	}
}

func lifecycleDigest(command LifecycleCommand) string {
	return hashParts(string(command.Kind))
}

func hashParts(parts ...string) string {
	hash := sha256.New()
	for _, part := range parts {
		_, _ = hash.Write([]byte(part))
		_, _ = hash.Write([]byte{0})
	}
	return hex.EncodeToString(hash.Sum(nil))
}
