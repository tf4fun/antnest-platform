use std::{
    collections::{HashMap, HashSet},
    net::{Ipv4Addr, SocketAddr},
    time::{Duration, Instant},
};

use crate::{
    domain::AgentId,
    flow::{ClaimResult, FlowTable},
    packet::{PacketError, parse_ipv4_tcp, tcp_reset},
    policy::{CompiledPolicy, Decision},
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRoute {
    pub agent_id: AgentId,
    pub tunnel_ipv4: Ipv4Addr,
    pub assignment_version: u64,
    pub policy: CompiledPolicy,
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
    MalformedPacket,
    UnsupportedPacket,
    UnknownAgent,
    AgentFenced,
    PolicyDenied,
    FlowCollision,
    FlowCapacity,
    ReverseFlowMissing,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DataPlaneMetrics {
    pub uplink_packets: u64,
    pub uplink_bytes: u64,
    pub downlink_packets: u64,
    pub downlink_bytes: u64,
    pub policy_allows: u64,
    pub policy_denials: u64,
    pub malformed_packets: u64,
    pub unsupported_packets: u64,
    pub unknown_agents: u64,
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
    snapshot: NetworkSnapshot,
    fenced_agents: HashSet<AgentId>,
    flows: FlowTable,
    inner_mtu: usize,
    metrics: DataPlaneMetrics,
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
            snapshot,
            fenced_agents: HashSet::new(),
            flows: FlowTable::new(max_flows, max_agent_flows, flow_idle),
            inner_mtu,
            metrics: DataPlaneMetrics::default(),
        }
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
        if self.fenced_agents.contains(&route.agent_id) {
            return self.drop(DropReason::AgentFenced);
        }
        if route
            .policy
            .decide(packet.destination, packet.destination_port)
            == Decision::Deny
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
        if self.fenced_agents.contains(&route.agent_id) {
            return self.drop(DropReason::AgentFenced);
        }
        match self
            .flows
            .peer_for_reply(&packet.flow_key(), route.assignment_version, now)
        {
            Some(peer) => DataPlaneAction::SendUdp {
                agent_id: route.agent_id.clone(),
                peer,
                packet: bytes.to_vec(),
            },
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
        self.snapshot = snapshot;
        self.fenced_agents.clear();
    }

    pub fn upsert_route(&mut self, route: AgentRoute) {
        self.snapshot.replace(route);
    }

    pub fn remove_agent(&mut self, agent_id: &AgentId) -> usize {
        self.snapshot.remove_agent(agent_id);
        self.fenced_agents.remove(agent_id);
        self.flows.remove_agent(agent_id)
    }

    pub fn fence_agent(&mut self, agent_id: AgentId) {
        self.fenced_agents.insert(agent_id);
    }

    pub fn reopen_agent(&mut self, agent_id: &AgentId) {
        self.fenced_agents.remove(agent_id);
    }

    pub fn is_agent_fenced(&self, agent_id: &AgentId) -> bool {
        self.fenced_agents.contains(agent_id)
    }

    pub fn fenced_agent_count(&self) -> usize {
        self.fenced_agents.len()
    }

    pub fn reset_agent_flows(&mut self, agent_id: &AgentId) -> usize {
        self.flows.remove_agent(agent_id)
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
            DropReason::MalformedPacket => increment(&mut self.metrics.malformed_packets, 1),
            DropReason::UnsupportedPacket => increment(&mut self.metrics.unsupported_packets, 1),
            DropReason::UnknownAgent => increment(&mut self.metrics.unknown_agents, 1),
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
