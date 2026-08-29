package admission

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"time"

	"soft/antnest-platform/services/runtime-controller/internal/application"
	"soft/antnest-platform/services/runtime-controller/internal/domain"
	"soft/antnest-platform/services/runtime-controller/internal/runtimeconn"
)

const heartbeatLease = 15 * time.Second

var requiredCapabilities = [...]string{
	"work.begin",
	"work.end",
	"process.exec",
	"file.read",
	"file.write",
	"file.edit",
	"file.list",
	"operation.cancel",
}

var _ runtimeconn.AdmissionStore = (*Store)(nil)

type StateReader interface {
	GetRuntime(context.Context, string) (domain.Runtime, error)
	FindGenerationByInstanceID(context.Context, string) (domain.RuntimeGeneration, error)
}

type Lifecycle interface {
	RuntimeConnected(context.Context, application.ConnectedInput) (domain.Runtime, error)
	RuntimeHealthy(context.Context, application.HealthyInput) (domain.Runtime, error)
	RuntimeDisconnected(context.Context, application.DisconnectedInput) error
}

type Store struct {
	state     StateReader
	lifecycle Lifecycle
	issuer    *Issuer
	now       func() time.Time
}

func NewStore(
	state StateReader, lifecycle Lifecycle, issuer *Issuer, now func() time.Time,
) (*Store, error) {
	if state == nil || lifecycle == nil || issuer == nil || now == nil {
		return nil, fmt.Errorf("runtime state, lifecycle, token issuer, and clock are required")
	}
	return &Store{state: state, lifecycle: lifecycle, issuer: issuer, now: now}, nil
}

func (s *Store) AdmitRuntimeSession(
	ctx context.Context, request runtimeconn.AdmissionRequest,
) (runtimeconn.AdmissionResult, error) {
	request.RuntimeInstanceID = strings.TrimSpace(request.RuntimeInstanceID)
	request.RuntimeBootID = strings.TrimSpace(request.RuntimeBootID)
	if request.RuntimeInstanceID == "" || request.RuntimeBootID == "" ||
		request.Generation == 0 || len(request.Capabilities) == 0 {
		return runtimeconn.AdmissionResult{}, fmt.Errorf("runtime admission identity and capabilities are required")
	}
	if err := validateCapabilities(request.Capabilities); err != nil {
		return runtimeconn.AdmissionResult{}, err
	}
	generation, err := s.state.FindGenerationByInstanceID(ctx, request.RuntimeInstanceID)
	if err != nil {
		return runtimeconn.AdmissionResult{}, err
	}
	if generation.Number != request.Generation || generation.RuntimeInstanceID != request.RuntimeInstanceID {
		return runtimeconn.AdmissionResult{}, domain.ErrGenerationFenced
	}
	runtime, err := s.state.GetRuntime(ctx, generation.AgentID)
	if err != nil {
		return runtimeconn.AdmissionResult{}, err
	}
	if runtime.DesiredState != domain.DesiredActive || runtime.DesiredGeneration != generation.Number {
		return runtimeconn.AdmissionResult{}, domain.ErrGenerationFenced
	}
	if !s.issuer.Verify(runtime.AgentID, generation.Number, request.Token) {
		return runtimeconn.AdmissionResult{}, fmt.Errorf("runtime admission token is invalid")
	}
	connectionEpoch := runtime.ConnectionEpoch + 1
	if _, err := s.lifecycle.RuntimeConnected(ctx, application.ConnectedInput{
		AgentID: runtime.AgentID, Generation: generation.Number,
		ConnectionEpoch: connectionEpoch, RuntimeInstanceID: generation.RuntimeInstanceID,
	}); err != nil {
		return runtimeconn.AdmissionResult{}, err
	}

	var tunnelIP netip.Addr
	if runtime.NetworkMode == domain.NetworkUnrestricted {
		tunnelIP, err = netip.ParseAddr(generation.TunnelIPv4)
		if err != nil || !tunnelIP.Is4() || generation.AllocatorEpoch == 0 {
			return runtimeconn.AdmissionResult{}, fmt.Errorf("runtime tunnel reservation is invalid")
		}
	}
	now := s.now().UTC()
	workEpochFloor := generation.WorkEpochFloor
	if workEpochFloor == 0 {
		workEpochFloor = 1
	}
	return runtimeconn.AdmissionResult{
		AgentID: runtime.AgentID, ConnectionEpoch: connectionEpoch, WorkEpochFloor: workEpochFloor,
		NetworkMode: string(runtime.NetworkMode), PolicyRevision: runtime.NetworkPolicyEpoch,
		PolicyEpoch: runtime.NetworkPolicyEpoch, LeaseExpiresAt: now.Add(heartbeatLease),
		TunnelVirtualIP: tunnelIP, AllocatorEpoch: generation.AllocatorEpoch,
	}, nil
}

func validateCapabilities(capabilities []string) error {
	available := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		capability = strings.TrimSpace(capability)
		if capability == "" {
			return fmt.Errorf("runtime capability must not be empty")
		}
		available[capability] = struct{}{}
	}
	for _, required := range requiredCapabilities {
		if _, ok := available[required]; !ok {
			return fmt.Errorf("runtime capability %q is required", required)
		}
	}
	return nil
}

func (s *Store) MarkRuntimeHealthy(
	ctx context.Context, request runtimeconn.HeartbeatRequest,
) (time.Time, error) {
	generation, runtime, err := s.currentSession(ctx, request.RuntimeInstanceID, request.Generation)
	if err != nil {
		return time.Time{}, err
	}
	if generation.ConnectionEpoch != request.ConnectionEpoch ||
		request.PolicyEpoch != runtime.NetworkPolicyEpoch ||
		request.PolicyRevision != runtime.NetworkPolicyEpoch {
		return time.Time{}, domain.ErrGenerationFenced
	}
	if runtime.Status != domain.RuntimeReady || runtime.ObservedPolicyEpoch != request.PolicyEpoch {
		if _, err := s.lifecycle.RuntimeHealthy(ctx, application.HealthyInput{
			AgentID: runtime.AgentID, Generation: generation.Number,
			ConnectionEpoch: request.ConnectionEpoch, PolicyEpoch: request.PolicyEpoch,
		}); err != nil {
			return time.Time{}, err
		}
	}
	return s.now().UTC().Add(heartbeatLease), nil
}

func (s *Store) MarkRuntimeSessionDisconnected(
	ctx context.Context, request runtimeconn.DisconnectRequest,
) error {
	generation, _, err := s.currentSession(ctx, request.RuntimeInstanceID, request.Generation)
	if err != nil {
		return err
	}
	err = s.lifecycle.RuntimeDisconnected(ctx, application.DisconnectedInput{
		AgentID: generation.AgentID, Generation: generation.Number,
		ConnectionEpoch: request.ConnectionEpoch,
	})
	if errors.Is(err, domain.ErrGenerationFenced) {
		return nil
	}
	return err
}

func (s *Store) currentSession(
	ctx context.Context, runtimeInstanceID string, generationNumber uint64,
) (domain.RuntimeGeneration, domain.Runtime, error) {
	generation, err := s.state.FindGenerationByInstanceID(ctx, strings.TrimSpace(runtimeInstanceID))
	if err != nil {
		return domain.RuntimeGeneration{}, domain.Runtime{}, err
	}
	if generation.Number != generationNumber {
		return domain.RuntimeGeneration{}, domain.Runtime{}, domain.ErrGenerationFenced
	}
	runtime, err := s.state.GetRuntime(ctx, generation.AgentID)
	if err != nil {
		return domain.RuntimeGeneration{}, domain.Runtime{}, err
	}
	if runtime.DesiredGeneration != generation.Number {
		return domain.RuntimeGeneration{}, domain.Runtime{}, domain.ErrGenerationFenced
	}
	return generation, runtime, nil
}
