use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use antnest_runtime_egress::{
    dataplane::{AgentRoute, DataPlaneAction, DataPlaneEngine, DropReason, NetworkSnapshot},
    domain::AgentId,
    policy::PolicySpec,
};

const SYN: &str =
    "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000";

fn route(policy: PolicySpec, version: u64) -> AgentRoute {
    AgentRoute {
        agent_id: AgentId::parse("agent-1").unwrap(),
        tunnel_ipv4: "100.96.0.10".parse().unwrap(),
        assignment_version: version,
        policy: policy.compile(),
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
        DataPlaneAction::Drop(DropReason::FlowCollision)
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
    assert_eq!(
        engine.handle_uplink(&first, peer, Instant::now()),
        DataPlaneAction::WriteTun(first)
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

fn decode_hex(value: &str) -> Vec<u8> {
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}
