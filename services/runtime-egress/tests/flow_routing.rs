use std::{
    net::SocketAddr,
    time::{Duration, Instant},
};

use antnest_runtime_egress::{
    domain::AgentId,
    flow::{ClaimResult, FlowTable},
    packet::FlowKey,
};

fn flow(source_port: u16) -> FlowKey {
    FlowKey::tcp(
        "100.64.0.2".parse().unwrap(),
        source_port,
        "93.184.216.34".parse().unwrap(),
        443,
    )
}

#[test]
fn first_peer_owns_a_flow_until_it_is_removed() {
    let mut table = FlowTable::new(16, 8, Duration::from_secs(60));
    let agent = AgentId::parse("agent-1").unwrap();
    let first: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let second: SocketAddr = "10.0.0.3:42000".parse().unwrap();
    let now = Instant::now();

    assert_eq!(
        table.claim(agent.clone(), flow(40_000), first, 3, now),
        ClaimResult::Created
    );
    assert_eq!(
        table.claim(agent, flow(40_000), second, 3, now),
        ClaimResult::Collision
    );
    assert_eq!(
        table.peer_for_reply(&flow(40_000).reverse(), 3, now),
        Some(first)
    );
}

#[test]
fn assignment_version_fences_stale_return_traffic() {
    let mut table = FlowTable::new(16, 8, Duration::from_secs(60));
    let agent = AgentId::parse("agent-1").unwrap();
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let now = Instant::now();
    table.claim(agent, flow(40_000), peer, 4, now);

    assert_eq!(table.peer_for_reply(&flow(40_000).reverse(), 3, now), None);
    assert_eq!(
        table.peer_for_reply(&flow(40_000).reverse(), 4, now),
        Some(peer)
    );
}

#[test]
fn reset_agent_removes_only_that_agents_flows() {
    let mut table = FlowTable::new(16, 8, Duration::from_secs(60));
    let now = Instant::now();
    let peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let first = AgentId::parse("agent-1").unwrap();
    let second = AgentId::parse("agent-2").unwrap();
    table.claim(first.clone(), flow(40_000), peer, 1, now);
    table.claim(second, flow(40_001), peer, 1, now);

    assert_eq!(table.remove_agent(&first), 1);
    assert_eq!(table.peer_for_reply(&flow(40_000).reverse(), 1, now), None);
    assert_eq!(
        table.peer_for_reply(&flow(40_001).reverse(), 1, now),
        Some(peer)
    );
}

#[test]
fn failed_peer_removes_only_that_agents_flows_for_that_peer() {
    let mut table = FlowTable::new(16, 8, Duration::from_secs(60));
    let now = Instant::now();
    let failed_peer: SocketAddr = "10.0.0.2:41000".parse().unwrap();
    let replacement_peer: SocketAddr = "10.0.0.3:42000".parse().unwrap();
    let first = AgentId::parse("agent-1").unwrap();
    let second = AgentId::parse("agent-2").unwrap();
    table.claim(first.clone(), flow(40_000), failed_peer, 1, now);
    table.claim(first.clone(), flow(40_001), replacement_peer, 1, now);
    table.claim(second, flow(40_002), failed_peer, 1, now);

    assert_eq!(table.remove_peer(&first, failed_peer), 1);
    assert_eq!(table.peer_for_reply(&flow(40_000).reverse(), 1, now), None);
    assert_eq!(
        table.peer_for_reply(&flow(40_001).reverse(), 1, now),
        Some(replacement_peer)
    );
    assert_eq!(
        table.peer_for_reply(&flow(40_002).reverse(), 1, now),
        Some(failed_peer)
    );
}
