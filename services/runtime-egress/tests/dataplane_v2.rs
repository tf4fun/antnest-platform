use std::{
    net::{Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};

use antnest_runtime_egress::{
    dataplane::{AgentRoute, DataPlaneAction, DataPlaneEngine, NetworkSnapshot, RouteGate},
    domain::AgentId,
    policy::PolicySpec,
};

const RESOLVER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);
const TUNNEL: Ipv4Addr = Ipv4Addr::new(100, 96, 0, 10);
const PEER: Ipv4Addr = Ipv4Addr::new(10, 0, 0, 2);

fn tcp_packet(source: Ipv4Addr, destination: Ipv4Addr, sport: u16, dport: u16) -> Vec<u8> {
    let mut packet = vec![0x45, 0, 0, 40, 0, 0, 0x40, 0, 64, 6, 0, 0];
    packet.extend_from_slice(&source.octets());
    packet.extend_from_slice(&destination.octets());
    packet.extend_from_slice(&sport.to_be_bytes());
    packet.extend_from_slice(&dport.to_be_bytes());
    packet.extend_from_slice(&[0; 8]);
    packet.extend_from_slice(&[0x50, 0x02, 0, 0]);
    packet.extend_from_slice(&[0; 4]);
    packet
}

fn uplink(destination: Ipv4Addr, port: u16) -> Vec<u8> {
    tcp_packet(TUNNEL, destination, 40_000, port)
}

fn reply(remote: Ipv4Addr, remote_port: u16) -> Vec<u8> {
    tcp_packet(remote, TUNNEL, remote_port, 40_000)
}

fn denied(action: &DataPlaneAction) -> bool {
    !matches!(action, DataPlaneAction::WriteTun(_))
}

fn route(policy: PolicySpec, version: u64) -> AgentRoute {
    AgentRoute {
        agent_id: AgentId::parse("agent-1").unwrap(),
        tunnel_ipv4: TUNNEL,
        assignment_version: version,
        policy: policy.compile(RESOLVER),
        gate: RouteGate::Open,
        runtime_endpoint: Some(PEER),
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

fn peer() -> SocketAddr {
    SocketAddr::new(PEER.into(), 41_000)
}

fn v2(spec: &str) -> PolicySpec {
    serde_json::from_str(spec).unwrap()
}

#[test]
fn platform_deny_beats_broad_rfc1918_allow_in_both_directions() {
    let mut engine = engine(v2(
        r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["172.16.0.0/12"]}]}"#,
    ));
    engine.set_platform_deny(vec!["172.30.255.0/24".parse().unwrap()]);
    let now = Instant::now();
    let action = engine.handle_uplink(&uplink("172.30.255.5".parse().unwrap(), 443), peer(), now);
    assert!(denied(&action), "{action:?}");
    let action = engine.handle_downlink(&reply("172.30.255.5".parse().unwrap(), 443), now);
    assert!(matches!(action, DataPlaneAction::Drop(_)), "{action:?}");
    let action = engine.handle_uplink(&uplink("172.18.9.9".parse().unwrap(), 443), peer(), now);
    assert!(matches!(action, DataPlaneAction::WriteTun(_)), "{action:?}");
    let action = engine.handle_downlink(&reply("172.18.9.9".parse().unwrap(), 443), now);
    assert!(
        matches!(action, DataPlaneAction::SendUdp { .. }),
        "{action:?}"
    );
}

#[test]
fn dns_binding_grants_only_bound_rule_and_expires_on_both_directions() {
    let mut engine = engine(v2(
        r#"{"schema_version":2,"default":"deny","rules":[{"action":"deny","ports":[25]},{"action":"allow","domains":["api.github.com"],"ports":[443]}]}"#,
    ));
    let now = Instant::now();
    let context = engine.dns_context(TUNNEL).expect("open route context");
    assert_eq!(
        engine.bind_dns_answers(
            &context,
            "api.github.com",
            &["140.82.112.6".parse().unwrap()],
            Duration::from_secs(60),
            now,
        ),
        1
    );
    let action = engine.handle_uplink(&uplink("140.82.112.6".parse().unwrap(), 443), peer(), now);
    assert!(matches!(action, DataPlaneAction::WriteTun(_)), "{action:?}");
    let action = engine.handle_downlink(&reply("140.82.112.6".parse().unwrap(), 443), now);
    assert!(
        matches!(action, DataPlaneAction::SendUdp { .. }),
        "{action:?}"
    );
    let action = engine.handle_uplink(&uplink("140.82.112.6".parse().unwrap(), 25), peer(), now);
    assert!(denied(&action), "{action:?}");
    let action = engine.handle_uplink(&uplink("140.82.112.7".parse().unwrap(), 443), peer(), now);
    assert!(denied(&action), "{action:?}");
    let expired = now + Duration::from_secs(61);
    let action = engine.handle_downlink(&reply("140.82.112.6".parse().unwrap(), 443), expired);
    assert!(matches!(action, DataPlaneAction::Drop(_)), "{action:?}");
    let action = engine.handle_uplink(
        &uplink("140.82.112.6".parse().unwrap(), 443),
        peer(),
        expired,
    );
    assert!(denied(&action), "{action:?}");
}

#[test]
fn dns_context_stale_after_reset_fence_reopen_and_route_changes() {
    let policy = || {
        v2(
            r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"]}]}"#,
        )
    };
    let mut engine = engine(policy());
    let now = Instant::now();
    let address: Ipv4Addr = "140.82.112.6".parse().unwrap();
    let bind = |engine: &mut DataPlaneEngine,
                context: &antnest_runtime_egress::dataplane::DnsContext| {
        engine.bind_dns_answers(
            context,
            "api.github.com",
            &[address],
            Duration::from_secs(60),
            now,
        )
    };
    let agent = AgentId::parse("agent-1").unwrap();
    let stale = engine.dns_context(TUNNEL).unwrap();
    engine.reset_agent_flows(&agent);
    assert_eq!(bind(&mut engine, &stale), 0);
    let stale = engine.dns_context(TUNNEL).unwrap();
    engine.fence_agent(agent.clone());
    engine.reopen_agent(&agent);
    assert_eq!(bind(&mut engine, &stale), 0);
    let stale = engine.dns_context(TUNNEL).unwrap();
    let mut changed = route(policy(), 1);
    changed.runtime_endpoint = Some("10.0.0.9".parse().unwrap());
    engine.upsert_route(changed);
    assert_eq!(bind(&mut engine, &stale), 0);
    let stale = engine.dns_context(TUNNEL).unwrap();
    engine.remove_agent(&agent);
    engine.upsert_route(route(policy(), 1));
    assert_eq!(bind(&mut engine, &stale), 0);
    let fresh = engine.dns_context(TUNNEL).unwrap();
    assert_eq!(bind(&mut engine, &fresh), 1);
    let action = engine.handle_uplink(&uplink(address, 443), peer(), now);
    assert!(matches!(action, DataPlaneAction::WriteTun(_)), "{action:?}");
}

#[test]
fn binding_capacity_counts_rule_ip_pairs_and_refreshes_in_place() {
    let spec = format!(
        r#"{{"schema_version":2,"default":"deny","rules":[{}]}}"#,
        (0..64)
            .map(|index| format!(r#"{{"action":"allow","domains":["d{index}.example.com"]}}"#))
            .collect::<Vec<_>>()
            .join(",")
    );
    let mut engine = engine(v2(&spec));
    let now = Instant::now();
    for index in 0..63 {
        let name = format!("d{index}.example.com");
        let addresses: Vec<Ipv4Addr> = (0..64)
            .map(|offset| Ipv4Addr::new(151, 101, index as u8, offset as u8))
            .collect();
        let context = engine.dns_context(TUNNEL).unwrap();
        for _ in 0..2 {
            assert_eq!(
                engine.bind_dns_answers(&context, &name, &addresses, Duration::from_secs(60), now,),
                64
            );
        }
    }
    let context = engine.dns_context(TUNNEL).unwrap();
    assert_eq!(
        engine.bind_dns_answers(
            &context,
            "d63.example.com",
            &(0..64_u8)
                .map(|offset| Ipv4Addr::new(151, 101, 63, offset))
                .collect::<Vec<_>>(),
            Duration::from_secs(60),
            now,
        ),
        64
    );
    let overflow = engine.bind_dns_answers(
        &context,
        "d63.example.com",
        &["8.8.8.8".parse().unwrap()],
        Duration::from_secs(60),
        now,
    );
    assert_eq!(overflow, 0, "4096 pair capacity is fail-closed");
    let probe = uplink("151.101.0.1".parse().unwrap(), 80);
    let action = engine.handle_uplink(&probe, peer(), now);
    assert!(matches!(action, DataPlaneAction::WriteTun(_)), "{action:?}");
}

#[test]
fn unbound_sources_wrong_names_and_ungrantable_answers_bind_nothing() {
    let mut engine = engine(v2(
        r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"]}]}"#,
    ));
    let now = Instant::now();
    assert!(engine.dns_context("100.96.0.99".parse().unwrap()).is_none());
    let context = engine.dns_context(TUNNEL).unwrap();
    assert_eq!(
        engine.bind_dns_answers(
            &context,
            "example.com",
            &["93.184.216.34".parse().unwrap()],
            Duration::from_secs(60),
            now,
        ),
        0
    );
    assert_eq!(
        engine.bind_dns_answers(
            &context,
            "api.github.com",
            &["93.184.216.34".parse().unwrap()],
            Duration::ZERO,
            now,
        ),
        0
    );
    assert_eq!(
        engine.bind_dns_answers(
            &context,
            "api.github.com",
            &["169.254.1.1".parse().unwrap()],
            Duration::from_secs(60),
            now,
        ),
        0
    );
    let action = engine.handle_uplink(&uplink("93.184.216.34".parse().unwrap(), 443), peer(), now);
    assert!(denied(&action), "{action:?}");
}

#[test]
fn identical_route_upserts_do_not_invalidate_dns_responses() {
    let policy = || {
        v2(
            r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["api.github.com"]}]}"#,
        )
    };
    let mut engine = engine(policy());
    let now = Instant::now();
    let context = engine.dns_context(TUNNEL).unwrap();
    engine.upsert_route(route(policy(), 1));
    assert_eq!(
        engine.bind_dns_answers(
            &context,
            "api.github.com",
            &["140.82.112.6".parse().unwrap()],
            Duration::from_secs(60),
            now,
        ),
        1
    );
    let second = engine.dns_context(TUNNEL).unwrap();
    engine.replace_snapshot(NetworkSnapshot::from_routes([route(policy(), 1)]));
    assert_eq!(
        engine.bind_dns_answers(
            &second,
            "api.github.com",
            &["140.82.112.7".parse().unwrap()],
            Duration::from_secs(60),
            now,
        ),
        1
    );
}
