use std::{
    net::{Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};

use antnest_runtime_egress::{
    dataplane::{
        AgentRoute, DataPlaneAction, DataPlaneEngine, DropReason, NetworkSnapshot, RouteGate,
    },
    domain::AgentId,
    policy::PolicySpec,
};

const SYN: &str =
    "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000";

const RESOLVER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);

fn route(policy: PolicySpec, version: u64) -> AgentRoute {
    AgentRoute {
        agent_id: AgentId::parse("agent-1").unwrap(),
        tunnel_ipv4: "100.96.0.10".parse().unwrap(),
        assignment_version: version,
        policy: policy.compile(RESOLVER),
        gate: RouteGate::Open,
        runtime_endpoint: Some("10.0.0.2".parse().unwrap()),
    }
}

fn engine(policy: PolicySpec) -> DataPlaneEngine {
    DataPlaneEngine::new(
        NetworkSnapshot::from_routes([route(policy, 1)]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    )
}

#[test]
fn allow_policy_claims_flow_and_writes_the_original_packet() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = decode_hex(SYN);
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();

    assert_eq!(
        engine.handle_uplink(&packet, peer, Instant::now()),
        DataPlaneAction::WriteTun(packet)
    );
}

#[test]
fn issue_34_another_outer_peer_cannot_borrow_an_allow_all_route() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = decode_hex(SYN);
    let attacker: SocketAddr = "10.0.0.3:42000".parse().unwrap();

    let action = engine.handle_uplink(&packet, attacker, Instant::now());

    assert!(matches!(action, DataPlaneAction::Drop(_)), "{action:?}");
    assert_eq!(engine.flow_count(), 0);
    assert_eq!(engine.metrics().policy_allows, 0);
    assert_eq!(engine.metrics().peer_mismatches, 1);
}

#[test]
fn unbound_open_route_cannot_create_or_inject_a_flow() {
    let mut unbound = route(PolicySpec::allow_all(), 1);
    unbound.runtime_endpoint = None;
    let mut engine = DataPlaneEngine::new(
        NetworkSnapshot::from_routes([unbound]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    );
    assert_eq!(
        engine.handle_uplink(
            &decode_hex(SYN),
            "10.0.0.2:41000".parse().unwrap(),
            Instant::now()
        ),
        DataPlaneAction::Drop(DropReason::PeerMismatch)
    );
    assert_eq!(engine.flow_count(), 0);
}

#[test]
fn bound_peer_can_change_source_port_for_a_new_flow() {
    let mut engine = engine(PolicySpec::allow_all());
    let first = decode_hex(SYN);
    let mut second = first.clone();
    second[20..22].copy_from_slice(&41001_u16.to_be_bytes());
    let now = Instant::now();
    assert!(matches!(
        engine.handle_uplink(&first, "10.0.0.2:41000".parse().unwrap(), now),
        DataPlaneAction::WriteTun(_)
    ));
    assert!(matches!(
        engine.handle_uplink(&second, "10.0.0.2:42000".parse().unwrap(), now),
        DataPlaneAction::WriteTun(_)
    ));
    assert_eq!(engine.flow_count(), 2);
    assert_eq!(
        engine.handle_uplink(&first, "10.0.0.2:42000".parse().unwrap(), now),
        DataPlaneAction::Drop(DropReason::FlowCollision)
    );
}

#[test]
fn reverse_output_does_not_reuse_a_flow_owned_by_a_previous_peer() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = decode_hex(SYN);
    let now = Instant::now();
    engine.handle_uplink(&packet, "10.0.0.2:41000".parse().unwrap(), now);
    let mut updated = route(PolicySpec::allow_all(), 1);
    updated.runtime_endpoint = Some("10.0.0.3".parse().unwrap());
    engine.upsert_route(updated);
    assert_eq!(
        engine.handle_downlink(&reverse_packet(&packet), now),
        DataPlaneAction::Drop(DropReason::PeerMismatch)
    );
}

#[test]
fn allow_policy_never_routes_back_into_protected_address_space() {
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    for destination in [
        "10.20.0.8",
        "100.96.0.11",
        "127.0.0.1",
        "169.254.1.1",
        "172.20.0.8",
        "192.168.1.8",
        "224.0.0.1",
    ] {
        let mut engine = engine(PolicySpec::allow_all());
        let packet = packet_to(destination.parse().unwrap(), 8093);
        assert!(
            matches!(
                engine.handle_uplink(&packet, peer, Instant::now()),
                DataPlaneAction::SendUdp { .. }
            ),
            "{destination}"
        );
        assert_eq!(engine.flow_count(), 0, "{destination}");
    }
}

#[test]
fn virtual_resolver_dns_is_the_only_special_use_exception() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = packet_to("100.64.0.1".parse().unwrap(), 53);

    assert_eq!(
        engine.handle_uplink(&packet, "10.0.0.2:41000".parse().unwrap(), Instant::now()),
        DataPlaneAction::WriteTun(packet)
    );
}

#[test]
fn deny_policy_returns_reset_without_creating_a_flow() {
    let mut engine = engine(PolicySpec::deny_all());
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();

    let action = engine.handle_uplink(&decode_hex(SYN), peer, Instant::now());

    assert!(matches!(action, DataPlaneAction::SendUdp { peer: actual, .. } if actual == peer));
    assert_eq!(engine.flow_count(), 0);
}

#[test]
fn another_runtime_peer_cannot_steal_an_existing_flow() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = decode_hex(SYN);
    let first: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let second: SocketAddr = "10.0.0.3:42000".parse().unwrap();
    let now = Instant::now();
    engine.handle_uplink(&packet, first, now);

    assert_eq!(
        engine.handle_uplink(&packet, second, now),
        DataPlaneAction::Drop(DropReason::PeerMismatch)
    );
}

#[test]
fn downlink_uses_only_a_previously_claimed_reverse_flow() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = decode_hex(SYN);
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let now = Instant::now();
    engine.handle_uplink(&packet, peer, now);
    let reply = reverse_packet(&packet);

    assert_eq!(
        engine.handle_downlink(&reply, now),
        DataPlaneAction::SendUdp {
            agent_id: AgentId::parse("agent-1").unwrap(),
            peer,
            packet: reply,
        }
    );
}

#[test]
fn unknown_tunnel_source_is_dropped_fail_closed() {
    let mut engine = engine(PolicySpec::allow_all());
    let mut packet = decode_hex(SYN);
    packet[15] = 11;

    assert_eq!(
        engine.handle_uplink(&packet, "10.0.0.2:41000".parse().unwrap(), Instant::now()),
        DataPlaneAction::Drop(DropReason::UnknownAgent)
    );
}

#[test]
fn data_plane_observation_is_aggregate_and_content_free() {
    let mut engine = engine(PolicySpec::allow_all());
    let packet = decode_hex(SYN);
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    engine.handle_uplink(&packet, peer, Instant::now());
    let mut malformed = packet.clone();
    malformed.truncate(7);
    engine.handle_uplink(&malformed, peer, Instant::now());
    engine.handle_downlink(&reverse_packet(&packet), Instant::now());

    let metrics = engine.metrics();
    assert_eq!(metrics.uplink_packets, 2);
    assert_eq!(metrics.downlink_packets, 1);
    assert_eq!(metrics.policy_allows, 1);
    assert_eq!(metrics.malformed_packets, 1);
    assert_eq!(metrics.active_flows, 1);
    assert_eq!(metrics.reverse_flow_misses, 0);
}

#[test]
fn unsupported_packets_are_not_reported_as_malformed() {
    let mut engine = engine(PolicySpec::allow_all());
    let mut packet = decode_hex(SYN);
    packet[0] = 0x65;

    assert_eq!(
        engine.handle_uplink(&packet, "10.0.0.2:41000".parse().unwrap(), Instant::now()),
        DataPlaneAction::Drop(DropReason::UnsupportedPacket)
    );
    assert_eq!(engine.metrics().unsupported_packets, 1);
    assert_eq!(engine.metrics().malformed_packets, 0);
}

#[test]
fn fencing_one_agent_does_not_block_or_drop_another_agent() {
    let agent_one = AgentId::parse("agent-1").unwrap();
    let agent_two = AgentId::parse("agent-2").unwrap();
    let mut second_route = route(PolicySpec::allow_all(), 1);
    second_route.agent_id = agent_two.clone();
    second_route.tunnel_ipv4 = "100.96.0.11".parse().unwrap();
    let mut engine = DataPlaneEngine::new(
        NetworkSnapshot::from_routes([route(PolicySpec::allow_all(), 1), second_route]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    );
    engine.fence_agent(agent_one.clone());
    assert_eq!(engine.fenced_agent_count(), 1);
    let first = decode_hex(SYN);
    let mut second = first.clone();
    second[15] = 11;
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();

    assert_eq!(
        engine.handle_uplink(&first, peer, Instant::now()),
        DataPlaneAction::Drop(DropReason::AgentFenced)
    );
    assert_eq!(
        engine.handle_uplink(&second, peer, Instant::now()),
        DataPlaneAction::WriteTun(second)
    );
    assert_eq!(engine.metrics().fenced_packets, 1);

    engine.reopen_agent(&agent_one);
    assert_eq!(engine.fenced_agent_count(), 0);
    assert_eq!(
        engine.handle_uplink(&first, peer, Instant::now()),
        DataPlaneAction::WriteTun(first)
    );
}

#[test]
fn probe_only_agent_accepts_only_the_canonical_local_readiness_probe() {
    let agent = AgentId::parse("agent-1").unwrap();
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let mut engine = engine(PolicySpec::allow_all());
    engine.probe_only_agent(&agent);

    let probe = readiness_probe();
    let response = engine.handle_uplink(&probe, peer, Instant::now());
    let DataPlaneAction::SendUdp {
        agent_id,
        peer: response_peer,
        packet,
    } = response
    else {
        panic!("canonical readiness probe was not answered locally");
    };
    assert_eq!(agent_id, agent);
    assert_eq!(response_peer, peer);
    let reset = antnest_runtime_egress::packet::parse_ipv4_tcp(&packet, 1400)
        .expect("canonical readiness reset");
    assert_eq!(reset.source, Ipv4Addr::new(192, 0, 2, 1));
    assert_eq!(reset.destination, Ipv4Addr::new(100, 96, 0, 10));
    assert_eq!(reset.source_port, 9);
    assert_eq!(reset.destination_port, 49_153);
    assert!(
        reset
            .flags
            .contains(antnest_runtime_egress::packet::TcpFlags::RST)
    );
    assert!(
        reset
            .flags
            .contains(antnest_runtime_egress::packet::TcpFlags::ACK)
    );
    assert_eq!(engine.flow_count(), 0);

    for near_miss in readiness_near_misses() {
        assert_eq!(
            engine.handle_uplink(&near_miss, peer, Instant::now()),
            DataPlaneAction::Drop(DropReason::AgentFenced)
        );
    }
    assert_eq!(engine.flow_count(), 0);

    engine.fence_agent(agent);
    assert_eq!(
        engine.handle_uplink(&probe, peer, Instant::now()),
        DataPlaneAction::Drop(DropReason::AgentFenced)
    );
}

fn reverse_packet(packet: &[u8]) -> Vec<u8> {
    let mut reply = packet.to_vec();
    reply[12..16].copy_from_slice(&packet[16..20]);
    reply[16..20].copy_from_slice(&packet[12..16]);
    reply[20..22].copy_from_slice(&packet[22..24]);
    reply[22..24].copy_from_slice(&packet[20..22]);
    reply
}

fn packet_to(destination: std::net::Ipv4Addr, port: u16) -> Vec<u8> {
    let mut packet = decode_hex(SYN);
    packet[16..20].copy_from_slice(&destination.octets());
    packet[22..24].copy_from_slice(&port.to_be_bytes());
    packet
}

fn readiness_probe() -> Vec<u8> {
    let mut packet = packet_to(Ipv4Addr::new(192, 0, 2, 1), 9);
    packet[20..22].copy_from_slice(&49_153_u16.to_be_bytes());
    packet[28..32].fill(0);
    packet[33] = 0x02;
    packet
}

fn readiness_near_misses() -> Vec<Vec<u8>> {
    let mut wrong_port = readiness_probe();
    wrong_port[22..24].copy_from_slice(&10_u16.to_be_bytes());
    let mut acknowledged = readiness_probe();
    acknowledged[33] = 0x12;
    let mut static_source_port = readiness_probe();
    static_source_port[20..22].copy_from_slice(&40_000_u16.to_be_bytes());
    vec![wrong_port, acknowledged, static_source_port]
}

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
