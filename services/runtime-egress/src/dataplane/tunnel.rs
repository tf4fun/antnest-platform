use super::*;
use crate::tunnel::PreparedKey;

#[cfg(test)]
impl DataPlaneEngine {
    pub(crate) fn test_bind_remote(&mut self, id: KeyId, remote: SocketAddr) {
        if let Some(context) = self.tunnels.get_mut(&id) {
            context.remote = Some(remote);
        }
    }
}
use antnest_runtime_tunnel::{Error as TunnelError, Event, datagram_key_id};
use std::collections::HashSet;

impl DataPlaneEngine {
    pub fn has_tunnel(&self, agent: &AgentId, id: KeyId, ip: Ipv4Addr) -> bool {
        self.tunnels
            .get(&id)
            .is_some_and(|c| &c.agent_id == agent && c.tunnel_ipv4 == ip)
    }

    pub fn replace_agent_tunnels(&mut self, agent: &AgentId, contexts: Vec<(PreparedKey, Peer)>) {
        let keep: HashSet<_> = contexts.iter().map(|(row, _)| row.key_id).collect();
        self.tunnels
            .retain(|id, c| &c.agent_id != agent || keep.contains(id));
        for (row, peer) in contexts {
            self.tunnels.entry(row.key_id).or_insert(TunnelContext {
                agent_id: row.agent_id,
                tunnel_ipv4: row.tunnel_ipv4,
                peer,
                remote: None,
            });
        }
    }
    pub fn select_tunnel_key(&mut self, agent: AgentId, id: Option<KeyId>) {
        if let Some(id) = id {
            self.selected_keys.insert(agent, id);
        } else {
            self.selected_keys.remove(&agent);
        }
    }
    pub fn remove_agent_tunnels(&mut self, agent: &AgentId) {
        self.tunnels.retain(|_, c| &c.agent_id != agent);
        self.selected_keys.remove(agent);
    }
    pub fn handle_wire_uplink(
        &mut self,
        frame: &[u8],
        remote: SocketAddr,
        now: Instant,
    ) -> Vec<DataPlaneAction> {
        let Ok(id) = datagram_key_id(frame) else {
            return vec![self.drop(DropReason::TunnelUnknownContext)];
        };
        let Some(context) = self.tunnels.get_mut(&id) else {
            return vec![self.drop(DropReason::TunnelUnknownContext)];
        };
        let agent = context.agent_id.clone();
        let ip = context.tunnel_ipv4;
        let Some(route) = self.snapshot.route(ip) else {
            return vec![self.drop(DropReason::TunnelUnknownContext)];
        };
        if route.agent_id != agent || route.gate == RouteGate::HardFenced {
            return vec![self.drop(DropReason::AgentFenced)];
        }
        if route.gate == RouteGate::Open
            && (self.selected_keys.get(&agent) != Some(&id)
                || route.runtime_endpoint.map(IpAddr::V4) != Some(remote.ip()))
        {
            return vec![self.drop(DropReason::TunnelAuthentication)];
        }
        let events = match context.peer.receive(frame, remote.ip()) {
            Ok(events) => events,
            Err(TunnelError::Replay) => return vec![self.drop(DropReason::TunnelReplay)],
            Err(_) => return vec![self.drop(DropReason::TunnelAuthentication)],
        };
        let mut output = Vec::new();
        for event in events {
            match event {
                Event::Network(packet) => output.push(DataPlaneAction::SendHandshake {
                    peer: remote,
                    packet,
                }),
                Event::Ipv4(packet) => {
                    let Ok(inner) = parse_ipv4_tcp(&packet, self.inner_mtu) else {
                        output.push(self.drop(DropReason::MalformedPacket));
                        continue;
                    };
                    if inner.source != ip {
                        output.push(self.drop(DropReason::TunnelAuthentication));
                        continue;
                    }
                    self.tunnels
                        .get_mut(&id)
                        .expect("context remains installed")
                        .remote = Some(remote);
                    let action = self.handle_uplink(&packet, remote, now);
                    output.extend(self.encrypt_action_for(id, action));
                }
            }
        }
        output
    }
    pub fn handle_wire_downlink(&mut self, packet: &[u8], now: Instant) -> Vec<DataPlaneAction> {
        let action = self.handle_downlink(packet, now);
        if let DataPlaneAction::SendUdp { agent_id, .. } = &action {
            let Some(id) = self.selected_keys.get(agent_id).copied() else {
                return vec![self.drop(DropReason::TunnelUnknownContext)];
            };
            self.encrypt_action_for(id, action)
        } else {
            vec![action]
        }
    }
    fn encrypt_action_for(&mut self, id: KeyId, action: DataPlaneAction) -> Vec<DataPlaneAction> {
        let DataPlaneAction::SendUdp {
            agent_id,
            peer,
            packet,
        } = action
        else {
            return vec![action];
        };
        let Some(context) = self.tunnels.get_mut(&id) else {
            return vec![self.drop(DropReason::TunnelUnknownContext)];
        };
        match context.peer.send(&packet) {
            Ok(events) => events
                .into_iter()
                .filter_map(|e| match e {
                    Event::Network(packet) => Some(DataPlaneAction::SendUdp {
                        agent_id: agent_id.clone(),
                        peer,
                        packet,
                    }),
                    Event::Ipv4(_) => None,
                })
                .collect(),
            Err(_) => vec![self.drop(DropReason::TunnelAuthentication)],
        }
    }
    pub fn tunnel_tick(&mut self) -> Vec<DataPlaneAction> {
        self.tunnel_tick_at(Instant::now())
    }

    pub(crate) fn tunnel_tick_at(&mut self, now: Instant) -> Vec<DataPlaneAction> {
        let mut output = Vec::new();
        let remaining = self.drain_remaining(now);
        let notice_due = self.drain_notice_next.is_none_or(|next| next <= now);
        let mut notice_sent = false;
        for (id, context) in &mut self.tunnels {
            let Some(remote) = context.remote else {
                continue;
            };
            let Some(route) = self.snapshot.route(context.tunnel_ipv4) else {
                continue;
            };
            if route.gate == RouteGate::HardFenced
                || route.gate == RouteGate::Open
                    && (route.runtime_endpoint.map(IpAddr::V4) != Some(remote.ip())
                        || self.selected_keys.get(&context.agent_id) != Some(id))
            {
                continue;
            }
            if notice_due && let Some(remaining) = remaining.filter(|value| !value.is_zero()) {
                let millis = u32::try_from(remaining.as_millis())
                    .unwrap_or(u32::MAX)
                    .max(1);
                if let Ok(notice) =
                    antnest_runtime_tunnel::egress_restart_packet(context.tunnel_ipv4, millis)
                    && let Ok(events) = context.peer.send(&notice)
                {
                    for event in events {
                        if let Event::Network(frame) = event {
                            output.push(DataPlaneAction::SendUdp {
                                agent_id: context.agent_id.clone(),
                                peer: remote,
                                packet: frame,
                            });
                        }
                    }
                    notice_sent = true;
                }
            }
            if let Ok(events) = context.peer.tick() {
                for event in events {
                    if let Event::Network(packet) = event {
                        output.push(DataPlaneAction::SendHandshake {
                            peer: remote,
                            packet,
                        });
                    }
                }
            }
        }
        if notice_sent {
            self.drain_notice_next = Some(now + Duration::from_secs(1));
        }
        output
    }
}
