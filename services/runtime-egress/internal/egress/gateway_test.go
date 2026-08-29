package egress

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	runtimecontracts "soft/antnest-platform/services/runtime-egress/internal/protocol"
)

func TestGatewayClassifiesDataPlaneStartupFailure(t *testing.T) {
	cause := errors.New("injected data-plane startup failure")
	gateway := newGateway(&fakeDataPlane{startErr: cause})

	err := gateway.Start(context.Background(), "100.96.0.0/16")
	if !errors.Is(err, ErrDataPlaneUnavailable) || !errors.Is(err, cause) {
		t.Fatalf("startup failure lost its data-plane classification: %v", err)
	}
	if gateway.Ready() {
		t.Fatal("Gateway became ready after data-plane startup failed")
	}
}

func TestGatewayPolicyEpochFencesOldTunnelAndRoutesPackets(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })

	key := GenerationKey{RuntimeInstanceID: "runtime-1", Generation: 1}
	reservation := Reservation{
		Key: key, AgentID: "agent-1",
		VirtualIP: netip.MustParseAddr("100.96.0.2"), AllocatorEpoch: 1,
		NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	first, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	uplink := ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1"))
	if err := first.ReceiveUplink(context.Background(), packetBatch(1, 1, uplink)); err != nil {
		t.Fatalf("restricted packet should be consumed by the deny policy: %v", err)
	}
	if len(driver.writes()) != 0 {
		t.Fatal("restricted packet reached the shared TUN")
	}

	if err := gateway.SetPolicy(key, runtimecontracts.NetworkUnrestricted, 2); err != nil {
		t.Fatal(err)
	}
	if err := first.ReceiveUplink(context.Background(), packetBatch(1, 1, uplink)); !errors.Is(err, ErrSessionFenced) {
		t.Fatalf("old policy tunnel was not fenced: %v", err)
	}
	second, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 2))
	if err != nil {
		t.Fatal(err)
	}
	if err := second.ReceiveUplink(context.Background(), packetBatch(2, 2, uplink)); err != nil {
		t.Fatal(err)
	}
	if len(driver.writes()) != 1 {
		t.Fatalf("unrestricted packet was not written exactly once: %d", len(driver.writes()))
	}

	driver.emit(ipv4TCPPacketWithPorts(
		netip.MustParseAddr("1.1.1.1"), reservation.VirtualIP,
		443, 12345, tcpFlagSYN|tcpFlagACK,
	))
	select {
	case downlink := <-second.Downlink():
		if downlink.ConnectionEpoch != 2 || downlink.PolicyEpoch != 2 || len(downlink.Packets) != 1 {
			t.Fatalf("unexpected downlink identity: %#v", downlink)
		}
	default:
		t.Fatal("public response was not routed to the claimed Runtime")
	}

	if err := gateway.SetPolicy(key, runtimecontracts.NetworkRestricted, 3); err != nil {
		t.Fatal(err)
	}
	if got := driver.deniedState(reservation.VirtualIP); !got {
		t.Fatal("tightening did not install the data-plane deny barrier")
	}
}

func TestGatewayRoutesTCPDNSOnlyToVirtualResolver(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key: GenerationKey{RuntimeInstanceID: "runtime-dns", Generation: 1}, AgentID: "agent-dns",
		VirtualIP: netip.MustParseAddr("100.96.0.2"), AllocatorEpoch: 1,
		NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	resolver := netip.MustParseAddr("100.96.0.1")
	query := ipv4TCPPacketWithPorts(reservation.VirtualIP, resolver, 25000, 53, tcpFlagSYN)
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, query)); err != nil {
		t.Fatalf("DNS query was rejected: %v", err)
	}
	if len(driver.writes()) != 1 {
		t.Fatalf("DNS query writes=%d want=1", len(driver.writes()))
	}
	driver.emit(ipv4TCPPacketWithPorts(resolver, reservation.VirtualIP, 53, 25000, tcpFlagSYN|tcpFlagACK))
	select {
	case response := <-endpoint.Downlink():
		if len(response.Packets) != 1 {
			t.Fatalf("DNS response packets=%d", len(response.Packets))
		}
	default:
		t.Fatal("DNS response was not returned to Runtime")
	}
}

func TestGatewayReservationStartsBlockedUntilKernelPolicyApplied(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-initial-deny", Generation: 1},
		AgentID: "agent-initial-deny", VirtualIP: netip.MustParseAddr("100.96.0.21"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	if err := gateway.ReserveRuntime(reservation); !errors.Is(err, ErrDataPlaneUnavailable) {
		t.Fatalf("reservation was admitted before Gateway startup: %v", err)
	}
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	if err := gateway.ReserveRuntime(reservation); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1)); !errors.Is(err, ErrDataPlaneUnavailable) {
		t.Fatalf("tunnel opened before initial kernel policy: %v", err)
	}
	if err := gateway.SetPolicy(reservation.Key, reservation.NetworkMode, reservation.PolicyEpoch); err != nil {
		t.Fatal(err)
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1)); err != nil {
		t.Fatalf("tunnel did not open after initial policy application: %v", err)
	}
}

func TestGatewayRejectsReservedOrForeignVirtualAddress(t *testing.T) {
	gateway := newGateway(&fakeDataPlane{})
	if err := gateway.Start(context.Background(), "100.96.0.0/24"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	for _, address := range []string{"100.96.0.0", "100.96.0.1", "100.96.0.255", "100.97.0.2"} {
		reservation := Reservation{
			Key:     GenerationKey{RuntimeInstanceID: "runtime-address-" + strings.ReplaceAll(address, ".", "-"), Generation: 1},
			AgentID: "agent-address", VirtualIP: netip.MustParseAddr(address),
			AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 1,
		}
		if err := gateway.ReserveRuntime(reservation); !errors.Is(err, ErrReservationConflict) {
			t.Fatalf("reserved or foreign address %s was admitted: %v", address, err)
		}
	}
}

func TestGatewayBarrierFailureRemainsClosed(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-2", Generation: 1},
		AgentID: "agent-2", VirtualIP: netip.MustParseAddr("100.96.0.3"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	other := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-2-other", Generation: 1},
		AgentID: "agent-2-other", VirtualIP: netip.MustParseAddr("100.96.0.6"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 4,
	}
	reserveAndApply(t, gateway, other)
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1)); err != nil {
		t.Fatal(err)
	}
	otherEndpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(other, 1, 4))
	if err != nil {
		t.Fatal(err)
	}
	driver.setDenyError(errors.New("injected barrier failure"))
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 2); !errors.Is(err, driver.denyErr) {
		t.Fatalf("expected barrier failure, got %v", err)
	}
	if gateway.started || !gateway.broken {
		t.Fatal("barrier failure did not trip the global data-plane circuit breaker")
	}
	select {
	case _, ok := <-otherEndpoint.Downlink():
		if ok {
			t.Fatal("global circuit breaker left an unaffected tunnel open")
		}
	default:
		t.Fatal("global circuit breaker did not synchronously close every tunnel")
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 2)); !errors.Is(err, ErrDataPlaneUnavailable) {
		t.Fatalf("failed barrier reopened packet admission: %v", err)
	}
	driver.setDenyError(nil)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatalf("clean Gateway restart failed: %v", err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 2); err != nil {
		t.Fatalf("retry failed barrier with the same policy operation: %v", err)
	}
	if err := gateway.SetPolicy(other.Key, runtimecontracts.NetworkRestricted, 4); err != nil {
		t.Fatalf("same-epoch restricted recovery failed: %v", err)
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 2)); err != nil {
		t.Fatalf("successful retry did not reopen the target restricted epoch: %v", err)
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(other, 2, 4)); err != nil {
		t.Fatalf("clean restart did not recover the unaffected restricted reservation: %v", err)
	}
}

func TestGatewayInitialPolicyCanWidenAtCommittedEpochButReadyPolicyCannot(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-recovery", Generation: 3},
		AgentID: "agent-recovery", VirtualIP: netip.MustParseAddr("100.96.0.4"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 7,
	}
	if err := gateway.ReserveRuntime(reservation); err != nil {
		t.Fatal(err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkUnrestricted, 7); err != nil {
		t.Fatalf("same-epoch initial widening failed: %v", err)
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 8, 7)); err != nil {
		t.Fatalf("initial widened epoch did not admit a tunnel: %v", err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 8); err != nil {
		t.Fatalf("advance to restricted policy: %v", err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkUnrestricted, 8); err == nil {
		t.Fatal("ready restricted policy widened without advancing its epoch")
	}
}

func TestGatewaySameModeEpochAdvanceReappliesKernelBarrier(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-same-mode", Generation: 1},
		AgentID: "agent-same-mode", VirtualIP: netip.MustParseAddr("100.96.0.22"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1")))); err != nil {
		t.Fatal(err)
	}
	driver.clearDenyCalls()
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkUnrestricted, 2); err != nil {
		t.Fatal(err)
	}
	if calls := driver.denyCallsSnapshot(); len(calls) != 2 || !calls[0] || calls[1] {
		t.Fatalf("same-mode epoch advance did not deny then allow: %v", calls)
	}
	if gateway.flowCount != 0 {
		t.Fatalf("same-mode epoch advance retained old conntrack mirror: %d", gateway.flowCount)
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1")))); !errors.Is(err, ErrSessionFenced) {
		t.Fatalf("same-mode epoch advance did not fence old tunnel: %v", err)
	}
}

func TestGatewayPolicyBarrierWaitsForInflightPacketWriter(t *testing.T) {
	driver := &fakeDataPlane{
		writeStarted: make(chan struct{}),
		writeRelease: make(chan struct{}),
	}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-barrier", Generation: 1},
		AgentID: "agent-barrier", VirtualIP: netip.MustParseAddr("100.96.0.5"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	driver.denyStarted = make(chan struct{})
	packet := ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1"))
	writeDone := make(chan error, 1)
	go func() {
		writeDone <- endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, packet))
	}()
	select {
	case <-driver.writeStarted:
	case <-time.After(time.Second):
		t.Fatal("uplink writer did not reach the data plane")
	}

	policyDone := make(chan error, 1)
	go func() {
		policyDone <- gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 2)
	}()
	deadline := time.Now().Add(time.Second)
	for {
		gateway.mu.Lock()
		blocked := gateway.reservations[reservation.Key].policyPhase != policyReady
		gateway.mu.Unlock()
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("policy transition did not close packet admission")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case <-driver.denyStarted:
		t.Fatal("kernel barrier ran before the in-flight writer drained")
	default:
	}

	close(driver.writeRelease)
	if err := <-writeDone; err != nil {
		t.Fatalf("in-flight uplink failed before the barrier: %v", err)
	}
	select {
	case err := <-policyDone:
		if err != nil {
			t.Fatalf("policy barrier failed: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("policy barrier did not finish after the writer drained")
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, packet)); !errors.Is(err, ErrSessionFenced) {
		t.Fatalf("old endpoint wrote after policy barrier: %v", err)
	}
}

func TestGatewaySerializesConcurrentPolicyEpochs(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-policy-order", Generation: 1},
		AgentID: "agent-policy-order", VirtualIP: netip.MustParseAddr("100.96.0.17"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	driver.denyStarted = make(chan struct{})
	driver.denyRelease = make(chan struct{})

	newerDone := make(chan error, 1)
	go func() {
		newerDone <- gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 3)
	}()
	select {
	case <-driver.denyStarted:
	case <-time.After(time.Second):
		t.Fatal("newer policy did not reach the kernel barrier")
	}
	olderDone := make(chan error, 1)
	go func() {
		olderDone <- gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkUnrestricted, 2)
	}()
	select {
	case err := <-olderDone:
		t.Fatalf("older policy bypassed the in-flight operation: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	close(driver.denyRelease)
	if err := <-newerDone; err != nil {
		t.Fatalf("newer policy failed: %v", err)
	}
	if err := <-olderDone; err == nil || !strings.Contains(err.Error(), "cannot move backwards") {
		t.Fatalf("older policy was not rejected after serialization: %v", err)
	}
	gateway.mu.Lock()
	state := gateway.reservations[reservation.Key]
	mode, epoch, ready := state.reservation.NetworkMode, state.reservation.PolicyEpoch, state.policyPhase == policyReady
	gateway.mu.Unlock()
	if mode != runtimecontracts.NetworkRestricted || epoch != 3 || !ready {
		t.Fatalf("older policy overwrote the committed state: mode=%s epoch=%d ready=%t", mode, epoch, ready)
	}
}

func TestGatewayReleasePreventsPolicyReservationABA(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-policy-aba", Generation: 1},
		AgentID: "agent-policy-aba", VirtualIP: netip.MustParseAddr("100.96.0.18"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	driver.denyStarted = make(chan struct{})
	driver.denyRelease = make(chan struct{})
	policyDone := make(chan error, 1)
	go func() {
		policyDone <- gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 2)
	}()
	select {
	case <-driver.denyStarted:
	case <-time.After(time.Second):
		t.Fatal("policy did not reach the kernel barrier")
	}
	releaseDone := make(chan error, 1)
	go func() {
		releaseDone <- gateway.ReleaseRuntime(context.Background(), reservation.Key)
	}()
	deadline := time.Now().Add(time.Second)
	for {
		gateway.mu.Lock()
		releasing := gateway.reservations[reservation.Key].policyPhase == policyReleasing
		gateway.mu.Unlock()
		if releasing {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("release did not fence the reservation")
		}
		time.Sleep(time.Millisecond)
	}
	replacement := reservation
	replacement.VirtualIP = netip.MustParseAddr("100.96.0.19")
	if err := gateway.ReserveRuntime(replacement); !errors.Is(err, ErrReservationConflict) {
		t.Fatalf("replacement was admitted before old policy completion: %v", err)
	}
	close(driver.denyRelease)
	if err := <-policyDone; !errors.Is(err, ErrReservationMissing) {
		t.Fatalf("old policy operation did not observe the release fence: %v", err)
	}
	select {
	case err := <-releaseDone:
		if err != nil {
			t.Fatalf("release runtime: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("release did not complete after the policy barrier")
	}
	reserveAndApply(t, gateway, replacement)
	gateway.mu.Lock()
	state := gateway.reservations[replacement.Key]
	gotIP, gotEpoch := state.reservation.VirtualIP, state.reservation.PolicyEpoch
	gateway.mu.Unlock()
	if gotIP != replacement.VirtualIP || gotEpoch != replacement.PolicyEpoch {
		t.Fatalf("old policy mutated replacement reservation: ip=%s epoch=%d", gotIP, gotEpoch)
	}
}

func TestGatewayReleaseAgentExceptRemovesOnlyStaleGenerations(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservations := []Reservation{
		{Key: GenerationKey{RuntimeInstanceID: "agent-1-g1", Generation: 1}, AgentID: "agent-1", VirtualIP: netip.MustParseAddr("100.96.0.21"), AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 1},
		{Key: GenerationKey{RuntimeInstanceID: "agent-1-g2", Generation: 2}, AgentID: "agent-1", VirtualIP: netip.MustParseAddr("100.96.0.22"), AllocatorEpoch: 2, NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 2},
		{Key: GenerationKey{RuntimeInstanceID: "agent-2-g1", Generation: 1}, AgentID: "agent-2", VirtualIP: netip.MustParseAddr("100.96.0.23"), AllocatorEpoch: 3, NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 1},
	}
	for _, reservation := range reservations {
		if err := gateway.ReserveRuntime(reservation); err != nil {
			t.Fatal(err)
		}
	}
	if err := gateway.ReleaseAgentExcept(context.Background(), "agent-1", reservations[1].Key); err != nil {
		t.Fatalf("release stale reservations: %v", err)
	}
	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	if len(gateway.reservations) != 2 || gateway.reservations[reservations[0].Key] != nil ||
		gateway.reservations[reservations[1].Key] == nil || gateway.reservations[reservations[2].Key] == nil {
		t.Fatalf("unexpected reservations after generation cleanup: %+v", gateway.reservations)
	}
}

func TestGatewayOldDataPlaneCallbackCannotReachReplacement(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-packet-aba", Generation: 1},
		AgentID: "agent-packet-aba", VirtualIP: netip.MustParseAddr("100.96.0.20"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	first, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	oldDeliver := driver.deliveryCallback()
	remote := netip.MustParseAddr("1.1.1.1")
	if err := first.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 27000, 443, tcpFlagSYN))); err != nil {
		t.Fatal(err)
	}
	if err := gateway.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkUnrestricted, 1); err != nil {
		t.Fatal(err)
	}
	second, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 1))
	if err != nil {
		t.Fatal(err)
	}
	if err := second.ReceiveUplink(context.Background(), packetBatch(2, 1,
		ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 27000, 443, tcpFlagSYN))); err != nil {
		t.Fatal(err)
	}
	reverse := ipv4TCPPacketWithPorts(remote, reservation.VirtualIP, 443, 27000, tcpFlagSYN|tcpFlagACK)
	oldDeliver(reverse)
	select {
	case <-second.Downlink():
		t.Fatal("old data-plane callback delivered into the replacement generation")
	default:
	}
	driver.deliveryCallback()(reverse)
	select {
	case <-second.Downlink():
	default:
		t.Fatal("current data-plane callback did not deliver the matching flow")
	}
}

func TestGatewayFlowAdmissionRequiresSYNAndReverseTuple(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-flow", Generation: 1},
		AgentID: "agent-flow", VirtualIP: netip.MustParseAddr("100.96.0.7"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 3,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 9, 3))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("1.1.1.1")
	ack := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 20000, 443, tcpFlagACK)
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(9, 3, ack)); err != nil {
		t.Fatalf("stale packet should be dropped without fencing its tunnel: %v", err)
	}
	if len(driver.writes()) != 0 || gateway.flowCount != 0 {
		t.Fatalf("new flow without SYN reached the data plane: writes=%d flows=%d", len(driver.writes()), gateway.flowCount)
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(8, 3, ipv4TCPPacket(reservation.VirtualIP, remote))); !errors.Is(err, ErrSessionFenced) {
		t.Fatalf("batch connectionEpoch mismatch was admitted: %v", err)
	}

	syn := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 20000, 443, tcpFlagSYN)
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(9, 3, syn)); err != nil {
		t.Fatalf("initial SYN was rejected: %v", err)
	}
	driver.emit(ipv4TCPPacketWithPorts(remote, reservation.VirtualIP, 443, 20001, tcpFlagSYN|tcpFlagACK))
	select {
	case <-endpoint.Downlink():
		t.Fatal("reverse packet with a mismatched local port was delivered")
	default:
	}
	driver.emit(ipv4TCPPacketWithPorts(remote, reservation.VirtualIP, 443, 20000, tcpFlagSYN|tcpFlagACK))
	select {
	case batch := <-endpoint.Downlink():
		if batch.ConnectionEpoch != 9 || batch.PolicyEpoch != 3 {
			t.Fatalf("reverse flow lost its fence identity: %#v", batch)
		}
	default:
		t.Fatal("matching reverse flow was not delivered")
	}

	driver.emit(ipv4TCPPacketWithPorts(remote, reservation.VirtualIP, 443, 20000, tcpFlagRST|tcpFlagACK))
	select {
	case <-endpoint.Downlink():
	default:
		t.Fatal("terminal RST was not delivered")
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(9, 3, ack)); err != nil {
		t.Fatalf("packet after RST should be dropped without fencing its tunnel: %v", err)
	}
}

func TestGatewayPolicyTransitionClearsOldEpochFlows(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-flow-epoch", Generation: 1},
		AgentID: "agent-flow-epoch", VirtualIP: netip.MustParseAddr("100.96.0.8"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	first, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("8.8.8.8")
	syn := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 21000, 443, tcpFlagSYN)
	if err := first.ReceiveUplink(context.Background(), packetBatch(1, 1, syn)); err != nil {
		t.Fatal(err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkRestricted, 2); err != nil {
		t.Fatal(err)
	}
	if err := gateway.SetPolicy(reservation.Key, runtimecontracts.NetworkUnrestricted, 3); err != nil {
		t.Fatal(err)
	}
	second, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 3))
	if err != nil {
		t.Fatal(err)
	}
	oldACK := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 21000, 443, tcpFlagACK)
	if err := second.ReceiveUplink(context.Background(), packetBatch(2, 3, oldACK)); err != nil {
		t.Fatalf("old epoch packet should be dropped without fencing its tunnel: %v", err)
	}
	if err := second.ReceiveUplink(context.Background(), packetBatch(2, 3, syn)); err != nil {
		t.Fatalf("new epoch SYN did not establish a fresh flow: %v", err)
	}
}

func TestGatewayTunnelReplacementCannotInheritFlow(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-flow-reconnect", Generation: 1},
		AgentID: "agent-flow-reconnect", VirtualIP: netip.MustParseAddr("100.96.0.16"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	first, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("1.1.1.1")
	syn := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 26000, 443, tcpFlagSYN)
	if err := first.ReceiveUplink(context.Background(), packetBatch(1, 1, syn)); err != nil {
		t.Fatal(err)
	}
	first.Close(errors.New("injected tunnel detach"))
	if gateway.flowCount != 0 {
		t.Fatalf("detached tunnel retained flow state: %d", gateway.flowCount)
	}
	second, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 1))
	if err != nil {
		t.Fatal(err)
	}
	ack := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 26000, 443, tcpFlagACK)
	if err := second.ReceiveUplink(context.Background(), packetBatch(2, 1, ack)); err != nil {
		t.Fatalf("old connectionEpoch packet should be dropped without fencing its tunnel: %v", err)
	}
	if err := second.ReceiveUplink(context.Background(), packetBatch(2, 1, syn)); err != nil {
		t.Fatalf("replacement connectionEpoch could not create a new flow: %v", err)
	}
}

func TestGatewayFlowLimitsAndIdleReaping(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	now := time.Unix(1_000, 0)
	gateway.now = func() time.Time { return now }
	gateway.maxFlows = 1
	gateway.maxFlowsAll = 1
	gateway.flowIdle = time.Minute
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-flow-limit", Generation: 1},
		AgentID: "agent-flow-limit", VirtualIP: netip.MustParseAddr("100.96.0.9"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	first := ipv4TCPPacketWithPorts(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1"), 22000, 443, tcpFlagSYN)
	second := ipv4TCPPacketWithPorts(reservation.VirtualIP, netip.MustParseAddr("8.8.8.8"), 22001, 443, tcpFlagSYN)
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, first)); err != nil {
		t.Fatal(err)
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, second)); err != nil {
		t.Fatalf("flow over capacity should be dropped without fencing its tunnel: %v", err)
	}
	if len(driver.writes()) != 1 || gateway.flowCount != 1 {
		t.Fatalf("flow limit did not preserve the admitted flow: writes=%d flows=%d", len(driver.writes()), gateway.flowCount)
	}
	now = now.Add(time.Minute)
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, second)); err != nil {
		t.Fatalf("expired flow did not release capacity: %v", err)
	}
	if gateway.flowCount != 1 {
		t.Fatalf("unexpected global flow count after reap: %d", gateway.flowCount)
	}
}

func TestGatewayFlowBatchAdmissionIsAtomic(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-flow-batch", Generation: 1},
		AgentID: "agent-flow-batch", VirtualIP: netip.MustParseAddr("100.96.0.13"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("1.1.1.1")
	syn := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 24000, 443, tcpFlagSYN)
	unknownACK := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 24001, 443, tcpFlagACK)
	batch := PacketBatch{
		ConnectionEpoch: 1,
		PolicyEpoch:     1,
		Packets:         [][]byte{syn, unknownACK},
	}
	if err := endpoint.ReceiveUplink(context.Background(), batch); err != nil {
		t.Fatalf("partially invalid batch should be dropped without fencing its tunnel: %v", err)
	}
	if len(driver.writes()) != 0 || gateway.flowCount != 0 {
		t.Fatalf("rejected batch left partial state: writes=%d flows=%d", len(driver.writes()), gateway.flowCount)
	}
}

func TestGatewayRuntimeRateLimitDropsThenFencesWithoutGlobalFailure(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	gateway.maxRatePackets = 1
	gateway.maxRateBytes = 1 << 20
	gateway.maxRateDrops = 3
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-rate-limit", Generation: 1},
		AgentID: "agent-rate-limit", VirtualIP: netip.MustParseAddr("100.96.0.23"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("1.1.1.1")
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 28000, 443, tcpFlagSYN))); err != nil {
		t.Fatal(err)
	}
	ack := packetBatch(1, 1, ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 28000, 443, tcpFlagACK))
	for attempt := 1; attempt <= 2; attempt++ {
		if err := endpoint.ReceiveUplink(context.Background(), ack); err != nil {
			t.Fatalf("soft rate-limit drop %d fenced early: %v", attempt, err)
		}
	}
	if err := endpoint.ReceiveUplink(context.Background(), ack); !errors.Is(err, ErrPacketRejected) {
		t.Fatalf("repeated rate-limit violation was not fenced: %v", err)
	}
	if !gateway.Ready() {
		t.Fatal("one Runtime rate violation tripped the global Gateway")
	}
	if len(driver.writes()) != 1 || gateway.flowCount != 1 {
		t.Fatalf("rate-limited packets changed data-plane state: writes=%d flows=%d", len(driver.writes()), gateway.flowCount)
	}
}

func TestGatewayFlowExpiresAfterBidirectionalFINGrace(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	now := time.Unix(2_000, 0)
	gateway.now = func() time.Time { return now }
	gateway.flowGrace = time.Second
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-flow-fin", Generation: 1},
		AgentID: "agent-flow-fin", VirtualIP: netip.MustParseAddr("100.96.0.14"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("8.8.8.8")
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 25000, 443, tcpFlagSYN))); err != nil {
		t.Fatal(err)
	}
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 25000, 443, tcpFlagFIN|tcpFlagACK))); err != nil {
		t.Fatal(err)
	}
	driver.emit(ipv4TCPPacketWithPorts(remote, reservation.VirtualIP, 443, 25000, tcpFlagFIN|tcpFlagACK))
	select {
	case <-endpoint.Downlink():
	default:
		t.Fatal("reverse FIN was not delivered")
	}
	now = now.Add(time.Second)
	ack := ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 25000, 443, tcpFlagACK)
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, ack)); err != nil {
		t.Fatalf("expired-flow packet should be dropped without fencing its tunnel: %v", err)
	}
	if gateway.flowCount != 0 {
		t.Fatalf("closed flow was not reaped: %d", gateway.flowCount)
	}
}

func TestGatewayPacketParserFailsClosed(t *testing.T) {
	source := netip.MustParseAddr("100.96.0.10")
	valid := ipv4TCPPacketWithPorts(source, netip.MustParseAddr("1.1.1.1"), 23000, 443, tcpFlagSYN)
	tests := []struct {
		name   string
		packet func() []byte
	}{
		{name: "empty", packet: func() []byte { return nil }},
		{name: "over mtu", packet: func() []byte { return make([]byte, DefaultMTU+1) }},
		{name: "ipv6", packet: func() []byte { packet := append([]byte(nil), valid...); packet[0] = 0x65; return packet }},
		{name: "short ihl", packet: func() []byte { packet := append([]byte(nil), valid...); packet[0] = 0x44; return packet }},
		{name: "ipv4 options", packet: func() []byte { packet := append([]byte(nil), valid...); packet[0] = 0x46; return packet }},
		{name: "length mismatch", packet: func() []byte { packet := append([]byte(nil), valid...); packet[3]++; return packet }},
		{name: "fragment", packet: func() []byte { packet := append([]byte(nil), valid...); packet[6] = 0x20; return packet }},
		{name: "udp", packet: func() []byte { packet := append([]byte(nil), valid...); packet[9] = 17; return packet }},
		{name: "zero port", packet: func() []byte { packet := append([]byte(nil), valid...); packet[20], packet[21] = 0, 0; return packet }},
		{name: "short tcp header", packet: func() []byte { packet := append([]byte(nil), valid...); packet[32] = 0x40; return packet }},
		{name: "syn fin", packet: func() []byte {
			packet := append([]byte(nil), valid...)
			packet[33] = tcpFlagSYN | tcpFlagFIN
			return packet
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := validateIPv4TCPPacket(test.packet(), source, DefaultMTU); !errors.Is(err, ErrPacketRejected) {
				t.Fatalf("malformed packet was accepted: %v", err)
			}
		})
	}
	if err := validateIPv4TCPPacket(valid, netip.MustParseAddr("100.96.0.11"), DefaultMTU); !errors.Is(err, ErrPacketRejected) {
		t.Fatalf("source spoof was accepted: %v", err)
	}
	privateTarget := ipv4TCPPacketWithPorts(source, netip.MustParseAddr("169.254.169.254"), 23000, 80, tcpFlagSYN)
	if err := validateIPv4TCPPacket(privateTarget, source, DefaultMTU); !errors.Is(err, ErrPacketRejected) {
		t.Fatalf("metadata target was accepted: %v", err)
	}
	privateSource := ipv4TCPPacketWithPorts(netip.MustParseAddr("10.0.0.1"), source, 443, 23000, tcpFlagACK)
	if _, err := validateIPv4TCPDownlink(privateSource, DefaultMTU); !errors.Is(err, ErrPacketRejected) {
		t.Fatalf("private reverse source was accepted: %v", err)
	}
}

func TestGatewayDataPlaneFailureTripsOnlyCurrentGeneration(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-reader-failure", Generation: 1},
		AgentID: "agent-reader-failure", VirtualIP: netip.MustParseAddr("100.96.0.12"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkRestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	oldFailure := driver.failureCallback()
	oldFailure(errors.New("injected TUN reader failure"))
	deadline := time.Now().Add(time.Second)
	for gateway.Ready() && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if gateway.Ready() {
		t.Fatal("asynchronous TUN reader failure did not trip readiness")
	}
	select {
	case _, ok := <-endpoint.Downlink():
		if ok {
			t.Fatal("TUN reader failure left the tunnel open")
		}
	case <-time.After(time.Second):
		t.Fatal("TUN reader failure did not close the tunnel")
	}
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatalf("clean data-plane restart failed: %v", err)
	}
	oldFailure(errors.New("stale reader failure"))
	time.Sleep(20 * time.Millisecond)
	if !gateway.Ready() {
		t.Fatal("stale data-plane generation failure tripped the replacement Gateway")
	}
}

func TestGatewayTUNWriteFailureTripsCircuitBreaker(t *testing.T) {
	driver := &fakeDataPlane{writeErr: errors.New("injected TUN write failure")}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-write-failure", Generation: 1},
		AgentID: "agent-write-failure", VirtualIP: netip.MustParseAddr("100.96.0.15"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	packet := ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1"))
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, packet)); !errors.Is(err, ErrDataPlaneUnavailable) || !errors.Is(err, driver.writeErr) {
		t.Fatalf("TUN write failure did not surface through the circuit breaker: %v", err)
	}
	if gateway.Ready() || gateway.flowCount != 0 {
		t.Fatalf("TUN write failure left Gateway state open: ready=%t flows=%d", gateway.Ready(), gateway.flowCount)
	}
}

func TestGatewayTUNWriteBackpressureFencesOnlyTunnel(t *testing.T) {
	driver := &fakeDataPlane{writeErr: ErrDataPlaneBackpressure}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-write-backpressure", Generation: 1},
		AgentID: "agent-write-backpressure", VirtualIP: netip.MustParseAddr("100.96.0.24"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	packet := ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1"))
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1, packet)); !errors.Is(err, ErrPacketRejected) || errors.Is(err, ErrDataPlaneUnavailable) {
		t.Fatalf("TUN backpressure did not remain reservation-local: %v", err)
	}
	if !gateway.Ready() || gateway.flowCount != 0 {
		t.Fatalf("TUN backpressure damaged global or flow state: ready=%t flows=%d", gateway.Ready(), gateway.flowCount)
	}
	select {
	case _, ok := <-endpoint.Downlink():
		if ok {
			t.Fatal("backpressured tunnel remained open")
		}
	default:
		t.Fatal("backpressured tunnel was not synchronously fenced")
	}
	driver.setWriteError(nil)
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 1)); err != nil {
		t.Fatalf("replacement tunnel was not admitted after local reset: %v", err)
	}
}

func TestGatewayCanceledUplinkRollsBackFlowAndFencesTunnel(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:       GenerationKey{RuntimeInstanceID: "runtime-canceled-uplink", Generation: 1},
		AgentID:   "agent-canceled-uplink",
		VirtualIP: netip.MustParseAddr("100.96.0.25"), AllocatorEpoch: 1,
		NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	packet := ipv4TCPPacket(reservation.VirtualIP, netip.MustParseAddr("1.1.1.1"))
	if err := endpoint.ReceiveUplink(ctx, packetBatch(1, 1, packet)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled uplink result = %v", err)
	}
	if gateway.flowCount != 0 || len(driver.writes()) != 0 {
		t.Fatalf("canceled uplink retained staged effects: flows=%d writes=%d", gateway.flowCount, len(driver.writes()))
	}
	select {
	case _, ok := <-endpoint.Downlink():
		if ok {
			t.Fatal("canceled uplink tunnel remained open")
		}
	default:
		t.Fatal("canceled uplink did not synchronously fence its tunnel")
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 1)); err != nil {
		t.Fatalf("replacement tunnel was not admitted after canceled uplink reset: %v", err)
	}
}

func TestGatewayDownlinkQueueOverflowResetsOnlyTunnel(t *testing.T) {
	driver := &fakeDataPlane{}
	gateway := newGateway(driver)
	if err := gateway.Start(context.Background(), "100.96.0.0/16"); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = gateway.Close() })
	reservation := Reservation{
		Key:     GenerationKey{RuntimeInstanceID: "runtime-downlink-backpressure", Generation: 1},
		AgentID: "agent-downlink-backpressure", VirtualIP: netip.MustParseAddr("100.96.0.25"),
		AllocatorEpoch: 1, NetworkMode: runtimecontracts.NetworkUnrestricted, PolicyEpoch: 1,
	}
	reserveAndApply(t, gateway, reservation)
	endpoint, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 1, 1))
	if err != nil {
		t.Fatal(err)
	}
	remote := netip.MustParseAddr("1.1.1.1")
	if err := endpoint.ReceiveUplink(context.Background(), packetBatch(1, 1,
		ipv4TCPPacketWithPorts(reservation.VirtualIP, remote, 29000, 443, tcpFlagSYN))); err != nil {
		t.Fatal(err)
	}
	reverse := ipv4TCPPacketWithPorts(remote, reservation.VirtualIP, 443, 29000, tcpFlagACK)
	for range defaultDownlinkQueue + 1 {
		driver.emit(reverse)
	}
	if !gateway.Ready() || gateway.flowCount != 0 {
		t.Fatalf("downlink overflow damaged global or flow state: ready=%t flows=%d", gateway.Ready(), gateway.flowCount)
	}
	gateway.mu.Lock()
	state := gateway.reservations[reservation.Key]
	attached, ready := state.endpoint != nil, state.policyPhase == policyReady
	gateway.mu.Unlock()
	if attached || !ready {
		t.Fatalf("overflowed tunnel was not reset: attached=%t ready=%t", attached, ready)
	}
	select {
	case _, ok := <-endpoint.Downlink():
		if ok {
			t.Fatal("overflowed tunnel retained a queued packet after fencing")
		}
	default:
		t.Fatal("overflowed tunnel did not close after dropping its queued packets")
	}
	if _, err := gateway.OpenTunnel(context.Background(), tunnelIdentity(reservation, 2, 1)); err != nil {
		t.Fatalf("replacement tunnel was not admitted after downlink reset: %v", err)
	}
}

type fakeDataPlane struct {
	mu           sync.Mutex
	startErr     error
	deliver      func([]byte)
	packets      [][]byte
	denied       map[netip.Addr]bool
	denyCalls    []bool
	denyErr      error
	writeErr     error
	writeStarted chan struct{}
	writeRelease chan struct{}
	denyStarted  chan struct{}
	denyRelease  chan struct{}
	failure      func(error)
	writeOnce    sync.Once
	denyOnce     sync.Once
}

func (d *fakeDataPlane) Start(_ context.Context, _ netip.Prefix, _ int, deliver func([]byte), failure func(error)) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.startErr != nil {
		return d.startErr
	}
	d.deliver = deliver
	d.failure = failure
	d.denied = make(map[netip.Addr]bool)
	return nil
}

func (d *fakeDataPlane) WritePacket(packet []byte) error {
	if d.writeStarted != nil {
		d.writeOnce.Do(func() { close(d.writeStarted) })
	}
	if d.writeRelease != nil {
		<-d.writeRelease
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.writeErr != nil {
		return d.writeErr
	}
	d.packets = append(d.packets, append([]byte(nil), packet...))
	return nil
}

func (d *fakeDataPlane) SetDenied(_ context.Context, address netip.Addr, denied bool) error {
	if d.denyStarted != nil {
		d.denyOnce.Do(func() { close(d.denyStarted) })
	}
	if d.denyRelease != nil {
		<-d.denyRelease
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.denyErr != nil {
		return d.denyErr
	}
	d.denied[address] = denied
	d.denyCalls = append(d.denyCalls, denied)
	return nil
}

func (d *fakeDataPlane) Close() error { return nil }

func (d *fakeDataPlane) writes() [][]byte {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([][]byte(nil), d.packets...)
}

func (d *fakeDataPlane) emit(packet []byte) {
	d.mu.Lock()
	deliver := d.deliver
	d.mu.Unlock()
	deliver(packet)
}

func (d *fakeDataPlane) deniedState(address netip.Addr) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.denied[address]
}

func (d *fakeDataPlane) setDenyError(err error) {
	d.mu.Lock()
	d.denyErr = err
	d.mu.Unlock()
}

func (d *fakeDataPlane) setWriteError(err error) {
	d.mu.Lock()
	d.writeErr = err
	d.mu.Unlock()
}

func (d *fakeDataPlane) clearDenyCalls() {
	d.mu.Lock()
	d.denyCalls = nil
	d.mu.Unlock()
}

func (d *fakeDataPlane) denyCallsSnapshot() []bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]bool(nil), d.denyCalls...)
}

func (d *fakeDataPlane) failureCallback() func(error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.failure
}

func (d *fakeDataPlane) deliveryCallback() func([]byte) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.deliver
}

func tunnelIdentity(reservation Reservation, connectionEpoch uint64, policyEpoch uint64) TunnelIdentity {
	return TunnelIdentity{
		Key: reservation.Key, AgentID: reservation.AgentID,
		RuntimeBootID: "boot", ConnectionEpoch: connectionEpoch, PolicyRevision: policyEpoch,
		PolicyEpoch: policyEpoch, TunnelVirtualIP: reservation.VirtualIP, AllocatorEpoch: reservation.AllocatorEpoch,
	}
}

func reserveAndApply(t *testing.T, gateway *Gateway, reservation Reservation) {
	t.Helper()
	if err := gateway.ReserveRuntime(reservation); err != nil {
		t.Fatal(err)
	}
	if err := gateway.SetPolicy(reservation.Key, reservation.NetworkMode, reservation.PolicyEpoch); err != nil {
		t.Fatal(err)
	}
}

func packetBatch(connectionEpoch uint64, epoch uint64, packet []byte) PacketBatch {
	return PacketBatch{ConnectionEpoch: connectionEpoch, PolicyEpoch: epoch, Packets: [][]byte{packet}}
}

func ipv4TCPPacket(source netip.Addr, destination netip.Addr) []byte {
	return ipv4TCPPacketWithPorts(source, destination, 12345, 443, tcpFlagSYN)
}

func ipv4TCPPacketWithPorts(source netip.Addr, destination netip.Addr, sourcePort, destinationPort uint16, flags byte) []byte {
	packet := make([]byte, 40)
	packet[0] = 0x45
	packet[2], packet[3] = 0, byte(len(packet))
	packet[8] = 64
	packet[9] = 6
	sourceBytes := source.As4()
	destinationBytes := destination.As4()
	copy(packet[12:16], sourceBytes[:])
	copy(packet[16:20], destinationBytes[:])
	packet[20], packet[21] = byte(sourcePort>>8), byte(sourcePort)
	packet[22], packet[23] = byte(destinationPort>>8), byte(destinationPort)
	packet[32] = 0x50
	packet[33] = flags
	return packet
}
