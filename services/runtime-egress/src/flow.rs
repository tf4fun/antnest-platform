use std::{
    collections::HashMap,
    net::SocketAddr,
    time::{Duration, Instant},
};

use crate::{domain::AgentId, packet::FlowKey};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ClaimResult {
    Created,
    Existing,
    Collision,
    CapacityExceeded,
}

#[derive(Clone, Debug)]
struct FlowEntry {
    agent_id: AgentId,
    peer: SocketAddr,
    assignment_version: u64,
    last_seen: Instant,
}

#[derive(Debug)]
pub struct FlowTable {
    flows: HashMap<FlowKey, FlowEntry>,
    agent_counts: HashMap<AgentId, usize>,
    max_total: usize,
    max_per_agent: usize,
    idle_timeout: Duration,
    expired_total: u64,
}

impl FlowTable {
    pub fn new(max_total: usize, max_per_agent: usize, idle_timeout: Duration) -> Self {
        Self {
            flows: HashMap::new(),
            agent_counts: HashMap::new(),
            max_total,
            max_per_agent,
            idle_timeout,
            expired_total: 0,
        }
    }

    pub fn claim(
        &mut self,
        agent_id: AgentId,
        key: FlowKey,
        peer: SocketAddr,
        assignment_version: u64,
        now: Instant,
    ) -> ClaimResult {
        self.expire(now);
        if let Some(entry) = self.flows.get_mut(&key) {
            if entry.agent_id == agent_id
                && entry.peer == peer
                && entry.assignment_version == assignment_version
            {
                entry.last_seen = now;
                return ClaimResult::Existing;
            }
            return ClaimResult::Collision;
        }

        let agent_count = self
            .agent_counts
            .get(&agent_id)
            .copied()
            .unwrap_or_default();
        if self.flows.len() >= self.max_total || agent_count >= self.max_per_agent {
            return ClaimResult::CapacityExceeded;
        }
        self.flows.insert(
            key,
            FlowEntry {
                agent_id: agent_id.clone(),
                peer,
                assignment_version,
                last_seen: now,
            },
        );
        self.agent_counts.insert(agent_id, agent_count + 1);
        ClaimResult::Created
    }

    pub fn peer_for_reply(
        &mut self,
        reply_key: &FlowKey,
        assignment_version: u64,
        now: Instant,
    ) -> Option<SocketAddr> {
        self.expire(now);
        let entry = self.flows.get_mut(&reply_key.reverse())?;
        if entry.assignment_version != assignment_version {
            return None;
        }
        entry.last_seen = now;
        Some(entry.peer)
    }

    pub fn remove_agent(&mut self, agent_id: &AgentId) -> usize {
        let before = self.flows.len();
        self.flows.retain(|_, entry| &entry.agent_id != agent_id);
        self.agent_counts.remove(agent_id);
        before - self.flows.len()
    }

    pub fn remove_peer(&mut self, agent_id: &AgentId, peer: SocketAddr) -> usize {
        let removed: Vec<_> = self
            .flows
            .iter()
            .filter_map(|(key, entry)| {
                (&entry.agent_id == agent_id && entry.peer == peer).then_some(*key)
            })
            .collect();
        for key in &removed {
            self.flows.remove(key);
            decrement_count(&mut self.agent_counts, agent_id);
        }
        removed.len()
    }

    pub fn len(&self) -> usize {
        self.flows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.flows.is_empty()
    }

    pub fn expired_total(&self) -> u64 {
        self.expired_total
    }

    pub fn expire(&mut self, now: Instant) -> usize {
        let expired: Vec<_> = self
            .flows
            .iter()
            .filter_map(|(key, entry)| {
                (now.saturating_duration_since(entry.last_seen) >= self.idle_timeout)
                    .then_some((*key, entry.agent_id.clone()))
            })
            .collect();
        for (key, agent_id) in &expired {
            self.flows.remove(key);
            decrement_count(&mut self.agent_counts, agent_id);
        }
        self.expired_total = self
            .expired_total
            .saturating_add(u64::try_from(expired.len()).unwrap_or(u64::MAX));
        expired.len()
    }
}

fn decrement_count(counts: &mut HashMap<AgentId, usize>, agent_id: &AgentId) {
    let Some(count) = counts.get_mut(agent_id) else {
        return;
    };
    *count -= 1;
    if *count == 0 {
        counts.remove(agent_id);
    }
}
