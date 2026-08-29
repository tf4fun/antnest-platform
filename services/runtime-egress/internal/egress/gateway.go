package egress

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/netip"
	"strings"
	"sync"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-egress/internal/protocol"
)

const (
	DefaultMTU                 = 1400
	DefaultMaxPacketsPerBatch  = 64
	DefaultMaxBatchBytes       = 64 * 1024
	defaultDownlinkQueue       = 16
	defaultMaxFlowsPerRuntime  = 1024
	defaultMaxFlowsGlobal      = 16 * 1024
	defaultFlowIdleTimeout     = 5 * time.Minute
	defaultFlowCloseGrace      = 5 * time.Second
	defaultRateWindow          = time.Second
	defaultMaxPacketsPerWindow = 8 * 1024
	defaultMaxBytesPerWindow   = 16 * 1024 * 1024
	defaultMaxRateDrops        = 8
)

var (
	ErrReservationMissing    = errors.New("runtime tunnel reservation is missing")
	ErrReservationConflict   = errors.New("runtime tunnel reservation conflicts with committed identity")
	ErrPacketRejected        = errors.New("egress packet was rejected")
	ErrSessionFenced         = errors.New("runtime tunnel session is fenced")
	ErrDataPlaneUnavailable  = runtimecontracts.ErrDataPlaneUnavailable
	ErrDataPlaneBackpressure = errors.New("egress data plane is backpressured")
	errFlowNotAdmitted       = fmt.Errorf("TCP flow was not admitted: %w", ErrPacketRejected)
)

type GenerationKey = runtimecontracts.GenerationKey

type TunnelIdentity struct {
	Key                  GenerationKey
	AgentID              string
	RuntimeBootID        string
	ConnectionEpoch      uint64
	PolicyRevision       uint64
	PolicyEpoch          uint64
	TunnelVirtualIP      netip.Addr
	AllocatorEpoch       uint64
	RuntimeFenceRevision uint64
}

type PacketBatch struct {
	ConnectionEpoch uint64
	PolicyEpoch     uint64
	Packets         [][]byte
}

type TunnelEndpoint interface {
	ReceiveUplink(context.Context, PacketBatch) error
	Downlink() <-chan PacketBatch
	Close(error)
}

type TunnelBroker interface {
	OpenTunnel(context.Context, TunnelIdentity) (TunnelEndpoint, error)
}

type Reservation struct {
	Key            GenerationKey
	AgentID        string
	VirtualIP      netip.Addr
	AllocatorEpoch uint64
	NetworkMode    string
	PolicyEpoch    uint64
}

func (r Reservation) validate() error {
	if err := r.Key.Validate(); err != nil {
		return err
	}
	if r.AgentID == "" {
		return fmt.Errorf("reservation agent identity is required")
	}
	if !r.VirtualIP.Is4() || r.VirtualIP.IsUnspecified() {
		return fmt.Errorf("reservation virtual IP must be usable IPv4")
	}
	if r.AllocatorEpoch == 0 || r.PolicyEpoch == 0 {
		return fmt.Errorf("reservation allocator and policy epochs must be positive")
	}
	if r.NetworkMode != runtimecontracts.NetworkRestricted && r.NetworkMode != runtimecontracts.NetworkUnrestricted {
		return fmt.Errorf("unsupported reservation network mode %q", r.NetworkMode)
	}
	return nil
}

type Gateway struct {
	startMu        sync.Mutex
	lifecycleMu    sync.RWMutex
	mu             sync.Mutex
	reservations   map[GenerationKey]*reservationState
	dataPlane      packetDataPlane
	dataPlaneGen   uint64
	started        bool
	broken         bool
	virtualCIDR    netip.Prefix
	maxPackets     int
	maxBatch       int
	mtu            int
	maxFlows       int
	maxFlowsAll    int
	flowCount      int
	flowIdle       time.Duration
	flowGrace      time.Duration
	rateWindow     time.Duration
	maxRatePackets int
	maxRateBytes   int
	maxRateDrops   int
	now            func() time.Time
	healthChanged  chan struct{}
}

type reservationState struct {
	policyMu    sync.Mutex
	ioMu        sync.RWMutex
	reservation Reservation
	claimed     uint64
	endpoint    *tunnelEndpoint
	policyPhase policyPhase
	flows       map[tcpFlowKey]tcpFlowEntry
	rateStarted time.Time
	ratePackets int
	rateBytes   int
	rateDrops   int
}

type policyPhase uint8

const (
	policyBlocked policyPhase = iota
	policyApplying
	policyReady
	policyReleasing
)

type tcpFlowKey struct {
	remoteIP   netip.Addr
	localPort  uint16
	remotePort uint16
}

type tcpFlowEntry struct {
	connectionEpoch uint64
	policyEpoch     uint64
	lastSeen        time.Time
	closingAt       time.Time
	uplinkFIN       bool
	downlinkFIN     bool
	uplinkPackets   uint64
	downlinkPackets uint64
	uplinkBytes     uint64
	downlinkBytes   uint64
}

type tcpFlowMutation struct {
	entry   tcpFlowEntry
	present bool
}

type parsedTCPPacket struct {
	source          netip.Addr
	destination     netip.Addr
	sourcePort      uint16
	destinationPort uint16
	flags           byte
	length          int
}

const (
	tcpFlagFIN = 0x01
	tcpFlagSYN = 0x02
	tcpFlagRST = 0x04
	tcpFlagACK = 0x10
)

func New() *Gateway {
	return newGateway(newPlatformDataPlane())
}

func newGateway(dataPlane packetDataPlane) *Gateway {
	return &Gateway{
		reservations:   make(map[GenerationKey]*reservationState),
		dataPlane:      dataPlane,
		maxPackets:     DefaultMaxPacketsPerBatch,
		maxBatch:       DefaultMaxBatchBytes,
		mtu:            DefaultMTU,
		maxFlows:       defaultMaxFlowsPerRuntime,
		maxFlowsAll:    defaultMaxFlowsGlobal,
		flowIdle:       defaultFlowIdleTimeout,
		flowGrace:      defaultFlowCloseGrace,
		rateWindow:     defaultRateWindow,
		maxRatePackets: defaultMaxPacketsPerWindow,
		maxRateBytes:   defaultMaxBytesPerWindow,
		maxRateDrops:   defaultMaxRateDrops,
		now:            time.Now,
		healthChanged:  make(chan struct{}, 1),
	}
}

func (g *Gateway) Start(ctx context.Context, virtualCIDR string) error {
	g.startMu.Lock()
	defer g.startMu.Unlock()
	prefix, err := netip.ParsePrefix(virtualCIDR)
	if err != nil || !prefix.Addr().Is4() || prefix != prefix.Masked() {
		return fmt.Errorf("Gateway virtual CIDR must be canonical IPv4")
	}
	g.mu.Lock()
	if g.started {
		if g.virtualCIDR != prefix {
			g.mu.Unlock()
			return fmt.Errorf("Gateway is already running with virtual CIDR %s", g.virtualCIDR)
		}
		g.mu.Unlock()
		return nil
	}
	if g.dataPlaneGen == ^uint64(0) {
		g.mu.Unlock()
		return fmt.Errorf("Gateway data-plane generation exhausted")
	}
	g.dataPlaneGen++
	dataPlaneGen := g.dataPlaneGen
	g.mu.Unlock()
	deliver := func(packet []byte) {
		g.deliverDownlink(dataPlaneGen, packet)
	}
	fail := func(err error) {
		if err == nil {
			return
		}
		go func() { _ = g.tripCircuitBreaker(dataPlaneGen, err) }()
	}
	g.lifecycleMu.Lock()
	err = g.dataPlane.Start(ctx, prefix, g.mtu, deliver, fail)
	g.lifecycleMu.Unlock()
	if err != nil {
		return errors.Join(ErrDataPlaneUnavailable, err)
	}
	g.mu.Lock()
	g.started = true
	g.broken = false
	g.virtualCIDR = prefix
	g.mu.Unlock()
	g.notifyHealthChanged()
	return nil
}

func (g *Gateway) Close() error {
	g.startMu.Lock()
	defer g.startMu.Unlock()
	g.mu.Lock()
	for _, state := range g.reservations {
		g.clearFlowsLocked(state)
		state.policyPhase = policyBlocked
		state.reservation.NetworkMode = runtimecontracts.NetworkRestricted
		if state.endpoint != nil {
			state.endpoint.closeLocked(ErrSessionFenced)
			state.endpoint = nil
			state.claimed = 0
		}
	}
	g.started = false
	g.broken = false
	g.flowCount = 0
	g.mu.Unlock()
	g.lifecycleMu.Lock()
	err := g.dataPlane.Close()
	g.lifecycleMu.Unlock()
	g.notifyHealthChanged()
	return err
}

func (g *Gateway) Ready() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.started && !g.broken
}

func (g *Gateway) HealthChanged() <-chan struct{} {
	return g.healthChanged
}

func (g *Gateway) notifyHealthChanged() {
	select {
	case g.healthChanged <- struct{}{}:
	default:
	}
}

// ReserveRuntime is idempotent only for the exact committed identity. The
// Gateway confirms an Application-allocated address; it never chooses one.
func (g *Gateway) ReserveRuntime(reservation Reservation) error {
	if err := reservation.validate(); err != nil {
		return err
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.started || g.broken {
		return ErrDataPlaneUnavailable
	}
	if !g.virtualCIDR.Contains(reservation.VirtualIP) || isReservedGatewayAddress(g.virtualCIDR, reservation.VirtualIP) {
		return fmt.Errorf("virtual IP %s is not usable in Gateway CIDR %s: %w", reservation.VirtualIP, g.virtualCIDR, ErrReservationConflict)
	}
	if existing := g.reservations[reservation.Key]; existing != nil {
		if !sameCommittedTunnelIdentity(existing.reservation, reservation) {
			return ErrReservationConflict
		}
		return nil
	}
	for _, existing := range g.reservations {
		if existing.reservation.VirtualIP == reservation.VirtualIP {
			return fmt.Errorf("virtual IP %s is already reserved: %w", reservation.VirtualIP, ErrReservationConflict)
		}
	}
	g.reservations[reservation.Key] = &reservationState{
		reservation: Reservation{
			Key: reservation.Key, AgentID: reservation.AgentID,
			VirtualIP: reservation.VirtualIP, AllocatorEpoch: reservation.AllocatorEpoch,
			NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: reservation.PolicyEpoch,
		},
		policyPhase: policyBlocked,
		flows:       make(map[tcpFlowKey]tcpFlowEntry),
	}
	return nil
}

func sameCommittedTunnelIdentity(left Reservation, right Reservation) bool {
	return left.Key == right.Key && left.AgentID == right.AgentID &&
		left.VirtualIP == right.VirtualIP && left.AllocatorEpoch == right.AllocatorEpoch
}

func (g *Gateway) ReleaseRuntime(ctx context.Context, key GenerationKey) error {
	g.mu.Lock()
	state := g.reservations[key]
	if state == nil {
		g.mu.Unlock()
		return nil
	}
	state.policyPhase = policyReleasing
	if state.endpoint != nil {
		state.endpoint.closeLocked(ErrSessionFenced)
		state.endpoint = nil
		state.claimed = 0
	}
	g.mu.Unlock()

	state.policyMu.Lock()
	defer state.policyMu.Unlock()
	state.ioMu.Lock()
	defer state.ioMu.Unlock()
	g.lifecycleMu.RLock()
	defer g.lifecycleMu.RUnlock()
	barrierCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := g.dataPlane.SetDenied(barrierCtx, state.reservation.VirtualIP, true); err != nil {
		return err
	}
	if err := g.dataPlane.SetDenied(barrierCtx, state.reservation.VirtualIP, false); err != nil {
		return err
	}
	g.mu.Lock()
	if g.reservations[key] == state {
		g.clearFlowsLocked(state)
		delete(g.reservations, key)
	}
	g.mu.Unlock()
	return nil
}

// ReleaseAgentExcept makes the desired generation, rather than a Docker
// container that may already be gone, authoritative for process-local egress
// reservations.
func (g *Gateway) ReleaseAgentExcept(ctx context.Context, agentID string, keep GenerationKey) error {
	agentID = strings.TrimSpace(agentID)
	if agentID == "" {
		return fmt.Errorf("reservation agent identity is required")
	}
	g.mu.Lock()
	keys := make([]GenerationKey, 0)
	for key, state := range g.reservations {
		if state.reservation.AgentID == agentID && key != keep {
			keys = append(keys, key)
		}
	}
	g.mu.Unlock()
	var result error
	for _, key := range keys {
		result = errors.Join(result, g.ReleaseRuntime(ctx, key))
	}
	return result
}

func (g *Gateway) OpenTunnel(_ context.Context, identity TunnelIdentity) (TunnelEndpoint, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	state := g.reservations[identity.Key]
	if state == nil {
		return nil, ErrReservationMissing
	}
	if !g.started || g.broken || state.policyPhase != policyReady {
		return nil, ErrDataPlaneUnavailable
	}
	reservation := state.reservation
	if reservation.AgentID != identity.AgentID ||
		reservation.VirtualIP != identity.TunnelVirtualIP || reservation.AllocatorEpoch != identity.AllocatorEpoch ||
		reservation.PolicyEpoch != identity.PolicyEpoch {
		return nil, ErrReservationConflict
	}
	if state.endpoint != nil {
		return nil, fmt.Errorf("reservation is already claimed")
	}
	// Flow state is scoped to one composite session connectionEpoch. A replacement
	// tunnel must never inherit tuples from a detached predecessor.
	g.clearFlowsLocked(state)
	endpoint := &tunnelEndpoint{
		gateway:      g,
		identity:     identity,
		reservation:  reservation,
		dataPlaneGen: g.dataPlaneGen,
		downlink:     make(chan PacketBatch, defaultDownlinkQueue),
		closed:       make(chan struct{}),
	}
	state.claimed = identity.ConnectionEpoch
	state.endpoint = endpoint
	return endpoint, nil
}

func (g *Gateway) SetPolicy(key GenerationKey, mode string, epoch uint64) error {
	if err := validatePolicyTarget(mode, epoch); err != nil {
		return err
	}
	g.mu.Lock()
	state := g.reservations[key]
	if state == nil {
		g.mu.Unlock()
		return ErrReservationMissing
	}
	g.mu.Unlock()

	state.policyMu.Lock()
	defer state.policyMu.Unlock()

	dataPlaneGen, virtualIP, apply, err := g.beginPolicyChange(key, state, mode, epoch)
	if err != nil || !apply {
		return err
	}
	if err := g.applyPolicyBarrier(key, state, virtualIP, dataPlaneGen, mode); err != nil {
		return err
	}
	return g.commitPolicyChange(key, state, dataPlaneGen, mode, epoch)
}

func validatePolicyTarget(mode string, epoch uint64) error {
	if mode != runtimecontracts.NetworkRestricted && mode != runtimecontracts.NetworkUnrestricted {
		return fmt.Errorf("unsupported network mode %q", mode)
	}
	if epoch == 0 {
		return fmt.Errorf("policy epoch must be positive")
	}
	return nil
}

func (g *Gateway) beginPolicyChange(
	key GenerationKey,
	state *reservationState,
	mode string,
	epoch uint64,
) (uint64, netip.Addr, bool, error) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reservations[key] != state || state.policyPhase == policyReleasing {
		return 0, netip.Addr{}, false, ErrReservationMissing
	}
	if !g.started || g.broken {
		return 0, netip.Addr{}, false, ErrDataPlaneUnavailable
	}
	if epoch == state.reservation.PolicyEpoch && mode == state.reservation.NetworkMode && state.policyPhase == policyReady {
		return 0, netip.Addr{}, false, nil
	}
	if epoch < state.reservation.PolicyEpoch {
		return 0, netip.Addr{}, false, fmt.Errorf("policy epoch cannot move backwards")
	}
	if epoch == state.reservation.PolicyEpoch && !sameEpochPolicyRecovery(state, mode) {
		return 0, netip.Addr{}, false, fmt.Errorf("policy epoch must increase")
	}
	if state.policyPhase == policyApplying {
		return 0, netip.Addr{}, false, ErrDataPlaneUnavailable
	}
	state.policyPhase = policyApplying
	if state.endpoint != nil {
		state.endpoint.closeLocked(ErrSessionFenced)
		state.endpoint = nil
		state.claimed = 0
	}
	return g.dataPlaneGen, state.reservation.VirtualIP, true, nil
}

func sameEpochPolicyRecovery(state *reservationState, mode string) bool {
	if state.policyPhase != policyBlocked {
		return false
	}
	return mode == state.reservation.NetworkMode ||
		(state.reservation.NetworkMode == runtimecontracts.NetworkRestricted &&
			mode == runtimecontracts.NetworkUnrestricted)
}

func (g *Gateway) applyPolicyBarrier(
	key GenerationKey,
	state *reservationState,
	virtualIP netip.Addr,
	dataPlaneGen uint64,
	mode string,
) error {
	// The per-reservation barrier waits for every packet writer/deliverer that
	// passed the previous admission check. New packet paths can only re-check
	// state after the kernel deny/conntrack operation has completed.
	state.ioMu.Lock()
	g.lifecycleMu.RLock()
	g.mu.Lock()
	current := g.reservations[key]
	valid := current == state && state.policyPhase == policyApplying &&
		g.started && !g.broken && g.dataPlaneGen == dataPlaneGen
	g.mu.Unlock()
	if !valid {
		g.lifecycleMu.RUnlock()
		state.ioMu.Unlock()
		return ErrDataPlaneUnavailable
	}
	barrierCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	var err error
	err = g.dataPlane.SetDenied(barrierCtx, virtualIP, true)
	if err == nil && mode == runtimecontracts.NetworkUnrestricted {
		err = g.dataPlane.SetDenied(barrierCtx, virtualIP, false)
	}
	cancel()
	g.lifecycleMu.RUnlock()
	state.ioMu.Unlock()
	if err != nil {
		g.mu.Lock()
		if current := g.reservations[key]; current == state {
			current.policyPhase = policyBlocked
		}
		g.mu.Unlock()
		return g.tripCircuitBreaker(dataPlaneGen, err)
	}
	return nil
}

func (g *Gateway) commitPolicyChange(
	key GenerationKey,
	state *reservationState,
	dataPlaneGen uint64,
	mode string,
	epoch uint64,
) error {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.reservations[key] != state || state.policyPhase == policyReleasing {
		return ErrReservationMissing
	}
	if !g.started || g.broken || g.dataPlaneGen != dataPlaneGen || state.policyPhase != policyApplying {
		state.policyPhase = policyBlocked
		return ErrDataPlaneUnavailable
	}
	g.clearFlowsLocked(state)
	state.reservation.NetworkMode = mode
	state.reservation.PolicyEpoch = epoch
	state.policyPhase = policyReady
	return nil
}

func (g *Gateway) tripCircuitBreaker(dataPlaneGen uint64, cause error) error {
	g.startMu.Lock()
	defer g.startMu.Unlock()
	g.mu.Lock()
	if dataPlaneGen != g.dataPlaneGen || !g.started {
		g.mu.Unlock()
		return errors.Join(ErrDataPlaneUnavailable, cause)
	}
	g.started = false
	g.broken = true
	for _, state := range g.reservations {
		state.policyPhase = policyBlocked
		state.reservation.NetworkMode = runtimecontracts.NetworkRestricted
		g.clearFlowsLocked(state)
		if state.endpoint != nil {
			state.endpoint.closeLocked(ErrDataPlaneUnavailable)
			state.endpoint = nil
			state.claimed = 0
		}
	}
	g.mu.Unlock()
	g.lifecycleMu.Lock()
	err := g.dataPlane.Close()
	g.lifecycleMu.Unlock()
	g.notifyHealthChanged()
	return errors.Join(ErrDataPlaneUnavailable, cause, err)
}

func (g *Gateway) clearFlowsLocked(state *reservationState) {
	if state == nil || len(state.flows) == 0 {
		return
	}
	g.flowCount -= len(state.flows)
	if g.flowCount < 0 {
		g.flowCount = 0
	}
	clear(state.flows)
}

func (g *Gateway) stageUplinkFlowsLocked(
	state *reservationState,
	identity TunnelIdentity,
	packets []parsedTCPPacket,
) (map[tcpFlowKey]tcpFlowMutation, int, error) {
	now := g.now()
	g.pruneFlowsLocked(state, now)
	mutations := make(map[tcpFlowKey]tcpFlowMutation, len(packets))
	for _, packet := range packets {
		key, mutation, err := nextUplinkFlowMutation(state.flows, mutations, identity, packet, now)
		if err != nil {
			return nil, 0, err
		}
		mutations[key] = mutation
	}
	delta := flowMutationDelta(state.flows, mutations)
	if err := g.validateFlowCapacity(state, delta); err != nil {
		return nil, 0, err
	}
	return mutations, delta, nil
}

func nextUplinkFlowMutation(
	flows map[tcpFlowKey]tcpFlowEntry,
	staged map[tcpFlowKey]tcpFlowMutation,
	identity TunnelIdentity,
	packet parsedTCPPacket,
	now time.Time,
) (tcpFlowKey, tcpFlowMutation, error) {
	key := tcpFlowKey{remoteIP: packet.destination, localPort: packet.sourcePort, remotePort: packet.destinationPort}
	mutation, touched := staged[key]
	entry, exists := mutation.entry, mutation.present
	if !touched {
		entry, exists = flows[key]
	}
	if !exists {
		if packet.flags&tcpFlagSYN == 0 || packet.flags&tcpFlagACK != 0 {
			return key, tcpFlowMutation{}, fmt.Errorf("new TCP flow must begin with SYN: %w", errFlowNotAdmitted)
		}
		entry = tcpFlowEntry{connectionEpoch: identity.ConnectionEpoch, policyEpoch: identity.PolicyEpoch}
	}
	if entry.connectionEpoch != identity.ConnectionEpoch || entry.policyEpoch != identity.PolicyEpoch {
		return key, tcpFlowMutation{}, ErrSessionFenced
	}
	entry.lastSeen = now
	entry.uplinkPackets++
	entry.uplinkBytes += uint64(packet.length)
	if packet.flags&tcpFlagRST != 0 {
		return key, tcpFlowMutation{}, nil
	}
	if packet.flags&tcpFlagFIN != 0 {
		entry.uplinkFIN = true
	}
	if entry.uplinkFIN && entry.downlinkFIN && entry.closingAt.IsZero() {
		entry.closingAt = now
	}
	return key, tcpFlowMutation{entry: entry, present: true}, nil
}

func flowMutationDelta(
	flows map[tcpFlowKey]tcpFlowEntry,
	mutations map[tcpFlowKey]tcpFlowMutation,
) int {
	delta := 0
	for key, mutation := range mutations {
		_, existed := flows[key]
		switch {
		case !existed && mutation.present:
			delta++
		case existed && !mutation.present:
			delta--
		}
	}
	return delta
}

func (g *Gateway) validateFlowCapacity(state *reservationState, delta int) error {
	nextCount := len(state.flows) + delta
	if nextCount > g.maxFlows {
		return fmt.Errorf("runtime TCP flow limit exceeded: %w", errFlowNotAdmitted)
	}
	globalWithoutCurrent := g.flowCount - len(state.flows)
	if globalWithoutCurrent < 0 {
		globalWithoutCurrent = 0
	}
	if globalWithoutCurrent+nextCount > g.maxFlowsAll {
		return fmt.Errorf("global TCP flow limit exceeded: %w", errFlowNotAdmitted)
	}
	return nil
}

func applyFlowMutations(flows map[tcpFlowKey]tcpFlowEntry, mutations map[tcpFlowKey]tcpFlowMutation) {
	for key, mutation := range mutations {
		if !mutation.present {
			delete(flows, key)
			continue
		}
		flows[key] = mutation.entry
	}
}

func (g *Gateway) pruneFlowsLocked(state *reservationState, now time.Time) {
	for key, entry := range state.flows {
		if !g.flowExpired(entry, now) {
			continue
		}
		delete(state.flows, key)
		g.flowCount--
	}
	if g.flowCount < 0 {
		g.flowCount = 0
	}
}

func (g *Gateway) flowExpired(entry tcpFlowEntry, now time.Time) bool {
	if g.flowIdle > 0 && !entry.lastSeen.IsZero() && now.Sub(entry.lastSeen) >= g.flowIdle {
		return true
	}
	return g.flowGrace > 0 && !entry.closingAt.IsZero() && now.Sub(entry.closingAt) >= g.flowGrace
}

type tunnelEndpoint struct {
	gateway      *Gateway
	identity     TunnelIdentity
	reservation  Reservation
	dataPlaneGen uint64
	downlink     chan PacketBatch
	closed       chan struct{}
	closeOnce    sync.Once
}

func packetBatchSize(batch PacketBatch) int {
	size := 12
	for _, packet := range batch.Packets {
		size += 2 + len(packet)
	}
	return size
}

func (e *tunnelEndpoint) ReceiveUplink(ctx context.Context, batch PacketBatch) error {
	parsed, batchBytes, err := e.parseUplinkBatch(batch)
	if err != nil {
		return err
	}
	admission, forward, err := e.admitUplink(parsed, batchBytes)
	if err != nil || !forward {
		return err
	}
	return admission.write(ctx, batch.Packets)
}

func (e *tunnelEndpoint) parseUplinkBatch(batch PacketBatch) ([]parsedTCPPacket, int, error) {
	if len(batch.Packets) == 0 || len(batch.Packets) > e.gateway.maxPackets || packetBatchSize(batch) > e.gateway.maxBatch {
		return nil, 0, fmt.Errorf("packet batch exceeds protocol limits: %w", ErrPacketRejected)
	}
	if batch.ConnectionEpoch != e.identity.ConnectionEpoch || batch.PolicyEpoch != e.identity.PolicyEpoch {
		return nil, 0, ErrSessionFenced
	}
	parsed := make([]parsedTCPPacket, 0, len(batch.Packets))
	batchBytes := 0
	resolver := e.gateway.resolverAddress()
	for _, packet := range batch.Packets {
		metadata, err := parseIPv4TCPPacket(packet, e.gateway.mtu)
		if err != nil {
			return nil, 0, err
		}
		if metadata.source != e.reservation.VirtualIP {
			return nil, 0, fmt.Errorf("packet source %s does not match reservation: %w", metadata.source, ErrPacketRejected)
		}
		if !isPublicIPv4(metadata.destination) &&
			(metadata.destination != resolver || metadata.destinationPort != 53) {
			return nil, 0, fmt.Errorf("destination %s is not public IPv4: %w", metadata.destination, ErrPacketRejected)
		}
		parsed = append(parsed, metadata)
		batchBytes += metadata.length
	}
	return parsed, batchBytes, nil
}

type uplinkAdmission struct {
	endpoint *tunnelEndpoint
	state    *reservationState
	released bool
}

func (e *tunnelEndpoint) admitUplink(
	parsed []parsedTCPPacket,
	batchBytes int,
) (*uplinkAdmission, bool, error) {
	e.gateway.mu.Lock()
	state := e.gateway.reservations[e.identity.Key]
	e.gateway.mu.Unlock()
	if state == nil {
		return nil, false, ErrSessionFenced
	}
	state.ioMu.RLock()
	e.gateway.lifecycleMu.RLock()
	admission := &uplinkAdmission{endpoint: e, state: state}
	e.gateway.mu.Lock()
	active := e.gateway.reservations[e.identity.Key] == state && state.endpoint == e && state.policyPhase == policyReady &&
		state.claimed == e.identity.ConnectionEpoch && state.reservation.PolicyEpoch == e.identity.PolicyEpoch &&
		e.gateway.dataPlaneGen == e.dataPlaneGen && e.gateway.started && !e.gateway.broken
	if !active {
		e.gateway.mu.Unlock()
		admission.release()
		return nil, false, ErrSessionFenced
	}
	if err := e.gateway.admitUplinkRateLocked(state, len(parsed), batchBytes); err != nil {
		e.gateway.mu.Unlock()
		admission.release()
		if errors.Is(err, errFlowNotAdmitted) {
			return nil, false, nil
		}
		return nil, false, err
	}
	if state.reservation.NetworkMode == runtimecontracts.NetworkRestricted {
		e.gateway.mu.Unlock()
		admission.release()
		return nil, false, nil
	}
	mutations, flowDelta, err := e.gateway.stageUplinkFlowsLocked(state, e.identity, parsed)
	if err != nil {
		e.gateway.mu.Unlock()
		admission.release()
		if errors.Is(err, errFlowNotAdmitted) {
			return nil, false, nil
		}
		return nil, false, err
	}
	e.gateway.flowCount += flowDelta
	applyFlowMutations(state.flows, mutations)
	e.gateway.mu.Unlock()
	return admission, true, nil
}

func (a *uplinkAdmission) release() {
	if a == nil || a.released {
		return
	}
	a.released = true
	a.endpoint.gateway.lifecycleMu.RUnlock()
	a.state.ioMu.RUnlock()
}

func (a *uplinkAdmission) write(ctx context.Context, packets [][]byte) error {
	gateway := a.endpoint.gateway
	defer a.release()
	for _, packet := range packets {
		if err := ctx.Err(); err != nil {
			a.detachAndReset(err)
			return err
		}
		if err := gateway.dataPlane.WritePacket(packet); err != nil {
			if errors.Is(err, ErrDataPlaneBackpressure) {
				a.detachAndReset(err)
				return fmt.Errorf("Gateway TUN write backpressure: %w", ErrPacketRejected)
			}
			a.release()
			return gateway.tripCircuitBreaker(a.endpoint.dataPlaneGen, err)
		}
	}
	return nil
}

func (a *uplinkAdmission) detachAndReset(cause error) {
	gateway := a.endpoint.gateway
	gateway.mu.Lock()
	resetTunnel := gateway.detachEndpointLocked(a.state, a.endpoint, cause)
	gateway.mu.Unlock()
	a.release()
	if resetTunnel {
		gateway.resetDetachedTunnel(a.state, a.endpoint)
	}
}

func (g *Gateway) admitUplinkRateLocked(state *reservationState, packets int, bytes int) error {
	now := g.now()
	if state.rateStarted.IsZero() || g.rateWindow <= 0 || now.Sub(state.rateStarted) >= g.rateWindow {
		state.rateStarted = now
		state.ratePackets = 0
		state.rateBytes = 0
		state.rateDrops = 0
	}
	if (g.maxRatePackets > 0 && state.ratePackets+packets > g.maxRatePackets) ||
		(g.maxRateBytes > 0 && state.rateBytes+bytes > g.maxRateBytes) {
		state.rateDrops++
		if g.maxRateDrops > 0 && state.rateDrops >= g.maxRateDrops {
			return fmt.Errorf("runtime egress rate limit repeatedly exceeded: %w", ErrPacketRejected)
		}
		return fmt.Errorf("runtime egress rate limit exceeded: %w", errFlowNotAdmitted)
	}
	state.ratePackets += packets
	state.rateBytes += bytes
	return nil
}

func (e *tunnelEndpoint) Downlink() <-chan PacketBatch {
	return e.downlink
}

func (e *tunnelEndpoint) Close(_ error) {
	e.gateway.mu.Lock()
	state := e.gateway.reservations[e.identity.Key]
	if e.gateway.detachEndpointLocked(state, e, nil) {
		e.gateway.mu.Unlock()
		e.gateway.resetDetachedTunnel(state, e)
		return
	}
	e.closeLocked(nil)
	e.gateway.mu.Unlock()
}

func (g *Gateway) detachEndpointLocked(state *reservationState, endpoint *tunnelEndpoint, cause error) bool {
	if state == nil || endpoint == nil || g.reservations[endpoint.identity.Key] != state || state.endpoint != endpoint {
		return false
	}
	state.endpoint = nil
	state.claimed = 0
	state.policyPhase = policyBlocked
	g.clearFlowsLocked(state)
	endpoint.closeLocked(cause)
	return true
}

func (g *Gateway) resetDetachedTunnel(state *reservationState, endpoint *tunnelEndpoint) {
	state.policyMu.Lock()
	defer state.policyMu.Unlock()
	state.ioMu.Lock()
	g.lifecycleMu.RLock()
	g.mu.Lock()
	current := g.reservations[endpoint.identity.Key]
	valid := current == state && state.policyPhase != policyReleasing &&
		g.started && !g.broken && g.dataPlaneGen == endpoint.dataPlaneGen
	mode := state.reservation.NetworkMode
	virtualIP := state.reservation.VirtualIP
	g.mu.Unlock()
	if !valid {
		g.lifecycleMu.RUnlock()
		state.ioMu.Unlock()
		return
	}

	barrierCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	err := g.dataPlane.SetDenied(barrierCtx, virtualIP, true)
	if err == nil && mode == runtimecontracts.NetworkUnrestricted {
		err = g.dataPlane.SetDenied(barrierCtx, virtualIP, false)
	}
	cancel()
	g.lifecycleMu.RUnlock()
	state.ioMu.Unlock()
	if err != nil {
		_ = g.tripCircuitBreaker(endpoint.dataPlaneGen, err)
		return
	}
	g.mu.Lock()
	if g.reservations[endpoint.identity.Key] == state && state.policyPhase != policyReleasing &&
		g.started && !g.broken && g.dataPlaneGen == endpoint.dataPlaneGen {
		state.policyPhase = policyReady
	}
	g.mu.Unlock()
}

func (e *tunnelEndpoint) closeLocked(_ error) {
	e.closeOnce.Do(func() {
		close(e.closed)
		for {
			select {
			case <-e.downlink:
				continue
			default:
				close(e.downlink)
				return
			}
		}
	})
}

func validateIPv4TCPPacket(packet []byte, source netip.Addr, mtu int) error {
	metadata, err := parseIPv4TCPPacket(packet, mtu)
	if err != nil {
		return err
	}
	if metadata.source != source {
		return fmt.Errorf("packet source %s does not match reservation: %w", metadata.source, ErrPacketRejected)
	}
	if !isPublicIPv4(metadata.destination) {
		return fmt.Errorf("destination %s is not public IPv4: %w", metadata.destination, ErrPacketRejected)
	}
	return nil
}

func parseIPv4TCPPacket(packet []byte, mtu int) (parsedTCPPacket, error) {
	if len(packet) < 40 || len(packet) > mtu {
		return parsedTCPPacket{}, fmt.Errorf("packet length %d is invalid: %w", len(packet), ErrPacketRejected)
	}
	if packet[0]>>4 != 4 {
		return parsedTCPPacket{}, fmt.Errorf("only IPv4 is supported: %w", ErrPacketRejected)
	}
	headerLength := int(packet[0]&0x0f) * 4
	if headerLength != 20 || headerLength+20 > len(packet) {
		return parsedTCPPacket{}, fmt.Errorf("IPv4 options or truncated headers are unsupported: %w", ErrPacketRejected)
	}
	totalLength := int(packet[2])<<8 | int(packet[3])
	if totalLength != len(packet) {
		return parsedTCPPacket{}, fmt.Errorf("IPv4 total length mismatch: %w", ErrPacketRejected)
	}
	fragment := uint16(packet[6])<<8 | uint16(packet[7])
	if fragment&0x3fff != 0 {
		return parsedTCPPacket{}, fmt.Errorf("fragmented IPv4 is unsupported: %w", ErrPacketRejected)
	}
	if packet[9] != 6 {
		return parsedTCPPacket{}, fmt.Errorf("only TCP is supported: %w", ErrPacketRejected)
	}
	tcpHeaderLength := int(packet[headerLength+12]>>4) * 4
	if tcpHeaderLength < 20 || headerLength+tcpHeaderLength > len(packet) {
		return parsedTCPPacket{}, fmt.Errorf("TCP header length is invalid: %w", ErrPacketRejected)
	}
	sourcePort := uint16(packet[headerLength])<<8 | uint16(packet[headerLength+1])
	destinationPort := uint16(packet[headerLength+2])<<8 | uint16(packet[headerLength+3])
	if sourcePort == 0 || destinationPort == 0 {
		return parsedTCPPacket{}, fmt.Errorf("TCP ports must be non-zero: %w", ErrPacketRejected)
	}
	flags := packet[headerLength+13]
	if flags&tcpFlagSYN != 0 && flags&(tcpFlagFIN|tcpFlagRST) != 0 {
		return parsedTCPPacket{}, fmt.Errorf("invalid TCP SYN flag combination: %w", ErrPacketRejected)
	}
	return parsedTCPPacket{
		source:          netip.AddrFrom4([4]byte{packet[12], packet[13], packet[14], packet[15]}),
		destination:     netip.AddrFrom4([4]byte{packet[16], packet[17], packet[18], packet[19]}),
		sourcePort:      sourcePort,
		destinationPort: destinationPort,
		flags:           flags,
		length:          len(packet),
	}, nil
}

func (g *Gateway) deliverDownlink(dataPlaneGen uint64, packet []byte) {
	metadata, err := parseIPv4TCPPacket(packet, g.mtu)
	resolver := g.resolverAddress()
	if err != nil || (!isPublicIPv4(metadata.source) &&
		(metadata.source != resolver || metadata.sourcePort != 53)) {
		return
	}
	candidate := g.findDownlinkCandidate(dataPlaneGen, metadata.destination)
	if candidate == nil {
		return
	}
	state, endpoint, reset := g.stageDownlink(candidate, dataPlaneGen, metadata, packet)
	if reset {
		g.resetDetachedTunnel(state, endpoint)
	}
}

func (g *Gateway) resolverAddress() netip.Addr {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.virtualCIDR.IsValid() {
		return netip.Addr{}
	}
	return g.virtualCIDR.Masked().Addr().Next()
}

func (g *Gateway) findDownlinkCandidate(dataPlaneGen uint64, destination netip.Addr) *reservationState {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !g.started || g.broken || g.dataPlaneGen != dataPlaneGen {
		return nil
	}
	for _, state := range g.reservations {
		if state.reservation.VirtualIP == destination {
			return state
		}
	}
	return nil
}

func (g *Gateway) stageDownlink(
	candidate *reservationState,
	dataPlaneGen uint64,
	metadata parsedTCPPacket,
	packet []byte,
) (*reservationState, *tunnelEndpoint, bool) {
	candidate.ioMu.RLock()
	g.lifecycleMu.RLock()
	g.mu.Lock()
	state := g.reservations[candidate.reservation.Key]
	if !g.downlinkActiveLocked(state, candidate, dataPlaneGen, metadata.destination) {
		g.mu.Unlock()
		g.lifecycleMu.RUnlock()
		candidate.ioMu.RUnlock()
		return nil, nil, false
	}
	key, entry, ok := g.advanceDownlinkFlowLocked(state, metadata)
	if !ok {
		g.mu.Unlock()
		g.lifecycleMu.RUnlock()
		candidate.ioMu.RUnlock()
		return nil, nil, false
	}
	endpoint := state.endpoint
	batch := PacketBatch{
		ConnectionEpoch: state.claimed,
		PolicyEpoch:     state.reservation.PolicyEpoch,
		Packets:         [][]byte{bytes.Clone(packet)},
	}
	resetTunnel := g.enqueueDownlinkLocked(state, endpoint, key, entry, metadata.flags, batch)
	g.mu.Unlock()
	g.lifecycleMu.RUnlock()
	candidate.ioMu.RUnlock()
	return state, endpoint, resetTunnel
}

func (g *Gateway) downlinkActiveLocked(
	state *reservationState,
	candidate *reservationState,
	dataPlaneGen uint64,
	destination netip.Addr,
) bool {
	return state == candidate && state.reservation.VirtualIP == destination &&
		state.reservation.NetworkMode == runtimecontracts.NetworkUnrestricted &&
		state.policyPhase == policyReady && state.endpoint != nil && state.claimed != 0 &&
		g.started && !g.broken && state.endpoint.dataPlaneGen == g.dataPlaneGen && g.dataPlaneGen == dataPlaneGen
}

func (g *Gateway) advanceDownlinkFlowLocked(
	state *reservationState,
	metadata parsedTCPPacket,
) (tcpFlowKey, tcpFlowEntry, bool) {
	now := g.now()
	g.pruneFlowsLocked(state, now)
	key := tcpFlowKey{remoteIP: metadata.source, localPort: metadata.destinationPort, remotePort: metadata.sourcePort}
	entry, exists := state.flows[key]
	if !exists || entry.connectionEpoch != state.claimed || entry.policyEpoch != state.reservation.PolicyEpoch {
		return key, tcpFlowEntry{}, false
	}
	entry.lastSeen = now
	entry.downlinkPackets++
	entry.downlinkBytes += uint64(metadata.length)
	if metadata.flags&tcpFlagFIN != 0 {
		entry.downlinkFIN = true
	}
	if entry.uplinkFIN && entry.downlinkFIN && entry.closingAt.IsZero() {
		entry.closingAt = now
	}
	return key, entry, true
}

func (g *Gateway) enqueueDownlinkLocked(
	state *reservationState,
	endpoint *tunnelEndpoint,
	key tcpFlowKey,
	entry tcpFlowEntry,
	flags byte,
	batch PacketBatch,
) bool {
	select {
	case endpoint.downlink <- batch:
		if flags&tcpFlagRST != 0 {
			delete(state.flows, key)
			g.flowCount--
		} else {
			state.flows[key] = entry
		}
		return false
	default:
		return g.detachEndpointLocked(state, endpoint, ErrDataPlaneBackpressure)
	}
}

func validateIPv4TCPDownlink(packet []byte, mtu int) (netip.Addr, error) {
	metadata, err := parseIPv4TCPPacket(packet, mtu)
	if err != nil {
		return netip.Addr{}, err
	}
	if !isPublicIPv4(metadata.source) {
		return netip.Addr{}, ErrPacketRejected
	}
	return metadata.destination, nil
}

var nonPublicIPv4Prefixes = mustPrefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
)

func isPublicIPv4(address netip.Addr) bool {
	if !address.Is4() {
		return false
	}
	for _, prefix := range nonPublicIPv4Prefixes {
		if prefix.Contains(address) {
			return false
		}
	}
	return true
}

func isReservedGatewayAddress(prefix netip.Prefix, address netip.Addr) bool {
	prefix = prefix.Masked()
	if !prefix.Addr().Is4() || !address.Is4() {
		return true
	}
	network := prefix.Addr()
	if address == network || address == network.Next() {
		return true
	}
	bytes := network.As4()
	networkValue := uint64(bytes[0])<<24 | uint64(bytes[1])<<16 | uint64(bytes[2])<<8 | uint64(bytes[3])
	hostBits := 32 - prefix.Bits()
	lastValue := networkValue | (uint64(1) << hostBits) - 1
	last := netip.AddrFrom4([4]byte{byte(lastValue >> 24), byte(lastValue >> 16), byte(lastValue >> 8), byte(lastValue)})
	return address == last
}

func mustPrefixes(values ...string) []netip.Prefix {
	prefixes := make([]netip.Prefix, 0, len(values))
	for _, value := range values {
		prefixes = append(prefixes, netip.MustParsePrefix(value))
	}
	return prefixes
}

var _ TunnelBroker = (*Gateway)(nil)
