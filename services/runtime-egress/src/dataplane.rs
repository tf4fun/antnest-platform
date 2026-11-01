use antnest_runtime_tunnel::{KeyId, Peer};
use std::{
    collections::HashMap,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};
mod tunnel;

struct TunnelContext {
    agent_id: AgentId,
    tunnel_ipv4: Ipv4Addr,
    peer: Peer,
    remote: Option<SocketAddr>,
}
impl std::fmt::Debug for TunnelContext {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelContext")
            .field("agent_id", &self.agent_id)
            .finish_non_exhaustive()
    }
}

use crate::{
    domain::AgentId,
    flow::{ClaimResult, FlowTable},
    packet::{PacketError, is_readiness_probe, parse_ipv4_tcp, tcp_reset},
    policy::{CompiledPolicy, Decision, is_hard_special_ipv4},
};
use ipnet::Ipv4Net;

const MAX_AGENT_BINDINGS: usize = 4096;
const MAX_BINDING_TTL: Duration = Duration::from_secs(300);

#[derive(Clone, Debug)]
pub struct DnsContext {
    pub source: Ipv4Addr,
    pub agent_id: AgentId,
    pub assignment_version: u64,
    pub policy: CompiledPolicy,
    generation: u64,
    platform_epoch: u64,
}

#[derive(Debug, Default)]
struct AgentBindings {
    version: u64,
    addresses: HashMap<Ipv4Addr, Vec<(u8, Instant)>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRoute {
    pub agent_id: AgentId,
    pub tunnel_ipv4: Ipv4Addr,
    pub assignment_version: u64,
    pub policy: CompiledPolicy,
    pub gate: RouteGate,
    pub runtime_endpoint: Option<Ipv4Addr>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteGate {
    Open,
    ProbeOnly,
    HardFenced,
}

#[derive(Clone, Debug, Default)]
pub struct NetworkSnapshot {
    routes: HashMap<Ipv4Addr, AgentRoute>,
}

impl NetworkSnapshot {
    pub fn from_routes(routes: impl IntoIterator<Item = AgentRoute>) -> Self {
        Self {
            routes: routes
                .into_iter()
                .map(|route| (route.tunnel_ipv4, route))
                .collect(),
        }
    }

    pub fn route(&self, address: Ipv4Addr) -> Option<&AgentRoute> {
        self.routes.get(&address)
    }

    pub fn replace(&mut self, route: AgentRoute) {
        self.routes.insert(route.tunnel_ipv4, route);
    }

    pub fn remove_agent(&mut self, agent_id: &AgentId) {
        self.routes.retain(|_, route| &route.agent_id != agent_id);
    }

    pub fn routes(&self) -> impl Iterator<Item = &AgentRoute> {
        self.routes.values()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataPlaneAction {
    SendHandshake {
        peer: SocketAddr,
        packet: Vec<u8>,
    },
    WriteTun(Vec<u8>),
    SendUdp {
        agent_id: AgentId,
        peer: SocketAddr,
        packet: Vec<u8>,
    },
    Drop(DropReason),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DropReason {
    TunnelAuthentication,
    TunnelReplay,
    TunnelUnknownContext,
    MalformedPacket,
    UnsupportedPacket,
    UnknownAgent,
    PeerMismatch,
    AgentFenced,
    PolicyDenied,
    FlowCollision,
    FlowCapacity,
    ReverseFlowMissing,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DataPlaneMetrics {
    pub authentication_drops: u64,
    pub replay_drops: u64,
    pub unknown_context_drops: u64,
    pub uplink_packets: u64,
    pub uplink_bytes: u64,
    pub downlink_packets: u64,
    pub downlink_bytes: u64,
    pub policy_allows: u64,
    pub policy_denials: u64,
    pub malformed_packets: u64,
    pub unsupported_packets: u64,
    pub unknown_agents: u64,
    pub peer_mismatches: u64,
    pub fenced_packets: u64,
    pub flow_collisions: u64,
    pub flow_capacity_rejections: u64,
    pub reverse_flow_misses: u64,
    pub peer_output_failures: u64,
    pub unattributed_udp_receive_errors: u64,
    pub flow_expirations: u64,
    pub active_flows: usize,
}

#[derive(Debug)]
pub struct DataPlaneEngine {
    tunnels: HashMap<KeyId, TunnelContext>,
    selected_keys: HashMap<AgentId, KeyId>,
    snapshot: NetworkSnapshot,
    flows: FlowTable,
    inner_mtu: usize,
    metrics: DataPlaneMetrics,
    platform_deny: Vec<Ipv4Net>,
    platform_epoch: u64,
    bindings: HashMap<AgentId, AgentBindings>,
    dns_generations: HashMap<AgentId, u64>,
    dns_generation_counter: u64,
}

impl DataPlaneEngine {
    pub fn new(
        snapshot: NetworkSnapshot,
        inner_mtu: usize,
        max_flows: usize,
        max_agent_flows: usize,
        flow_idle: Duration,
    ) -> Self {
        Self {
            tunnels: HashMap::new(),
            selected_keys: HashMap::new(),
            snapshot,
            flows: FlowTable::new(max_flows, max_agent_flows, flow_idle),
            inner_mtu,
            metrics: DataPlaneMetrics::default(),
            platform_deny: Vec::new(),
            platform_epoch: 0,
            bindings: HashMap::new(),
            dns_generations: HashMap::new(),
            dns_generation_counter: 0,
        }
    }

    pub fn set_platform_deny(&mut self, networks: Vec<Ipv4Net>) {
        if self.platform_deny != networks {
            self.platform_deny = networks;
            self.platform_epoch += 1;
            self.bindings.clear();
        }
    }

    fn platform_denies(&self, address: Ipv4Addr) -> bool {
        self.platform_deny
            .iter()
            .any(|network| network.contains(&address))
    }

    fn bump_dns_generation(&mut self, agent_id: &AgentId) {
        self.dns_generation_counter += 1;
        self.dns_generations
            .insert(agent_id.clone(), self.dns_generation_counter);
    }

    pub fn dns_context(&mut self, source: Ipv4Addr) -> Option<DnsContext> {
        let route = self.snapshot.route(source)?;
        if route.gate != RouteGate::Open {
            return None;
        }
        let agent_id = route.agent_id.clone();
        let assignment_version = route.assignment_version;
        let policy = route.policy.clone();
        let generation = match self.dns_generations.get(&agent_id) {
            Some(generation) => *generation,
            None => {
                self.bump_dns_generation(&agent_id);
                self.dns_generation_counter
            }
        };
        Some(DnsContext {
            source,
            agent_id,
            assignment_version,
            policy,
            generation,
            platform_epoch: self.platform_epoch,
        })
    }

    pub fn is_dns_context_current(&self, context: &DnsContext) -> bool {
        let Some(route) = self.snapshot.route(context.source) else {
            return false;
        };
        route.gate == RouteGate::Open
            && route.agent_id == context.agent_id
            && route.assignment_version == context.assignment_version
            && route.policy == context.policy
            && self.dns_generations.get(&route.agent_id) == Some(&context.generation)
            && self.platform_epoch == context.platform_epoch
    }

    pub fn bind_dns_answers(
        &mut self,
        context: &DnsContext,
        name: &str,
        addresses: &[Ipv4Addr],
        ttl: Duration,
        now: Instant,
    ) -> usize {
        if ttl.is_zero() || addresses.is_empty() || !self.is_dns_context_current(context) {
            return 0;
        }
        let mask = context.policy.domain_rule_mask(name);
        if mask == 0 {
            return 0;
        }
        let ttl = ttl.min(MAX_BINDING_TTL);
        let expires = now + ttl;
        let rules: Vec<u8> = (0..128)
            .filter(|index| mask & (1_u128 << index) != 0)
            .map(|index| index as u8)
            .collect();
        let denied: Vec<bool> = addresses
            .iter()
            .map(|address| {
                self.platform_deny
                    .iter()
                    .any(|network| network.contains(address))
                    || is_hard_special_ipv4(*address)
            })
            .collect();
        let bindings = self.bindings.entry(context.agent_id.clone()).or_default();
        bindings.version = context.assignment_version;
        for entries in bindings.addresses.values_mut() {
            entries.retain(|(_, expiry)| *expiry > now);
        }
        bindings.addresses.retain(|_, entries| !entries.is_empty());
        let mut used: usize = bindings.addresses.values().map(Vec::len).sum();
        let mut bound = 0;
        for (address, denied) in addresses.iter().zip(denied) {
            if denied {
                continue;
            }
            for rule in &rules {
                if let Some(entries) = bindings.addresses.get_mut(address)
                    && let Some((_, expiry)) =
                        entries.iter_mut().find(|(existing, _)| existing == rule)
                {
                    *expiry = expires;
                    bound += 1;
                    continue;
                }
                if used >= MAX_AGENT_BINDINGS {
                    return bound;
                }
                bindings
                    .addresses
                    .entry(*address)
                    .or_default()
                    .push((*rule, expires));
                used += 1;
                bound += 1;
            }
        }
        bound
    }

    fn binding_mask(
        &self,
        agent_id: &AgentId,
        version: u64,
        address: Ipv4Addr,
        now: Instant,
    ) -> u128 {
        let Some(bindings) = self.bindings.get(agent_id) else {
            return 0;
        };
        if bindings.version != version {
            return 0;
        }
        bindings.addresses.get(&address).map_or(0, |entries| {
            entries
                .iter()
                .filter(|(_, expiry)| *expiry > now)
                .fold(0, |mask, (rule, _)| mask | (1_u128 << rule))
        })
    }

    pub fn handle_uplink(
        &mut self,
        bytes: &[u8],
        peer: SocketAddr,
        now: Instant,
    ) -> DataPlaneAction {
        increment(&mut self.metrics.uplink_packets, 1);
        increment(&mut self.metrics.uplink_bytes, bytes.len() as u64);
        let packet = match parse_ipv4_tcp(bytes, self.inner_mtu) {
            Ok(packet) => packet,
            Err(error) => return self.drop(packet_drop_reason(error)),
        };
        let Some(route) = self.snapshot.route(packet.source) else {
            return self.drop(DropReason::UnknownAgent);
        };
        if route.gate == RouteGate::Open
            && route.runtime_endpoint.map(IpAddr::V4) != Some(peer.ip())
        {
            return self.drop(DropReason::PeerMismatch);
        }
        match route.gate {
            RouteGate::HardFenced => return self.drop(DropReason::AgentFenced),
            RouteGate::ProbeOnly => {
                if !is_readiness_probe(&packet, bytes.len()) {
                    return self.drop(DropReason::AgentFenced);
                }
                let Some(packet) = tcp_reset(&packet) else {
                    return self.drop(DropReason::AgentFenced);
                };
                return DataPlaneAction::SendUdp {
                    agent_id: route.agent_id.clone(),
                    peer,
                    packet,
                };
            }
            RouteGate::Open => {}
        }
        let resolver_hit =
            packet.destination == route.policy.resolver_ipv4() && packet.destination_port == 53;
        let binding = self.binding_mask(
            &route.agent_id,
            route.assignment_version,
            packet.destination,
            now,
        );
        if (self.platform_denies(packet.destination) && !resolver_hit)
            || route.policy.decide_with_bindings(
                packet.destination,
                packet.destination_port,
                binding,
            ) == Decision::Deny
        {
            increment(&mut self.metrics.policy_denials, 1);
            return match tcp_reset(&packet) {
                Some(packet) => DataPlaneAction::SendUdp {
                    agent_id: route.agent_id.clone(),
                    peer,
                    packet,
                },
                None => self.drop(DropReason::PolicyDenied),
            };
        }
        increment(&mut self.metrics.policy_allows, 1);

        match self.flows.claim(
            route.agent_id.clone(),
            packet.flow_key(),
            peer,
            route.assignment_version,
            now,
        ) {
            ClaimResult::Created | ClaimResult::Existing => {
                DataPlaneAction::WriteTun(bytes.to_vec())
            }
            ClaimResult::Collision => self.drop(DropReason::FlowCollision),
            ClaimResult::CapacityExceeded => self.drop(DropReason::FlowCapacity),
        }
    }

    pub fn uplink_agent(&self, bytes: &[u8]) -> Option<AgentId> {
        let packet = parse_ipv4_tcp(bytes, self.inner_mtu).ok()?;
        self.snapshot
            .route(packet.source)
            .map(|route| route.agent_id.clone())
    }

    pub fn handle_downlink(&mut self, bytes: &[u8], now: Instant) -> DataPlaneAction {
        increment(&mut self.metrics.downlink_packets, 1);
        increment(&mut self.metrics.downlink_bytes, bytes.len() as u64);
        let packet = match parse_ipv4_tcp(bytes, self.inner_mtu) {
            Ok(packet) => packet,
            Err(error) => return self.drop(packet_drop_reason(error)),
        };
        let Some(route) = self.snapshot.route(packet.destination) else {
            return self.drop(DropReason::UnknownAgent);
        };
        if route.gate != RouteGate::Open {
            return self.drop(DropReason::AgentFenced);
        }
        let agent_id = route.agent_id.clone();
        let assignment_version = route.assignment_version;
        let policy = route.policy.clone();
        let runtime_endpoint = route.runtime_endpoint;
        match self
            .flows
            .peer_for_reply(&packet.flow_key(), assignment_version, now)
        {
            Some(peer) if runtime_endpoint.map(IpAddr::V4) == Some(peer.ip()) => {
                let resolver_hit =
                    packet.source == policy.resolver_ipv4() && packet.source_port == 53;
                let binding = self.binding_mask(&agent_id, assignment_version, packet.source, now);
                if (self.platform_denies(packet.source) && !resolver_hit)
                    || policy.decide_with_bindings(packet.source, packet.source_port, binding)
                        == Decision::Deny
                {
                    return self.drop(DropReason::PolicyDenied);
                }
                DataPlaneAction::SendUdp {
                    agent_id,
                    peer,
                    packet: bytes.to_vec(),
                }
            }
            Some(_) => self.drop(DropReason::PeerMismatch),
            None => self.drop(DropReason::ReverseFlowMissing),
        }
    }

    pub fn downlink_agent(&self, bytes: &[u8]) -> Option<AgentId> {
        let packet = parse_ipv4_tcp(bytes, self.inner_mtu).ok()?;
        self.snapshot
            .route(packet.destination)
            .map(|route| route.agent_id.clone())
    }

    pub fn replace_snapshot(&mut self, snapshot: NetworkSnapshot) {
        let previous: HashMap<AgentId, AgentRoute> = self
            .snapshot
            .routes()
            .map(|route| (route.agent_id.clone(), route.clone()))
            .collect();
        let current: HashMap<AgentId, AgentRoute> = snapshot
            .routes()
            .map(|route| (route.agent_id.clone(), route.clone()))
            .collect();
        for agent in previous.keys().chain(current.keys()) {
            if previous.get(agent) != current.get(agent) {
                self.bump_dns_generation(agent);
                self.bindings.remove(agent);
            }
        }
        self.snapshot = snapshot;
        self.prune_retired_dns_generations();
    }

    pub fn upsert_route(&mut self, route: AgentRoute) {
        let unchanged = self
            .snapshot
            .route(route.tunnel_ipv4)
            .is_some_and(|old| *old == route);
        if !unchanged {
            if let Some(agent) = self
                .snapshot
                .route(route.tunnel_ipv4)
                .map(|old| old.agent_id.clone())
                && agent != route.agent_id
            {
                self.bump_dns_generation(&agent);
                self.bindings.remove(&agent);
            }
            self.bump_dns_generation(&route.agent_id);
            self.bindings.remove(&route.agent_id);
        }
        self.snapshot.replace(route);
        self.prune_retired_dns_generations();
    }

    pub fn remove_agent(&mut self, agent_id: &AgentId) -> usize {
        self.snapshot.remove_agent(agent_id);
        self.bindings.remove(agent_id);
        self.dns_generations.remove(agent_id);
        self.flows.remove_agent(agent_id)
    }

    pub fn fence_agent(&mut self, agent_id: AgentId) {
        self.set_gate(&agent_id, RouteGate::HardFenced);
    }

    pub fn probe_only_agent(&mut self, agent_id: &AgentId) {
        self.set_gate(agent_id, RouteGate::ProbeOnly);
    }

    pub fn reopen_agent(&mut self, agent_id: &AgentId) {
        self.set_gate(agent_id, RouteGate::Open);
    }

    pub fn is_agent_fenced(&self, agent_id: &AgentId) -> bool {
        self.snapshot
            .routes()
            .find(|route| &route.agent_id == agent_id)
            .is_some_and(|route| route.gate != RouteGate::Open)
    }

    pub fn fenced_agent_count(&self) -> usize {
        self.snapshot
            .routes()
            .filter(|route| route.gate != RouteGate::Open)
            .count()
    }

    pub fn reset_agent_flows(&mut self, agent_id: &AgentId) -> usize {
        self.bindings.remove(agent_id);
        self.bump_dns_generation(agent_id);
        self.prune_retired_dns_generations();
        self.flows.remove_agent(agent_id)
    }

    fn prune_retired_dns_generations(&mut self) {
        self.dns_generations
            .retain(|agent, _| self.snapshot.routes().any(|route| &route.agent_id == agent));
    }

    fn set_gate(&mut self, agent_id: &AgentId, gate: RouteGate) {
        let changed = if let Some(route) = self
            .snapshot
            .routes
            .values_mut()
            .find(|route| &route.agent_id == agent_id)
        {
            let changed = route.gate != gate;
            route.gate = gate;
            changed
        } else {
            false
        };
        if changed {
            self.bump_dns_generation(agent_id);
            self.bindings.remove(agent_id);
        }
    }

    pub fn peer_output_failed(&mut self, agent_id: &AgentId, peer: SocketAddr) -> usize {
        increment(&mut self.metrics.peer_output_failures, 1);
        self.flows.remove_peer(agent_id, peer)
    }

    pub fn unattributed_udp_receive_error(&mut self) {
        increment(&mut self.metrics.unattributed_udp_receive_errors, 1);
    }

    pub fn flow_count(&self) -> usize {
        self.flows.len()
    }

    pub fn snapshot(&self) -> &NetworkSnapshot {
        &self.snapshot
    }

    pub fn metrics(&self) -> DataPlaneMetrics {
        DataPlaneMetrics {
            active_flows: self.flows.len(),
            flow_expirations: self.flows.expired_total(),
            ..self.metrics
        }
    }

    fn drop(&mut self, reason: DropReason) -> DataPlaneAction {
        match reason {
            DropReason::TunnelAuthentication => {
                increment(&mut self.metrics.authentication_drops, 1)
            }
            DropReason::TunnelReplay => increment(&mut self.metrics.replay_drops, 1),
            DropReason::TunnelUnknownContext => {
                increment(&mut self.metrics.unknown_context_drops, 1)
            }
            DropReason::MalformedPacket => increment(&mut self.metrics.malformed_packets, 1),
            DropReason::UnsupportedPacket => increment(&mut self.metrics.unsupported_packets, 1),
            DropReason::UnknownAgent => increment(&mut self.metrics.unknown_agents, 1),
            DropReason::PeerMismatch => increment(&mut self.metrics.peer_mismatches, 1),
            DropReason::AgentFenced => increment(&mut self.metrics.fenced_packets, 1),
            DropReason::PolicyDenied => {}
            DropReason::FlowCollision => increment(&mut self.metrics.flow_collisions, 1),
            DropReason::FlowCapacity => {
                increment(&mut self.metrics.flow_capacity_rejections, 1);
            }
            DropReason::ReverseFlowMissing => {
                increment(&mut self.metrics.reverse_flow_misses, 1);
            }
        }
        DataPlaneAction::Drop(reason)
    }
}

fn packet_drop_reason(error: PacketError) -> DropReason {
    match error {
        PacketError::UnsupportedVersion
        | PacketError::Fragmented
        | PacketError::UnsupportedProtocol => DropReason::UnsupportedPacket,
        PacketError::InvalidSize
        | PacketError::InvalidIpv4Header
        | PacketError::LengthMismatch
        | PacketError::InvalidTcpHeader => DropReason::MalformedPacket,
    }
}

fn increment(counter: &mut u64, value: u64) {
    *counter = counter.saturating_add(value);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PolicySpec;

    const RESOLVER: Ipv4Addr = Ipv4Addr::new(100, 64, 0, 1);
    const TUNNEL: Ipv4Addr = Ipv4Addr::new(100, 96, 0, 10);

    fn spec(document: &str) -> PolicySpec {
        serde_json::from_str(document).unwrap()
    }

    fn route(agent: &str, policy: PolicySpec, version: u64) -> AgentRoute {
        AgentRoute {
            agent_id: AgentId::parse(agent).unwrap(),
            tunnel_ipv4: TUNNEL,
            assignment_version: version,
            policy: policy.compile(RESOLVER),
            gate: RouteGate::Open,
            runtime_endpoint: None,
        }
    }

    fn engine_with(routes: Vec<AgentRoute>) -> DataPlaneEngine {
        DataPlaneEngine::new(
            NetworkSnapshot::from_routes(routes),
            1400,
            32,
            16,
            Duration::from_secs(60),
        )
    }

    fn one_domain_policy() -> PolicySpec {
        spec(
            r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","domains":["d.example.com"]}]}"#,
        )
    }

    fn bound_pairs(engine: &DataPlaneEngine, agent: &str) -> usize {
        let id = AgentId::parse(agent).unwrap();
        engine
            .bindings
            .get(&id)
            .map_or(0, |entry| entry.addresses.values().map(Vec::len).sum())
    }

    #[test]
    fn binding_capacity_bounds_map_and_prunes_expired_for_reuse() {
        let mut engine = engine_with(vec![route("agent-1", one_domain_policy(), 1)]);
        let now = Instant::now();
        let context = engine.dns_context(TUNNEL).unwrap();
        let addresses: Vec<Ipv4Addr> = (0..4096)
            .map(|index| Ipv4Addr::new(151, (index / 256) as u8, (index % 256) as u8, 7))
            .collect();
        assert_eq!(
            engine.bind_dns_answers(
                &context,
                "d.example.com",
                &addresses,
                Duration::from_secs(30),
                now,
            ),
            4096
        );
        let overflow: Vec<Ipv4Addr> = (0..300)
            .map(|index| Ipv4Addr::new(9, (index / 256) as u8, (index % 256) as u8, 7))
            .collect();
        assert_eq!(
            engine.bind_dns_answers(
                &context,
                "d.example.com",
                &overflow,
                Duration::from_secs(30),
                now,
            ),
            0
        );
        let agent = AgentId::parse("agent-1").unwrap();
        let stored = engine.bindings.get(&agent).unwrap();
        assert_eq!(stored.addresses.len(), 4096);
        assert_eq!(bound_pairs(&engine, "agent-1"), 4096);
        let later = now + Duration::from_secs(31);
        assert_eq!(
            engine.bind_dns_answers(
                &context,
                "d.example.com",
                &[Ipv4Addr::new(8, 8, 8, 8)],
                Duration::from_secs(30),
                later,
            ),
            1
        );
        assert_eq!(bound_pairs(&engine, "agent-1"), 1);
    }

    #[test]
    fn repeated_bind_of_128_rules_on_one_ip_consumes_pairs_once() {
        let rules = (0..128)
            .map(|_| r#"{"action":"allow","domains":["many.example.com"]}"#)
            .collect::<Vec<_>>()
            .join(",");
        let document = format!(r#"{{"schema_version":2,"default":"deny","rules":[{rules}]}}"#);
        let mut engine = engine_with(vec![route("agent-1", spec(&document), 1)]);
        let now = Instant::now();
        let context = engine.dns_context(TUNNEL).unwrap();
        let address = Ipv4Addr::new(93, 184, 216, 34);
        for _ in 0..3 {
            assert_eq!(
                engine.bind_dns_answers(
                    &context,
                    "many.example.com",
                    &[address],
                    Duration::from_secs(60),
                    now,
                ),
                128
            );
        }
        assert_eq!(bound_pairs(&engine, "agent-1"), 128);
        assert_eq!(
            engine.binding_mask(&AgentId::parse("agent-1").unwrap(), 1, address, now,),
            u128::MAX
        );
    }

    #[test]
    fn bindings_isolate_agents_cap_ttl_and_track_platform_epoch() {
        let mut engine = engine_with(vec![
            route("agent-1", one_domain_policy(), 1),
            AgentRoute {
                agent_id: AgentId::parse("agent-2").unwrap(),
                tunnel_ipv4: "100.96.0.11".parse().unwrap(),
                ..route("agent-2", one_domain_policy(), 1)
            },
        ]);
        let now = Instant::now();
        let first = engine.dns_context(TUNNEL).unwrap();
        let second = engine.dns_context("100.96.0.11".parse().unwrap()).unwrap();
        let address = Ipv4Addr::new(93, 184, 216, 34);
        assert_eq!(
            engine.bind_dns_answers(
                &first,
                "d.example.com",
                &[address],
                Duration::from_secs(600),
                now,
            ),
            1
        );
        assert_eq!(
            engine.binding_mask(&AgentId::parse("agent-2").unwrap(), 1, address, now,),
            0
        );
        assert_ne!(
            engine.binding_mask(
                &AgentId::parse("agent-1").unwrap(),
                1,
                address,
                now + Duration::from_secs(299),
            ),
            0
        );
        assert_eq!(
            engine.binding_mask(
                &AgentId::parse("agent-1").unwrap(),
                1,
                address,
                now + Duration::from_secs(301),
            ),
            0
        );
        assert_eq!(
            engine.bind_dns_answers(
                &first,
                "d.example.com",
                &[Ipv4Addr::new(8, 8, 4, 4)],
                Duration::ZERO,
                now,
            ),
            0
        );
        assert!(engine.is_dns_context_current(&second));
        engine.set_platform_deny(vec!["172.30.255.0/24".parse().unwrap()]);
        assert!(!engine.is_dns_context_current(&first));
        assert_eq!(
            engine.bind_dns_answers(
                &first,
                "d.example.com",
                &[Ipv4Addr::new(8, 8, 8, 8)],
                Duration::from_secs(60),
                now,
            ),
            0
        );
    }

    #[test]
    fn deny_domain_binding_overrides_default_allow() {
        let mut engine = engine_with(vec![route(
            "agent-1",
            spec(
                r#"{"schema_version":2,"default":"allow","rules":[{"action":"deny","domains":["bad.example.com"]}]}"#,
            ),
            1,
        )]);
        let now = Instant::now();
        let context = engine.dns_context(TUNNEL).unwrap();
        let address = Ipv4Addr::new(93, 184, 216, 34);
        assert_eq!(
            engine.bind_dns_answers(
                &context,
                "bad.example.com",
                &[address],
                Duration::from_secs(60),
                now,
            ),
            1
        );
        assert_eq!(
            context.policy.decide_with_bindings(address, 443, 1),
            Decision::Deny
        );
        assert_eq!(
            context.policy.decide_with_bindings(address, 443, 0),
            Decision::Allow
        );
    }

    #[test]
    fn snapshot_and_policy_changes_invalidate_stale_contexts() {
        let mut engine = engine_with(vec![route("agent-1", one_domain_policy(), 1)]);
        let context = engine.dns_context(TUNNEL).unwrap();
        engine.replace_snapshot(NetworkSnapshot::from_routes([route(
            "agent-1",
            one_domain_policy(),
            1,
        )]));
        assert!(engine.is_dns_context_current(&context));
        engine.replace_snapshot(NetworkSnapshot::from_routes([route(
            "agent-1",
            spec(r#"{"schema_version":2,"default":"deny","rules":[]}"#),
            1,
        )]));
        assert!(!engine.is_dns_context_current(&context));
        let context = engine.dns_context(TUNNEL).unwrap();
        engine.remove_agent(&AgentId::parse("agent-1").unwrap());
        assert!(!engine.is_dns_context_current(&context));
        engine.reset_agent_flows(&AgentId::parse("ghost").unwrap());
        assert!(engine.dns_generations.is_empty());
    }
}
