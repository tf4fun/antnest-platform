use std::{future::Future, time::Duration};

use tokio::task::JoinSet;
use tokio::time::Instant;

use crate::{
    application::{ControlService, KernelCleanup},
    repository::Repository,
};

fn join_failure(joined: Result<Result<(), String>, tokio::task::JoinError>) -> String {
    match joined {
        Ok(Ok(())) => "component exited cleanly".to_owned(),
        Ok(Err(error)) => error,
        Err(error) => error.to_string(),
    }
}

fn join_or_empty(joined: Option<Result<Result<(), String>, tokio::task::JoinError>>) -> String {
    match joined {
        None => "supervised task set was empty".to_owned(),
        Some(joined) => join_failure(joined),
    }
}

pub async fn supervise(
    tasks: &mut JoinSet<Result<(), String>>,
    deadline: Instant,
) -> Option<String> {
    tokio::select! {
        biased;
        result = tasks.join_next() => Some(join_or_empty(result)),
        _ = tokio::time::sleep_until(deadline) => None,
    }
}

async fn run_with_begin(
    tasks: &mut JoinSet<Result<(), String>>,
    timeout: Duration,
    begin: impl Future<Output = ()>,
) -> Option<String> {
    let deadline = Instant::now() + timeout;
    tokio::pin!(begin);
    tokio::select! {
        biased;
        result = tasks.join_next() => return Some(join_or_empty(result)),
        _ = &mut begin => {},
        _ = tokio::time::sleep_until(deadline) => return None,
    }
    supervise(tasks, deadline).await
}

pub async fn run<R, K>(
    service: &ControlService<R, K>,
    tasks: &mut JoinSet<Result<(), String>>,
    timeout: Duration,
) -> Option<String>
where
    R: Repository,
    K: KernelCleanup,
{
    run_with_begin(tasks, timeout, service.begin_drain(timeout)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tunnel::PreparedKey;
    use crate::{
        config::Config,
        dataplane::{AgentRoute, DataPlaneAction, DataPlaneEngine, NetworkSnapshot, RouteGate},
        domain::AgentId,
        flow::{ClaimResult, FlowTable},
        packet::parse_ipv4_tcp,
        policy::PolicySpec,
    };
    use antnest_runtime_tunnel::{Event, KeyId, Peer, parse_egress_restart};
    use std::{
        collections::HashMap,
        net::{Ipv4Addr, SocketAddr},
        sync::{
            Arc,
            atomic::{AtomicUsize, Ordering},
        },
        time::{Duration, Instant},
    };
    use tokio::task::JoinSet;

    const SYN_OPEN: &str =
        "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000";
    const SYN_PROBE: &str =
        "4500002800004000400600006460000ac0000201c001000900000000000000005002000000000000";
    const TUNNEL: Ipv4Addr = Ipv4Addr::new(100, 96, 0, 10);

    fn packet(hex: &str) -> Vec<u8> {
        hex.as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
            .collect()
    }

    fn reverse(packet: &[u8]) -> Vec<u8> {
        let mut reply = packet.to_vec();
        reply[12..16].copy_from_slice(&packet[16..20]);
        reply[16..20].copy_from_slice(&packet[12..16]);
        reply[20..22].copy_from_slice(&packet[22..24]);
        reply[22..24].copy_from_slice(&packet[20..22]);
        reply
    }

    fn values() -> HashMap<String, String> {
        HashMap::from([
            (
                "ANTNEST_EGRESS_DATABASE_URL".into(),
                "postgres://egress:secret@postgres/egress".into(),
            ),
            (
                "ANTNEST_EGRESS_UDP_ADVERTISE".into(),
                "10.20.0.8:8092".into(),
            ),
            ("ANTNEST_EGRESS_DNS_UPSTREAM".into(), "10.20.0.53:53".into()),
            (
                "ANTNEST_EGRESS_PLATFORM_DENY_CIDRS".into(),
                "100.64.0.0/10".into(),
            ),
            ("ANTNEST_ALLOW_PUBLIC_DEV_SECRETS".into(), "true".into()),
        ])
    }

    fn route(gate: RouteGate) -> AgentRoute {
        AgentRoute {
            agent_id: AgentId::parse("agent-1").unwrap(),
            tunnel_ipv4: TUNNEL,
            assignment_version: 1,
            policy: PolicySpec::allow_all().compile(Ipv4Addr::new(100, 64, 0, 1)),
            gate,
            runtime_endpoint: Some(Ipv4Addr::LOCALHOST),
        }
    }

    fn engine(gate: RouteGate) -> DataPlaneEngine {
        DataPlaneEngine::new(
            NetworkSnapshot::from_routes([route(gate)]),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )
    }

    fn peer() -> SocketAddr {
        SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 45_000)
    }

    #[test]
    fn drain_timeout_config_defaults_and_bounds() {
        assert_eq!(
            Config::from_values(values()).unwrap().drain_timeout,
            Duration::from_secs(30)
        );
        for input in ["1ms", "120s"] {
            let mut given = values();
            given.insert("ANTNEST_EGRESS_DRAIN_TIMEOUT".into(), input.into());
            assert!(Config::from_values(given).is_ok(), "{input}");
        }
        for input in ["0s", "0ms", "121s", "bogus"] {
            let mut given = values();
            given.insert("ANTNEST_EGRESS_DRAIN_TIMEOUT".into(), input.into());
            assert!(Config::from_values(given).is_err(), "{input}");
        }
    }

    #[test]
    fn drain_claim_existing_never_inserts() {
        let mut table = FlowTable::new(4, 4, Duration::from_secs(60));
        let now = Instant::now();
        let agent = AgentId::parse("agent-1").unwrap();
        let key = parse_ipv4_tcp(&packet(SYN_OPEN), 1400).unwrap().flow_key();
        let other_key = crate::packet::FlowKey::tcp(
            key.source,
            key.source_port + 1,
            key.destination,
            key.destination_port,
        );
        assert_eq!(
            table.claim(agent.clone(), key, peer(), 1, now),
            ClaimResult::Created
        );
        assert_eq!(
            table.claim_existing(agent.clone(), key, peer(), 1, now),
            ClaimResult::Existing
        );
        assert_eq!(
            table.claim_existing(agent.clone(), other_key, peer(), 1, now),
            ClaimResult::AdmissionDenied
        );
        assert_eq!(table.len(), 1);
    }

    #[test]
    fn drain_serves_existing_refuses_new_and_expires() {
        let mut engine = engine(RouteGate::Open);
        let now = Instant::now();
        let bytes = packet(SYN_OPEN);
        assert!(matches!(
            engine.handle_uplink(&bytes, peer(), now),
            DataPlaneAction::WriteTun(_)
        ));
        engine.begin_drain(now, Duration::from_secs(30));
        assert!(engine.is_draining());
        assert!(matches!(
            engine.handle_uplink(&bytes, peer(), now + Duration::from_secs(1)),
            DataPlaneAction::WriteTun(_)
        ));
        assert!(matches!(
            engine.handle_downlink(&reverse(&bytes), now + Duration::from_secs(1)),
            DataPlaneAction::SendUdp { .. }
        ));
        let mut fresh = bytes.clone();
        fresh[21] = 0x7f;
        match engine.handle_uplink(&fresh, peer(), now + Duration::from_secs(1)) {
            DataPlaneAction::SendUdp { packet, .. } => assert_eq!(packet[33] & 0x04, 0x04),
            other => panic!("new flow admitted during drain: {other:?}"),
        }
        engine.replace_snapshot(NetworkSnapshot::from_routes([route(RouteGate::Open)]));
        assert!(engine.is_draining());
        engine.begin_drain(now + Duration::from_secs(20), Duration::from_secs(30));
        assert!(
            engine.drain_remaining(now + Duration::from_secs(20)) <= Some(Duration::from_secs(10)),
            "later begin_drain extended the earliest deadline"
        );
        assert!(matches!(
            engine.handle_uplink(&bytes, peer(), now + Duration::from_secs(31)),
            DataPlaneAction::Drop(_)
        ));
        assert!(matches!(
            engine.handle_downlink(&reverse(&bytes), now + Duration::from_secs(31)),
            DataPlaneAction::Drop(_)
        ));
    }

    #[test]
    fn drain_readiness_probe_gets_restart_notice_while_draining() {
        let mut engine = engine(RouteGate::ProbeOnly);
        let now = Instant::now();
        engine.begin_drain(now, Duration::from_secs(30));
        match engine.handle_uplink(&packet(SYN_PROBE), peer(), now + Duration::from_secs(1)) {
            DataPlaneAction::SendUdp { packet, .. } => {
                let millis = parse_egress_restart(&packet, TUNNEL).expect("valid notice");
                assert!(millis > 0 && millis <= 30_000);
            }
            other => panic!("no restart notice while draining: {other:?}"),
        }
    }

    #[test]
    fn drain_readiness_probe_gets_plain_reset_when_not_draining() {
        let mut engine = engine(RouteGate::ProbeOnly);
        match engine.handle_uplink(&packet(SYN_PROBE), peer(), Instant::now()) {
            DataPlaneAction::SendUdp { packet, .. } => {
                assert!(parse_egress_restart(&packet, TUNNEL).is_err());
                assert_eq!(packet[33] & 0x04, 0x04);
            }
            other => panic!("no readiness reset: {other:?}"),
        }
    }

    #[test]
    fn drain_fenced_and_unknown_agents_get_no_notice() {
        let mut engine = engine(RouteGate::HardFenced);
        let now = Instant::now();
        engine.begin_drain(now, Duration::from_secs(30));
        assert!(matches!(
            engine.handle_uplink(&packet(SYN_PROBE), peer(), now),
            DataPlaneAction::Drop(_)
        ));
        let mut empty = DataPlaneEngine::new(
            NetworkSnapshot::default(),
            1400,
            32,
            16,
            Duration::from_secs(60),
        );
        empty.begin_drain(now, Duration::from_secs(30));
        assert!(matches!(
            empty.handle_uplink(&packet(SYN_PROBE), peer(), now),
            DataPlaneAction::Drop(_)
        ));
        assert!(empty.tunnel_tick().is_empty());
    }

    #[tokio::test]
    async fn drain_supervise_returns_task_failure_before_deadline() {
        let mut tasks: JoinSet<Result<(), String>> = JoinSet::new();
        tasks.spawn(async { Err("packet died".to_string()) });
        let failure = supervise(
            &mut tasks,
            tokio::time::Instant::now() + Duration::from_secs(30),
        )
        .await;
        assert_eq!(failure.as_deref(), Some("packet died"));
    }

    fn install_agent(
        engine: &mut DataPlaneEngine,
        agent: &str,
        tunnel_ipv4: Ipv4Addr,
        seed: u8,
    ) -> (KeyId, Peer) {
        let agent_id = AgentId::parse(agent).unwrap();
        let mut raw = [0_u8; 16];
        raw[15] = seed;
        let key_id = KeyId::from_bytes(raw);
        let egress = Peer::new(
            key_id,
            [seed; 32],
            Peer::public_key([seed.wrapping_add(1); 32]),
            [53; 32],
        );
        let runtime = Peer::new(
            key_id,
            [seed.wrapping_add(1); 32],
            Peer::public_key([seed; 32]),
            [53; 32],
        );
        engine.replace_agent_tunnels(
            &agent_id,
            vec![(
                PreparedKey {
                    agent_id: agent_id.clone(),
                    key_id,
                    runtime_revision: "rtv_test".to_owned(),
                    tunnel_ipv4,
                    nonce: Vec::new(),
                    sealed: Vec::new(),
                },
                egress,
            )],
        );
        engine.select_tunnel_key(agent_id, Some(key_id));
        (key_id, runtime)
    }

    fn route_for(agent: &str, tunnel_ipv4: Ipv4Addr, gate: RouteGate) -> AgentRoute {
        AgentRoute {
            agent_id: AgentId::parse(agent).unwrap(),
            tunnel_ipv4,
            assignment_version: 1,
            policy: PolicySpec::allow_all().compile(Ipv4Addr::new(100, 64, 0, 1)),
            gate,
            runtime_endpoint: Some(Ipv4Addr::LOCALHOST),
        }
    }

    fn wire_roundtrip(
        engine: &mut DataPlaneEngine,
        runtime: &mut Peer,
        packet: &[u8],
        now: Instant,
    ) {
        for event in runtime.send(packet).unwrap() {
            let Event::Network(frame) = event else {
                continue;
            };
            for action in engine.handle_wire_uplink(&frame, peer(), now) {
                let bytes = match action {
                    DataPlaneAction::SendUdp { packet, .. }
                    | DataPlaneAction::SendHandshake { packet, .. } => packet,
                    _ => continue,
                };
                if let Ok(events) = runtime.receive(&bytes, Ipv4Addr::LOCALHOST.into()) {
                    for event in events {
                        if let Event::Network(reply) = event {
                            engine.handle_wire_uplink(&reply, peer(), now);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn drain_tick_notifies_all_eligible_peers_once_per_second() {
        let now = Instant::now();
        let t2 = Ipv4Addr::new(100, 96, 0, 11);
        let t3 = Ipv4Addr::new(100, 96, 0, 12);
        let mut engine = DataPlaneEngine::new(
            NetworkSnapshot::from_routes([
                route_for("agent-1", TUNNEL, RouteGate::Open),
                route_for("agent-2", t2, RouteGate::Open),
                route_for("agent-3", t3, RouteGate::HardFenced),
                route_for("agent-4", Ipv4Addr::new(100, 96, 0, 13), RouteGate::Open),
            ]),
            1400,
            32,
            16,
            Duration::from_secs(60),
        );
        let (id1, mut runtime1) = install_agent(&mut engine, "agent-1", TUNNEL, 29);
        let (id2, mut runtime2) = install_agent(&mut engine, "agent-2", t2, 31);
        let (id3, _runtime3) = install_agent(&mut engine, "agent-3", t3, 33);
        let (id4, _runtime4) =
            install_agent(&mut engine, "agent-4", Ipv4Addr::new(100, 96, 0, 13), 35);
        engine.test_bind_remote(id3, peer());
        engine.test_bind_remote(id4, SocketAddr::new(Ipv4Addr::new(10, 9, 9, 9).into(), 9));
        let mut syn2 = packet(SYN_OPEN);
        syn2[12..16].copy_from_slice(&t2.octets());
        wire_roundtrip(&mut engine, &mut runtime1, &packet(SYN_OPEN), now);
        wire_roundtrip(&mut engine, &mut runtime2, &syn2, now);
        engine.begin_drain(now, Duration::from_secs(30));

        let output = engine.tunnel_tick_at(now + Duration::from_secs(1));
        let mut seen = Vec::new();
        for action in &output {
            let DataPlaneAction::SendUdp {
                agent_id, packet, ..
            } = action
            else {
                continue;
            };
            let (peer_ref, ip) = if agent_id.as_str() == "agent-1" {
                (&mut runtime1, TUNNEL)
            } else {
                (&mut runtime2, t2)
            };
            for event in peer_ref
                .receive(packet, Ipv4Addr::LOCALHOST.into())
                .unwrap_or_default()
            {
                if let Event::Ipv4(inner) = event
                    && let Ok(millis) = parse_egress_restart(&inner, ip)
                {
                    seen.push(millis);
                }
            }
        }
        assert_eq!(
            seen.len(),
            2,
            "every eligible peer gets a notice: {output:?}"
        );
        assert!(seen.iter().all(|m| *m > 0 && *m <= 30_000), "{seen:?}");

        let output = engine.tunnel_tick_at(now + Duration::from_secs(1));
        assert!(
            !output
                .iter()
                .any(|a| matches!(a, DataPlaneAction::SendUdp { .. })),
            "throttle emitted inside one second: {output:?}"
        );

        let output = engine.tunnel_tick_at(now + Duration::from_secs(2));
        let mut seen = Vec::new();
        for action in &output {
            let DataPlaneAction::SendUdp {
                agent_id, packet, ..
            } = action
            else {
                continue;
            };
            let (peer_ref, ip) = if agent_id.as_str() == "agent-1" {
                (&mut runtime1, TUNNEL)
            } else {
                (&mut runtime2, t2)
            };
            for event in peer_ref
                .receive(packet, Ipv4Addr::LOCALHOST.into())
                .unwrap_or_default()
            {
                if let Event::Ipv4(inner) = event
                    && let Ok(millis) = parse_egress_restart(&inner, ip)
                {
                    seen.push(millis);
                }
            }
        }
        assert_eq!(seen.len(), 2, "next second batch: {output:?}");
        let _ = (id1, id2);
    }

    #[test]
    fn drain_still_enforces_policy_fence_version_and_idle() {
        let now = Instant::now();
        let mut revoked = engine(RouteGate::Open);
        let bytes = packet(SYN_OPEN);
        assert!(matches!(
            revoked.handle_uplink(&bytes, peer(), now),
            DataPlaneAction::WriteTun(_)
        ));
        revoked.begin_drain(now, Duration::from_secs(120));
        let mut denied = route(RouteGate::Open);
        denied.policy = PolicySpec::deny_all().compile(Ipv4Addr::new(100, 64, 0, 1));
        revoked.replace_snapshot(NetworkSnapshot::from_routes([denied]));
        assert!(!matches!(
            revoked.handle_uplink(&bytes, peer(), now + Duration::from_secs(1)),
            DataPlaneAction::WriteTun(_)
        ));
        let mut fenced = engine(RouteGate::Open);
        assert!(matches!(
            fenced.handle_uplink(&bytes, peer(), now),
            DataPlaneAction::WriteTun(_)
        ));
        fenced.begin_drain(now, Duration::from_secs(120));
        fenced.fence_agent(AgentId::parse("agent-1").unwrap());
        assert!(matches!(
            fenced.handle_uplink(&bytes, peer(), now + Duration::from_secs(1)),
            DataPlaneAction::Drop(_)
        ));
        fenced.reopen_agent(&AgentId::parse("agent-1").unwrap());
        let mut bumped = route(RouteGate::Open);
        bumped.assignment_version = 2;
        fenced.replace_snapshot(NetworkSnapshot::from_routes([bumped]));
        assert!(!matches!(
            fenced.handle_uplink(&bytes, peer(), now + Duration::from_secs(1)),
            DataPlaneAction::WriteTun(_)
        ));
        let mut idle = DataPlaneEngine::new(
            NetworkSnapshot::from_routes([route(RouteGate::Open)]),
            1400,
            32,
            16,
            Duration::from_secs(5),
        );
        assert!(matches!(
            idle.handle_uplink(&bytes, peer(), now),
            DataPlaneAction::WriteTun(_)
        ));
        idle.begin_drain(now, Duration::from_secs(120));
        assert!(!matches!(
            idle.handle_uplink(&bytes, peer(), now + Duration::from_secs(6)),
            DataPlaneAction::WriteTun(_)
        ));
    }

    #[test]
    fn drain_forged_or_replayed_datagrams_grant_no_notice_or_flow() {
        let now = Instant::now();
        let mut engine = engine(RouteGate::Open);
        let (id, mut runtime) = install_agent(&mut engine, "agent-1", TUNNEL, 29);
        engine.test_bind_remote(id, peer());
        engine.begin_drain(now, Duration::from_secs(30));
        for action in engine.handle_wire_uplink(&[0xaa; 64], peer(), now) {
            assert!(matches!(action, DataPlaneAction::Drop(_)), "{action:?}");
        }
        let frame = runtime
            .send(&packet(SYN_PROBE))
            .unwrap()
            .into_iter()
            .find_map(|event| match event {
                Event::Network(frame) => Some(frame),
                _ => None,
            })
            .expect("runtime datagram");
        engine.handle_wire_uplink(&frame, peer(), now);
        for action in engine.handle_wire_uplink(&frame, peer(), now + Duration::from_millis(5)) {
            assert!(
                matches!(
                    action,
                    DataPlaneAction::Drop(_) | DataPlaneAction::SendHandshake { .. }
                ),
                "replayed datagram granted output: {action:?}"
            );
        }
    }

    #[tokio::test]
    async fn drain_run_with_begin_reports_task_failure_during_pending_begin() {
        let mut tasks: JoinSet<Result<(), String>> = JoinSet::new();
        tasks.spawn(async { Err("packet died".to_string()) });
        let failure = run_with_begin(
            &mut tasks,
            Duration::from_secs(30),
            std::future::pending::<()>(),
        )
        .await;
        assert_eq!(failure.as_deref(), Some("packet died"));
    }

    #[tokio::test]
    async fn drain_supervise_empty_task_set_is_an_error() {
        let mut tasks: JoinSet<Result<(), String>> = JoinSet::new();
        let failure = supervise(
            &mut tasks,
            tokio::time::Instant::now() + Duration::from_secs(30),
        )
        .await;
        assert!(failure.is_some(), "empty task set must report a failure");
    }

    #[tokio::test]
    async fn drain_begin_wait_stays_bounded_by_absolute_deadline() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut tasks: JoinSet<Result<(), String>> = JoinSet::new();
        let ticks = counter.clone();
        tasks.spawn(async move {
            loop {
                ticks.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        assert!(
            run_with_begin(
                &mut tasks,
                Duration::from_millis(60),
                std::future::pending::<()>()
            )
            .await
            .is_none()
        );
        assert!(counter.load(Ordering::Relaxed) > 1);
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }

    #[tokio::test]
    async fn drain_supervise_awaits_deadline_without_cancelling_tasks() {
        let counter = Arc::new(AtomicUsize::new(0));
        let mut tasks: JoinSet<Result<(), String>> = JoinSet::new();
        let ticks = counter.clone();
        tasks.spawn(async move {
            loop {
                ticks.fetch_add(1, Ordering::Relaxed);
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        });
        let deadline = tokio::time::Instant::now() + Duration::from_millis(60);
        assert!(supervise(&mut tasks, deadline).await.is_none());
        assert!(counter.load(Ordering::Relaxed) > 1);
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
}
