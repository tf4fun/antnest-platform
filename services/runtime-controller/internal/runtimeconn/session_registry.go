package runtimeconn

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-controller/internal/runtimeprotocol"
)

const (
	ProtocolVersion       = 1
	defaultConnectTimeout = 10 * time.Second
	defaultHeartbeatLease = 15 * time.Second
)

var (
	ErrSessionActive      = errors.New("runtime generation already has an active session")
	ErrSessionUnavailable = errors.New("runtime session is unavailable")
)

type AdmissionRequest struct {
	Token             string
	RuntimeInstanceID string
	Generation        uint64
	RuntimeBootID     string
	Capabilities      []string
	PreviousWork      *CleanupReceipt
}

type AdmissionResult struct {
	AgentID         string
	ConnectionEpoch uint64
	WorkEpochFloor  uint64
	NetworkMode     string
	PolicyRevision  uint64
	PolicyEpoch     uint64
	LeaseExpiresAt  time.Time
	TunnelVirtualIP netip.Addr
	AllocatorEpoch  uint64
}

type HeartbeatRequest struct {
	RuntimeInstanceID string
	Generation        uint64
	ConnectionEpoch   uint64
	PolicyRevision    uint64
	PolicyEpoch       uint64
}

type DisconnectRequest struct {
	RuntimeInstanceID string
	Generation        uint64
	ConnectionEpoch   uint64
	Reason            string
}

type AdmissionStore interface {
	AdmitRuntimeSession(context.Context, AdmissionRequest) (AdmissionResult, error)
	MarkRuntimeHealthy(context.Context, HeartbeatRequest) (time.Time, error)
	MarkRuntimeSessionDisconnected(context.Context, DisconnectRequest) error
}

type CleanupReceipt struct {
	State          string `json:"state"`
	WorkID         string `json:"work_id,omitempty"`
	WorkEpoch      uint64 `json:"work_epoch,omitempty"`
	WorkSessionID  string `json:"work_session_id,omitempty"`
	CleanupReceipt string `json:"cleanup_receipt,omitempty"`
}

type ConnectInput struct {
	ProtocolVersion   int             `json:"protocol_version"`
	RuntimeInstanceID string          `json:"runtime_instance_id"`
	Generation        uint64          `json:"generation"`
	RuntimeBootID     string          `json:"runtime_boot_id"`
	PreviousWork      *CleanupReceipt `json:"previous_work,omitempty"`
	Capabilities      []string        `json:"capabilities"`
	Bootstrap         map[string]any  `json:"bootstrap,omitempty"`
}

type ConnectResult struct {
	ProtocolVersion    int    `json:"protocol_version"`
	RuntimeInstanceID  string `json:"runtime_instance_id"`
	Generation         uint64 `json:"generation"`
	AgentID            string `json:"agent_id"`
	ConnectionEpoch    uint64 `json:"connection_epoch"`
	WorkEpochFloor     uint64 `json:"work_epoch_floor"`
	NetworkMode        string `json:"network_mode"`
	PolicyRevision     uint64 `json:"policy_revision"`
	PolicyEpoch        uint64 `json:"policy_epoch"`
	LeaseExpiresUnixMS int64  `json:"lease_expires_unix_ms"`
	EgressEndpoint     string `json:"egress_endpoint"`
	EgressToken        string `json:"egress_token"`
	EgressTokenExpires int64  `json:"egress_token_expires_unix_ms"`
}

type HeartbeatInput struct {
	PolicyRevision uint64 `json:"policy_revision"`
	PolicyEpoch    uint64 `json:"policy_epoch"`
}

type HeartbeatResult struct {
	LeaseExpiresUnixMS int64 `json:"lease_expires_unix_ms"`
}

type ActiveSession struct {
	ConnectionEpoch uint64
	PolicyRevision  uint64
	PolicyEpoch     uint64
}

type EgressTokenInput struct {
	AgentID           string
	RuntimeInstanceID string
	Generation        uint64
	RuntimeBootID     string
	ConnectionEpoch   uint64
	VirtualIP         netip.Addr
	AllocatorEpoch    uint64
	PolicyEpoch       uint64
	PolicyRevision    uint64
}

type EgressTokenIssuer interface {
	Issue(EgressTokenInput) (string, time.Time, error)
}

type RuntimeRegistry struct {
	store AdmissionStore
	now   func() time.Time

	mu             sync.Mutex
	admissionOpen  bool
	active         map[runtimecontracts.GenerationKey]*runtimeSession
	changed        chan struct{}
	egressIssuer   EgressTokenIssuer
	egressEndpoint string
}

type runtimeSession struct {
	peer            *Peer
	token           string
	key             runtimecontracts.GenerationKey
	agentID         string
	bootID          string
	connectionEpoch uint64
	policyRevision  uint64
	policyEpoch     uint64
	virtualIP       netip.Addr
	allocatorEpoch  uint64
	networkReady    bool
	healthy         bool
	leaseExpiresAt  time.Time
	leaseTimer      *time.Timer
}

type sessionIO struct {
	peer *Peer
}

func NewRuntimeRegistry(store AdmissionStore) (*RuntimeRegistry, error) {
	if store == nil {
		return nil, fmt.Errorf("runtime admission store is required")
	}
	return &RuntimeRegistry{
		store: store, now: func() time.Time { return time.Now().UTC() },
		active: make(map[runtimecontracts.GenerationKey]*runtimeSession), changed: make(chan struct{}),
	}, nil
}

func (r *RuntimeRegistry) OpenAdmission() {
	r.mu.Lock()
	r.admissionOpen = true
	r.notifyLocked()
	r.mu.Unlock()
}

func (r *RuntimeRegistry) CloseAdmission() {
	r.mu.Lock()
	r.admissionOpen = false
	resources := make([]sessionIO, 0, len(r.active))
	for key := range r.active {
		resources = append(resources, r.fenceLocked(key, 0))
	}
	r.notifyLocked()
	r.mu.Unlock()
	closeSessionIOs(resources, ErrSessionUnavailable)
}

func (r *RuntimeRegistry) Close() error {
	r.CloseAdmission()
	return nil
}

func (r *RuntimeRegistry) AllowGeneration(runtimecontracts.GenerationKey) {}

func (r *RuntimeRegistry) DenyGeneration(key runtimecontracts.GenerationKey, _ string) {
	r.FenceSession(key, 0, "generation denied")
}

func (r *RuntimeRegistry) ForgetGeneration(key runtimecontracts.GenerationKey) {
	r.FenceSession(key, 0, "generation forgotten")
}

func (r *RuntimeRegistry) FenceSession(
	key runtimecontracts.GenerationKey, connectionEpoch uint64, _ string,
) {
	r.mu.Lock()
	resources := r.fenceLocked(key, connectionEpoch)
	r.notifyLocked()
	r.mu.Unlock()
	closeSessionIOs([]sessionIO{resources}, ErrSessionUnavailable)
}

func (r *RuntimeRegistry) Ready(
	key runtimecontracts.GenerationKey, policyRevision, policyEpoch uint64,
) (ActiveSession, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.readyLocked(key, policyRevision, policyEpoch)
}

func (r *RuntimeRegistry) AwaitReady(
	ctx context.Context,
	key runtimecontracts.GenerationKey,
	minimumConnectionEpoch, policyRevision, policyEpoch uint64,
) (ActiveSession, error) {
	for {
		r.mu.Lock()
		if session, ready := r.readyLocked(key, policyRevision, policyEpoch); ready &&
			session.ConnectionEpoch > minimumConnectionEpoch {
			r.mu.Unlock()
			return session, nil
		}
		changed := r.changed
		r.mu.Unlock()
		select {
		case <-ctx.Done():
			return ActiveSession{}, ctx.Err()
		case <-changed:
		}
	}
}

func (r *RuntimeRegistry) SetEgress(issuer EgressTokenIssuer, endpoint string) error {
	if issuer == nil || strings.TrimSpace(endpoint) == "" {
		return fmt.Errorf("Runtime egress token issuer and endpoint are required")
	}
	r.mu.Lock()
	r.egressIssuer = issuer
	r.egressEndpoint = strings.TrimSpace(endpoint)
	r.mu.Unlock()
	return nil
}

func (r *RuntimeRegistry) ServeControl(
	ctx context.Context,
	conn connection,
	maxMessageBytes int,
	token string,
	remoteEndpoint netip.AddrPort,
) error {
	if strings.TrimSpace(token) == "" {
		return fmt.Errorf("runtime admission token is required")
	}
	var connected atomic.Bool
	session := &runtimeSession{token: token}
	peer, err := newPeerWithLimit(conn, "cp-", "rt-", map[string]Handler{
		"runtime.connect": func(ctx context.Context, params json.RawMessage) (any, *Error) {
			var input ConnectInput
			if err := decodeParams(params, &input); err != nil {
				return nil, rpcError(CodeInvalidParams, err)
			}
			result, err := r.connect(ctx, session, input)
			if err != nil {
				return nil, rpcRequestError(CodeInvalidParams, err)
			}
			connected.Store(true)
			return result, nil
		},
		"runtime.heartbeat": func(ctx context.Context, params json.RawMessage) (any, *Error) {
			var input HeartbeatInput
			if err := decodeParams(params, &input); err != nil {
				return nil, rpcError(CodeInvalidParams, err)
			}
			result, err := r.heartbeat(ctx, session, input)
			if err != nil {
				return nil, rpcRequestError(CodeInvalidRequest, err)
			}
			return result, nil
		},
		"runtime.networkReady": func(_ context.Context, params json.RawMessage) (any, *Error) {
			var input NetworkReadyInput
			if err := decodeParams(params, &input); err != nil {
				return nil, rpcError(CodeInvalidParams, err)
			}
			if err := r.networkReady(session, input); err != nil {
				return nil, rpcRequestError(CodeInvalidRequest, err)
			}
			return NetworkReadyResult{Ready: true}, nil
		},
	}, maxMessageBytes)
	if err != nil {
		return err
	}
	peer.prepareRead = func() error {
		deadline := time.Now().Add(defaultConnectTimeout)
		if connected.Load() {
			deadline = time.Time{}
		}
		return conn.SetReadDeadline(deadline)
	}
	session.peer = peer
	_ = remoteEndpoint
	return peer.ServeWithDisconnect(ctx, func(cause error) { r.disconnect(session, cause) })
}

func (r *RuntimeRegistry) ResolveRuntimePeer(
	_ context.Context, key runtimecontracts.GenerationKey,
) (Caller, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	session := r.active[key]
	if !r.admissionOpen || session == nil || !session.healthy || !session.networkReady || session.peer == nil {
		return nil, ErrSessionUnavailable
	}
	return session.peer, nil
}

func (r *RuntimeRegistry) connect(
	ctx context.Context, session *runtimeSession, input ConnectInput,
) (ConnectResult, error) {
	if err := validateConnectInput(input); err != nil {
		return ConnectResult{}, err
	}
	r.mu.Lock()
	open := r.admissionOpen
	r.mu.Unlock()
	if !open {
		return ConnectResult{}, ErrSessionUnavailable
	}
	admission, err := r.store.AdmitRuntimeSession(ctx, AdmissionRequest{
		Token: session.token, RuntimeInstanceID: input.RuntimeInstanceID,
		Generation: input.Generation, RuntimeBootID: input.RuntimeBootID,
		Capabilities: append([]string(nil), input.Capabilities...), PreviousWork: input.PreviousWork,
	})
	if err != nil {
		return ConnectResult{}, err
	}
	if err := validateAdmission(admission); err != nil {
		return ConnectResult{}, err
	}

	key := runtimecontracts.GenerationKey{
		RuntimeInstanceID: strings.TrimSpace(input.RuntimeInstanceID), Generation: input.Generation,
	}
	session.key = key
	session.agentID = strings.TrimSpace(admission.AgentID)
	session.bootID = strings.TrimSpace(input.RuntimeBootID)
	session.connectionEpoch = admission.ConnectionEpoch
	session.policyRevision = admission.PolicyRevision
	session.policyEpoch = admission.PolicyEpoch
	session.virtualIP = admission.TunnelVirtualIP
	session.allocatorEpoch = admission.AllocatorEpoch
	session.leaseExpiresAt = admission.LeaseExpiresAt.UTC()
	session.networkReady = admission.NetworkMode == runtimecontracts.AgentNetworkRestricted

	result := ConnectResult{
		ProtocolVersion: ProtocolVersion, RuntimeInstanceID: key.RuntimeInstanceID,
		Generation: key.Generation, AgentID: session.agentID,
		ConnectionEpoch: admission.ConnectionEpoch, WorkEpochFloor: admission.WorkEpochFloor,
		NetworkMode: admission.NetworkMode, PolicyRevision: admission.PolicyRevision,
		PolicyEpoch: admission.PolicyEpoch, LeaseExpiresUnixMS: admission.LeaseExpiresAt.UnixMilli(),
	}
	if admission.NetworkMode == runtimecontracts.AgentNetworkUnrestricted {
		r.mu.Lock()
		issuer := r.egressIssuer
		endpoint := r.egressEndpoint
		r.mu.Unlock()
		if issuer == nil || endpoint == "" {
			return ConnectResult{}, fmt.Errorf("Runtime egress is not configured")
		}
		token, expiresAt, err := issuer.Issue(EgressTokenInput{
			AgentID: admission.AgentID, RuntimeInstanceID: key.RuntimeInstanceID,
			Generation: key.Generation, RuntimeBootID: input.RuntimeBootID,
			ConnectionEpoch: admission.ConnectionEpoch, VirtualIP: admission.TunnelVirtualIP,
			AllocatorEpoch: admission.AllocatorEpoch, PolicyEpoch: admission.PolicyEpoch,
			PolicyRevision: admission.PolicyRevision,
		})
		if err != nil {
			return ConnectResult{}, err
		}
		result.EgressEndpoint = endpoint
		result.EgressToken = token
		result.EgressTokenExpires = expiresAt.UnixMilli()
	}

	r.mu.Lock()
	previous := r.fenceLocked(key, 0)
	r.active[key] = session
	r.armLeaseLocked(session)
	r.notifyLocked()
	r.mu.Unlock()
	closeSessionIOs([]sessionIO{previous}, ErrSessionActive)
	return result, nil
}

type NetworkReadyInput struct {
	PolicyRevision uint64 `json:"policy_revision"`
	PolicyEpoch    uint64 `json:"policy_epoch"`
}

type NetworkReadyResult struct {
	Ready bool `json:"ready"`
}

func (r *RuntimeRegistry) networkReady(session *runtimeSession, input NetworkReadyInput) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.active[session.key] != session || input.PolicyRevision != session.policyRevision ||
		input.PolicyEpoch != session.policyEpoch {
		return ErrSessionUnavailable
	}
	session.networkReady = true
	r.notifyLocked()
	return nil
}

func (r *RuntimeRegistry) heartbeat(
	ctx context.Context, session *runtimeSession, input HeartbeatInput,
) (HeartbeatResult, error) {
	r.mu.Lock()
	active := r.active[session.key] == session
	r.mu.Unlock()
	if !active || input.PolicyRevision != session.policyRevision || input.PolicyEpoch != session.policyEpoch {
		return HeartbeatResult{}, ErrSessionUnavailable
	}
	expiresAt, err := r.store.MarkRuntimeHealthy(ctx, HeartbeatRequest{
		RuntimeInstanceID: session.key.RuntimeInstanceID, Generation: session.key.Generation,
		ConnectionEpoch: session.connectionEpoch, PolicyRevision: input.PolicyRevision,
		PolicyEpoch: input.PolicyEpoch,
	})
	if err != nil {
		return HeartbeatResult{}, err
	}
	r.mu.Lock()
	if r.active[session.key] != session {
		r.mu.Unlock()
		return HeartbeatResult{}, ErrSessionUnavailable
	}
	session.healthy = true
	session.leaseExpiresAt = expiresAt.UTC()
	r.armLeaseLocked(session)
	r.notifyLocked()
	r.mu.Unlock()
	return HeartbeatResult{LeaseExpiresUnixMS: expiresAt.UnixMilli()}, nil
}

func (r *RuntimeRegistry) disconnect(session *runtimeSession, cause error) {
	r.mu.Lock()
	if r.active[session.key] != session {
		r.mu.Unlock()
		return
	}
	resources := r.fenceLocked(session.key, session.connectionEpoch)
	r.notifyLocked()
	r.mu.Unlock()
	closeSessionIOs([]sessionIO{resources}, cause)
	_ = r.store.MarkRuntimeSessionDisconnected(context.Background(), DisconnectRequest{
		RuntimeInstanceID: session.key.RuntimeInstanceID, Generation: session.key.Generation,
		ConnectionEpoch: session.connectionEpoch, Reason: boundedMessage(cause),
	})
}

func (r *RuntimeRegistry) readyLocked(
	key runtimecontracts.GenerationKey, policyRevision, policyEpoch uint64,
) (ActiveSession, bool) {
	session := r.active[key]
	if !r.admissionOpen || session == nil || !session.healthy || !session.networkReady ||
		session.policyRevision != policyRevision || session.policyEpoch != policyEpoch {
		return ActiveSession{}, false
	}
	return ActiveSession{
		ConnectionEpoch: session.connectionEpoch,
		PolicyRevision:  session.policyRevision, PolicyEpoch: session.policyEpoch,
	}, true
}

func (r *RuntimeRegistry) fenceLocked(
	key runtimecontracts.GenerationKey, connectionEpoch uint64,
) sessionIO {
	session := r.active[key]
	if session == nil || connectionEpoch != 0 && session.connectionEpoch != connectionEpoch {
		return sessionIO{}
	}
	delete(r.active, key)
	if session.leaseTimer != nil {
		session.leaseTimer.Stop()
	}
	return sessionIO{peer: session.peer}
}

func (r *RuntimeRegistry) armLeaseLocked(session *runtimeSession) {
	if session.leaseTimer != nil {
		session.leaseTimer.Stop()
	}
	delay := time.Until(session.leaseExpiresAt)
	if delay < 0 {
		delay = 0
	}
	session.leaseTimer = time.AfterFunc(delay, func() {
		r.disconnect(session, errors.New("heartbeat lease expired"))
	})
}

func (r *RuntimeRegistry) notifyLocked() {
	close(r.changed)
	r.changed = make(chan struct{})
}

func validateConnectInput(input ConnectInput) error {
	if input.ProtocolVersion != ProtocolVersion || strings.TrimSpace(input.RuntimeInstanceID) == "" ||
		input.Generation == 0 || strings.TrimSpace(input.RuntimeBootID) == "" {
		return fmt.Errorf("runtime connect identity is invalid")
	}
	if len(input.Capabilities) == 0 {
		return fmt.Errorf("runtime capabilities are required")
	}
	return nil
}

func validateAdmission(admission AdmissionResult) error {
	if strings.TrimSpace(admission.AgentID) == "" || admission.ConnectionEpoch == 0 ||
		admission.WorkEpochFloor == 0 || admission.PolicyRevision == 0 || admission.PolicyEpoch == 0 ||
		admission.LeaseExpiresAt.IsZero() {
		return fmt.Errorf("runtime admission result is invalid")
	}
	switch admission.NetworkMode {
	case runtimecontracts.AgentNetworkRestricted:
		return nil
	case runtimecontracts.AgentNetworkUnrestricted:
		if !admission.TunnelVirtualIP.Is4() || admission.AllocatorEpoch == 0 {
			return fmt.Errorf("unrestricted runtime admission requires a tunnel reservation")
		}
		return nil
	default:
		return fmt.Errorf("runtime admission network mode is invalid")
	}
}

func closeSessionIOs(resources []sessionIO, cause error) {
	for _, resource := range resources {
		if resource.peer != nil {
			_ = resource.peer.Close()
		}
	}
}
