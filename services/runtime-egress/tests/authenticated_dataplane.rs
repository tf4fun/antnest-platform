mod support;
use antnest_runtime_egress::{
    dataplane::{AgentRoute, DataPlaneAction, DataPlaneEngine, NetworkSnapshot, RouteGate},
    domain::AgentId,
    policy::PolicySpec,
};
use antnest_runtime_tunnel::{Event, Peer};
use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

fn packet(source: [u8; 4]) -> Vec<u8> {
    let mut p = vec![0; 40];
    p[0] = 0x45;
    p[2..4].copy_from_slice(&40u16.to_be_bytes());
    p[8] = 64;
    p[9] = 6;
    p[12..16].copy_from_slice(&source);
    p[16..20].copy_from_slice(&[9, 9, 9, 9]);
    p[20..22].copy_from_slice(&41000u16.to_be_bytes());
    p[22..24].copy_from_slice(&443u16.to_be_bytes());
    p[32] = 0x50;
    p[33] = 2;
    p
}
fn network(events: Vec<Event>) -> Vec<Vec<u8>> {
    events
        .into_iter()
        .filter_map(|e| {
            if let Event::Network(p) = e {
                Some(p)
            } else {
                None
            }
        })
        .collect()
}
const REMOTE: &str = "10.243.0.2:41000";
fn engine() -> (DataPlaneEngine, Peer) {
    let agent = AgentId::parse("agent_crypto").unwrap();
    let ip = "100.64.0.2".parse().unwrap();
    let route = AgentRoute {
        agent_id: agent.clone(),
        tunnel_ipv4: ip,
        assignment_version: 1,
        policy: PolicySpec::allow_all().compile("100.64.0.1".parse().unwrap()),
        gate: RouteGate::Open,
        runtime_endpoint: Some("10.243.0.2".parse().unwrap()),
    };
    let mut e = DataPlaneEngine::new(
        NetworkSnapshot::from_routes([route]),
        1400,
        32,
        16,
        Duration::from_secs(60),
    );
    let row = support::auth::key_box()
        .seal(
            agent.clone(),
            &support::auth::tunnel_registration(agent.as_str(), ip),
        )
        .unwrap();
    let peer = support::auth::key_box()
        .open(&row)
        .unwrap()
        .peer(row.key_id);
    e.replace_agent_tunnels(&agent, vec![(row, peer)]);
    e.select_tunnel_key(agent.clone(), Some(support::auth::key_id(agent.as_str())));
    (e, support::auth::runtime_peer(agent.as_str()))
}
fn establish(e: &mut DataPlaneEngine, r: &mut Peer) -> Vec<u8> {
    let remote: SocketAddr = REMOTE.parse().unwrap();
    let init = network(r.send(&packet([100, 64, 0, 2])).unwrap())
        .pop()
        .unwrap();
    let response = e
        .handle_wire_uplink(&init, remote, Instant::now())
        .into_iter()
        .find_map(|a| {
            if let DataPlaneAction::SendHandshake { packet, .. } = a {
                Some(packet)
            } else {
                None
            }
        })
        .unwrap();
    let frames = network(r.receive(&response, "10.243.0.1".parse().unwrap()).unwrap());
    let mut data = Vec::new();
    for frame in frames {
        let actions = e.handle_wire_uplink(&frame, remote, Instant::now());
        if actions
            .iter()
            .any(|a| matches!(a, DataPlaneAction::WriteTun(_)))
        {
            data = frame;
        }
    }
    assert!(!data.is_empty());
    data
}
#[test]
fn rejected_crypto_never_reaches_policy_flow_or_plaintext_output() {
    let (mut e, mut r) = engine();
    let remote = REMOTE.parse().unwrap();
    e.handle_wire_uplink(&packet([100, 64, 0, 2]), remote, Instant::now());
    assert_eq!(e.metrics().policy_allows, 0);
    assert_eq!(e.flow_count(), 0);
    let accepted = establish(&mut e, &mut r);
    let before = e.metrics().policy_allows;
    e.handle_wire_uplink(&accepted, remote, Instant::now());
    assert_eq!(e.metrics().policy_allows, before);
    assert_eq!(e.metrics().replay_drops, 1);
    let valid = network(r.send(&packet([100, 64, 0, 2])).unwrap())
        .pop()
        .unwrap();
    let mut altered = valid.clone();
    *altered.last_mut().unwrap() ^= 1;
    e.handle_wire_uplink(&altered, remote, Instant::now());
    assert_eq!(e.metrics().policy_allows, before);
    assert!(
        e.handle_wire_uplink(&valid, remote, Instant::now())
            .iter()
            .any(|a| matches!(a, DataPlaneAction::WriteTun(_)))
    );
    let forged = network(r.send(&packet([100, 64, 0, 3])).unwrap())
        .pop()
        .unwrap();
    let before = e.metrics().policy_allows;
    e.handle_wire_uplink(&forged, remote, Instant::now());
    assert_eq!(e.metrics().policy_allows, before);
    let (mut restarted, _) = engine();
    restarted.handle_wire_uplink(&accepted, remote, Instant::now());
    assert_eq!(restarted.metrics().policy_allows, 0);
    assert_eq!(restarted.flow_count(), 0);
    e.remove_agent_tunnels(&AgentId::parse("agent_crypto").unwrap());
    let before = e.metrics().policy_allows;
    e.handle_wire_uplink(&valid, remote, Instant::now());
    assert_eq!(e.metrics().policy_allows, before);
}
