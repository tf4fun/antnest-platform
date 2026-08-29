package domain

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

var (
	ErrGenerationFenced    = errors.New("runtime generation is fenced")
	ErrIdempotencyConflict = errors.New("idempotency key was already used for another request")
	ErrConcurrentWrite     = errors.New("runtime state changed concurrently")
	ErrInvalidArgument     = errors.New("invalid runtime argument")
)

const (
	MaxAgentIDCharacters        = 100
	MaxIdempotencyKeyCharacters = 200
)

type NetworkMode string

const (
	NetworkRestricted   NetworkMode = "restricted"
	NetworkUnrestricted NetworkMode = "unrestricted"
)

type DesiredState string

const (
	DesiredActive  DesiredState = "active"
	DesiredStopped DesiredState = "stopped"
	DesiredRetired DesiredState = "retired"
	DesiredPurged  DesiredState = "purged"
)

type RuntimeStatus string

const (
	RuntimePending  RuntimeStatus = "pending"
	RuntimeStarting RuntimeStatus = "starting"
	RuntimeReady    RuntimeStatus = "ready"
	RuntimeStopping RuntimeStatus = "stopping"
	RuntimeStopped  RuntimeStatus = "stopped"
	RuntimeRetiring RuntimeStatus = "retiring"
	RuntimeRetired  RuntimeStatus = "retired"
	RuntimePurging  RuntimeStatus = "purging"
	RuntimePurged   RuntimeStatus = "purged"
	RuntimeFailed   RuntimeStatus = "failed"
)

type OperationStatus string

const (
	OperationPending    OperationStatus = "pending"
	OperationRunning    OperationStatus = "running"
	OperationSucceeded  OperationStatus = "succeeded"
	OperationFailed     OperationStatus = "failed"
	OperationUnknown    OperationStatus = "unknown"
	OperationSuperseded OperationStatus = "superseded"
)

type OperationKind string

const (
	OperationPrepare       OperationKind = "prepare"
	OperationStop          OperationKind = "stop"
	OperationRetire        OperationKind = "retire"
	OperationPurge         OperationKind = "purge"
	OperationUpdateNetwork OperationKind = "update_network"
)

type Runtime struct {
	AgentID             string
	ImageRef            string
	NetworkMode         NetworkMode
	DesiredState        DesiredState
	Status              RuntimeStatus
	DesiredGeneration   uint64
	ObservedGeneration  uint64
	ConnectionEpoch     uint64
	NetworkPolicyEpoch  uint64
	ObservedPolicyEpoch uint64
	SpecDigest          string
	FailureCode         string
	FailureDetail       string
	ResourceVersion     uint64
	CreatedAt           time.Time
	UpdatedAt           time.Time
}

type GenerationStatus string

const (
	GenerationPending  GenerationStatus = "pending"
	GenerationStarting GenerationStatus = "starting"
	GenerationReady    GenerationStatus = "ready"
	GenerationStopped  GenerationStatus = "stopped"
	GenerationRetired  GenerationStatus = "retired"
	GenerationFailed   GenerationStatus = "failed"
)

type RuntimeGeneration struct {
	AgentID            string
	Number             uint64
	ImageRef           string
	SpecDigest         string
	NetworkPolicyEpoch uint64
	TunnelIPv4         string
	AllocatorEpoch     uint64
	Status             GenerationStatus
	ContainerID        string
	RuntimeInstanceID  string
	ConnectionEpoch    uint64
	WorkEpochFloor     uint64
	LastWorkID         string
	LastWorkEpoch      uint64
	LastWorkSessionID  string
	FailureCode        string
	FailureDetail      string
	RetryCount         uint32
	NextAttemptAt      time.Time
	ResourceVersion    uint64
	CreatedAt          time.Time
	UpdatedAt          time.Time
}

type Operation struct {
	ID             string
	AgentID        string
	Kind           OperationKind
	Status         OperationStatus
	Generation     uint64
	IdempotencyKey string
	RequestDigest  string
	ErrorCode      string
	ErrorDetail    string
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

type PrepareCommand struct {
	AgentID        string
	ImageRef       string
	NetworkMode    NetworkMode
	IdempotencyKey string
	OperationID    string
	Now            time.Time
}

type PreparePlan struct {
	Runtime    Runtime
	Generation *RuntimeGeneration
	Operation  Operation
	Replayed   bool
}

func PlanPrepare(current *Runtime, existing *Operation, command PrepareCommand) (PreparePlan, error) {
	command = normalizePrepare(command)
	if err := command.validate(); err != nil {
		return PreparePlan{}, err
	}
	requestDigest := prepareDigest(command)
	if existing != nil && existing.IdempotencyKey == command.IdempotencyKey {
		if existing.AgentID != command.AgentID || existing.RequestDigest != requestDigest {
			return PreparePlan{}, ErrIdempotencyConflict
		}
		if current == nil {
			return PreparePlan{}, fmt.Errorf("idempotent operation has no runtime state")
		}
		return PreparePlan{Runtime: *current, Operation: *existing, Replayed: true}, nil
	}

	generation := uint64(1)
	resourceVersion := uint64(1)
	createdAt := command.Now
	status := OperationPending
	createGeneration := current == nil
	networkPolicyEpoch := uint64(1)
	if current != nil {
		if current.AgentID != command.AgentID {
			return PreparePlan{}, fmt.Errorf("runtime belongs to agent %q", current.AgentID)
		}
		generation = current.DesiredGeneration
		if generation == 0 {
			generation = 1
			createGeneration = true
		}
		if current.SpecDigest != requestDigest || current.DesiredState == DesiredRetired ||
			current.DesiredState == DesiredPurged || current.Status == RuntimeRetired ||
			current.Status == RuntimePurged || current.Status == RuntimeFailed {
			generation++
			createGeneration = true
		} else if current.Status == RuntimeReady && current.ObservedGeneration == generation {
			status = OperationSucceeded
		}
		resourceVersion = current.ResourceVersion + 1
		createdAt = current.CreatedAt
		networkPolicyEpoch = current.NetworkPolicyEpoch
		if networkPolicyEpoch == 0 {
			networkPolicyEpoch = 1
		}
		if current.NetworkMode != command.NetworkMode {
			networkPolicyEpoch++
		}
	}

	runtime := Runtime{
		AgentID:            command.AgentID,
		ImageRef:           command.ImageRef,
		NetworkMode:        command.NetworkMode,
		DesiredState:       DesiredActive,
		Status:             RuntimePending,
		DesiredGeneration:  generation,
		SpecDigest:         requestDigest,
		ResourceVersion:    resourceVersion,
		CreatedAt:          createdAt,
		UpdatedAt:          command.Now,
		NetworkPolicyEpoch: networkPolicyEpoch,
	}
	if current != nil && current.SpecDigest == requestDigest && !createGeneration {
		runtime = *current
		runtime.DesiredState = DesiredActive
		runtime.ResourceVersion = resourceVersion
		runtime.UpdatedAt = command.Now
	}

	operationID := command.OperationID
	if operationID == "" {
		operationID = command.IdempotencyKey
	}
	var generationRecord *RuntimeGeneration
	if createGeneration {
		generationRecord = &RuntimeGeneration{
			AgentID: command.AgentID, Number: generation, ImageRef: command.ImageRef,
			SpecDigest: requestDigest, NetworkPolicyEpoch: networkPolicyEpoch,
			Status: GenerationPending, WorkEpochFloor: 1, ResourceVersion: 1,
			CreatedAt: command.Now, UpdatedAt: command.Now,
		}
	}
	return PreparePlan{
		Runtime: runtime, Generation: generationRecord,
		Operation: Operation{
			ID:             operationID,
			AgentID:        command.AgentID,
			Kind:           OperationPrepare,
			Status:         status,
			Generation:     generation,
			IdempotencyKey: command.IdempotencyKey,
			RequestDigest:  requestDigest,
			CreatedAt:      command.Now,
			UpdatedAt:      command.Now,
		},
	}, nil
}

type RuntimeConnected struct {
	Generation        uint64
	ConnectionEpoch   uint64
	RuntimeInstanceID string
	ConnectedAt       time.Time
}

func PlanRuntimeConnected(current Runtime, connected RuntimeConnected) (Runtime, error) {
	if connected.Generation == 0 || connected.Generation != current.DesiredGeneration {
		return Runtime{}, ErrGenerationFenced
	}
	if connected.ConnectionEpoch == 0 {
		return Runtime{}, fmt.Errorf("connection epoch must be positive")
	}
	if connected.ConnectionEpoch <= current.ConnectionEpoch {
		return Runtime{}, ErrGenerationFenced
	}
	if connected.ConnectedAt.IsZero() {
		return Runtime{}, fmt.Errorf("connected time is required")
	}
	current.Status = RuntimeStarting
	current.ObservedGeneration = connected.Generation
	current.ConnectionEpoch = connected.ConnectionEpoch
	current.FailureCode = ""
	current.FailureDetail = ""
	current.ResourceVersion++
	current.UpdatedAt = connected.ConnectedAt.UTC()
	return current, nil
}

type RuntimeDisconnected struct {
	Generation      uint64
	ConnectionEpoch uint64
	DisconnectedAt  time.Time
}

func PlanGenerationDisconnected(
	current Runtime, generation RuntimeGeneration, disconnected RuntimeDisconnected,
) (Runtime, RuntimeGeneration, error) {
	if disconnected.Generation == 0 || disconnected.Generation != current.DesiredGeneration ||
		generation.Number != disconnected.Generation || generation.AgentID != current.AgentID ||
		disconnected.ConnectionEpoch == 0 || disconnected.ConnectionEpoch != current.ConnectionEpoch ||
		disconnected.ConnectionEpoch != generation.ConnectionEpoch {
		return Runtime{}, RuntimeGeneration{}, ErrGenerationFenced
	}
	if disconnected.DisconnectedAt.IsZero() {
		return Runtime{}, RuntimeGeneration{}, fmt.Errorf("disconnect observation time is required")
	}
	if current.DesiredState == DesiredActive {
		current.Status = RuntimeStarting
		generation.Status = GenerationStarting
	}
	current.ResourceVersion++
	current.UpdatedAt = disconnected.DisconnectedAt.UTC()
	generation.ResourceVersion++
	generation.UpdatedAt = disconnected.DisconnectedAt.UTC()
	return current, generation, nil
}

func PlanGenerationConnected(
	current Runtime, generation RuntimeGeneration, connected RuntimeConnected,
) (Runtime, RuntimeGeneration, error) {
	if generation.AgentID != current.AgentID || generation.Number != connected.Generation {
		return Runtime{}, RuntimeGeneration{}, ErrGenerationFenced
	}
	if strings.TrimSpace(connected.RuntimeInstanceID) == "" ||
		strings.TrimSpace(generation.RuntimeInstanceID) != strings.TrimSpace(connected.RuntimeInstanceID) {
		return Runtime{}, RuntimeGeneration{}, fmt.Errorf("runtime instance id is required")
	}
	next, err := PlanRuntimeConnected(current, connected)
	if err != nil {
		return Runtime{}, RuntimeGeneration{}, err
	}
	generation.Status = GenerationStarting
	generation.RuntimeInstanceID = strings.TrimSpace(connected.RuntimeInstanceID)
	generation.ConnectionEpoch = connected.ConnectionEpoch
	generation.FailureCode = ""
	generation.FailureDetail = ""
	generation.NextAttemptAt = time.Time{}
	generation.ResourceVersion++
	generation.UpdatedAt = connected.ConnectedAt.UTC()
	return next, generation, nil
}

func RuntimeInstanceID(agentID string, generation uint64) string {
	hash := sha256.Sum256([]byte(strings.TrimSpace(agentID) + "\x00" + strconv.FormatUint(generation, 10)))
	return "rt-" + hex.EncodeToString(hash[:8])
}

type RuntimeHealthy struct {
	Generation      uint64
	ConnectionEpoch uint64
	PolicyEpoch     uint64
	ObservedAt      time.Time
}

func PlanGenerationHealthy(
	current Runtime, generation RuntimeGeneration, observed RuntimeHealthy,
) (Runtime, RuntimeGeneration, error) {
	if observed.Generation == 0 || observed.Generation != current.DesiredGeneration ||
		generation.Number != observed.Generation || generation.AgentID != current.AgentID {
		return Runtime{}, RuntimeGeneration{}, ErrGenerationFenced
	}
	if observed.ConnectionEpoch == 0 || observed.ConnectionEpoch != current.ConnectionEpoch ||
		observed.ConnectionEpoch != generation.ConnectionEpoch {
		return Runtime{}, RuntimeGeneration{}, ErrGenerationFenced
	}
	if observed.PolicyEpoch == 0 || observed.PolicyEpoch != current.NetworkPolicyEpoch {
		return Runtime{}, RuntimeGeneration{}, ErrGenerationFenced
	}
	if observed.ObservedAt.IsZero() {
		return Runtime{}, RuntimeGeneration{}, fmt.Errorf("health observation time is required")
	}
	current.Status = RuntimeReady
	current.ObservedGeneration = observed.Generation
	current.ObservedPolicyEpoch = observed.PolicyEpoch
	current.FailureCode = ""
	current.FailureDetail = ""
	current.ResourceVersion++
	current.UpdatedAt = observed.ObservedAt.UTC()
	generation.Status = GenerationReady
	generation.NetworkPolicyEpoch = observed.PolicyEpoch
	generation.FailureCode = ""
	generation.FailureDetail = ""
	generation.NextAttemptAt = time.Time{}
	generation.ResourceVersion++
	generation.UpdatedAt = observed.ObservedAt.UTC()
	return current, generation, nil
}

func normalizePrepare(command PrepareCommand) PrepareCommand {
	command.AgentID = strings.TrimSpace(command.AgentID)
	command.ImageRef = strings.TrimSpace(command.ImageRef)
	command.IdempotencyKey = strings.TrimSpace(command.IdempotencyKey)
	command.OperationID = strings.TrimSpace(command.OperationID)
	command.Now = command.Now.UTC()
	return command
}

func (c PrepareCommand) validate() error {
	if err := ValidateAgentID(c.AgentID); err != nil {
		return err
	}
	if c.ImageRef == "" {
		return fmt.Errorf("runtime image is required")
	}
	if err := validateIdempotencyKey(c.IdempotencyKey); err != nil {
		return err
	}
	if c.Now.IsZero() {
		return fmt.Errorf("request time is required")
	}
	switch c.NetworkMode {
	case NetworkRestricted, NetworkUnrestricted:
		return nil
	default:
		return fmt.Errorf("unsupported network mode %q", c.NetworkMode)
	}
}

func ValidateAgentID(value string) error {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > MaxAgentIDCharacters {
		return fmt.Errorf("agent id must contain 1 to %d ASCII characters", MaxAgentIDCharacters)
	}
	for _, character := range value {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' ||
			character >= '0' && character <= '9' || character == '-' || character == '_' || character == '.' {
			continue
		}
		return fmt.Errorf("agent id contains unsupported character %q", character)
	}
	return nil
}

func validateIdempotencyKey(value string) error {
	if strings.TrimSpace(value) == "" {
		return fmt.Errorf("idempotency key is required")
	}
	if utf8.RuneCountInString(value) > MaxIdempotencyKeyCharacters {
		return fmt.Errorf("idempotency key exceeds %d characters", MaxIdempotencyKeyCharacters)
	}
	return nil
}

func prepareDigest(command PrepareCommand) string {
	return runtimeSpecDigest(command.ImageRef, command.NetworkMode)
}

func runtimeSpecDigest(imageRef string, networkMode NetworkMode) string {
	hash := sha256.Sum256([]byte(imageRef + "\x00" + string(networkMode)))
	return hex.EncodeToString(hash[:])
}
