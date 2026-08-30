use std::{
    collections::{HashMap, HashSet},
    net::Ipv4Addr,
    sync::Arc,
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use ipnet::Ipv4Net;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::sync::Mutex;

use crate::{
    allocator::{AddressPool, AllocationError},
    domain::{
        ActiveBinding, AgentId, AgentNetwork, NetworkState, PolicyAssignment, PolicyId,
        PolicyRevision,
    },
    policy::PolicySpec,
};

mod postgres;

pub use postgres::PostgresRepository;

pub const BUILTIN_ALLOW_ALL: &str = "builtin/allow-all";
pub const BUILTIN_DENY_ALL: &str = "builtin/deny-all";
pub const BUILTIN_REVISION: u64 = 1;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DatabaseTlsMode {
    Require,
    Disable,
}

#[derive(Clone, Debug)]
pub struct RepositoryConfig {
    pub pool_id: String,
    pub tunnel_cidr: Ipv4Net,
    pub resolver_ipv4: Ipv4Addr,
    pub quarantine: Duration,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum RepositoryError {
    #[error("database connection is unavailable: {0}")]
    ConnectionUnavailable(String),
    #[error("address pool is invalid: {0}")]
    InvalidPool(AllocationError),
    #[error("address pool is exhausted")]
    AddressPoolExhausted,
    #[error("Agent network was not found")]
    AgentNetworkNotFound,
    #[error("Agent network is not active")]
    AgentNetworkUnavailable,
    #[error("policy revision was not found")]
    PolicyRevisionNotFound,
    #[error("policy revision key has different content")]
    PolicyRevisionConflict,
    #[error("policy assignment resource version changed")]
    ResourceVersionConflict,
    #[error("repository is unavailable: {0}")]
    Unavailable(String),
    #[error("repository operation failed: {0}")]
    OperationFailed(String),
}

#[async_trait]
pub trait Repository: Send + Sync + 'static {
    async fn ensure_agent_network(
        &self,
        agent_id: AgentId,
    ) -> Result<AgentNetwork, RepositoryError>;

    async fn agent_network(&self, agent_id: &AgentId) -> Result<AgentNetwork, RepositoryError>;

    async fn put_policy_revision(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, RepositoryError>;

    async fn policy_revision(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, RepositoryError>;

    async fn policy_assignment(
        &self,
        agent_id: &AgentId,
    ) -> Result<PolicyAssignment, RepositoryError>;

    async fn compare_and_swap_assignment(
        &self,
        agent_id: &AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, RepositoryError>;

    async fn quarantine_agent_network(
        &self,
        agent_id: &AgentId,
        now: SystemTime,
    ) -> Result<AgentNetwork, RepositoryError>;

    async fn active_bindings(&self) -> Result<Vec<ActiveBinding>, RepositoryError>;

    async fn expired_quarantines(
        &self,
        now: SystemTime,
    ) -> Result<Vec<AgentNetwork>, RepositoryError>;

    async fn delete_quarantined(
        &self,
        agent_id: &AgentId,
        expected_resource_version: u64,
    ) -> Result<bool, RepositoryError>;
}

#[derive(Debug)]
pub struct InMemoryRepository {
    state: Mutex<MemoryState>,
}

#[derive(Debug)]
struct MemoryState {
    config: RepositoryConfig,
    next_slot: u32,
    networks: HashMap<AgentId, AgentNetwork>,
    revisions: HashMap<(PolicyId, u64), PolicyRevision>,
    assignments: HashMap<AgentId, PolicyAssignment>,
}

impl InMemoryRepository {
    pub fn new(config: RepositoryConfig) -> Result<Self, RepositoryError> {
        let pool = AddressPool::new(
            config.pool_id.clone(),
            config.tunnel_cidr,
            config.resolver_ipv4,
            1,
        )
        .map_err(RepositoryError::InvalidPool)?;
        let revisions = builtin_revisions();
        Ok(Self {
            state: Mutex::new(MemoryState {
                config,
                next_slot: pool.next_slot(),
                networks: HashMap::new(),
                revisions,
                assignments: HashMap::new(),
            }),
        })
    }
}

#[async_trait]
impl Repository for InMemoryRepository {
    async fn ensure_agent_network(
        &self,
        agent_id: AgentId,
    ) -> Result<AgentNetwork, RepositoryError> {
        let mut state = self.state.lock().await;
        if let Some(existing) = state.networks.get(&agent_id) {
            if existing.state != NetworkState::Active {
                return Err(RepositoryError::AgentNetworkUnavailable);
            }
            return Ok(existing.clone());
        }

        let unavailable: HashSet<_> = state
            .networks
            .values()
            .map(|network| network.tunnel_ipv4)
            .collect();
        let pool = AddressPool::new(
            state.config.pool_id.clone(),
            state.config.tunnel_cidr,
            state.config.resolver_ipv4,
            state.next_slot,
        )
        .map_err(RepositoryError::InvalidPool)?;
        let selection = pool.select(&unavailable).map_err(|error| match error {
            AllocationError::Exhausted => RepositoryError::AddressPoolExhausted,
            other => RepositoryError::InvalidPool(other),
        })?;
        state.next_slot = selection.next_slot;

        let network = AgentNetwork {
            agent_id: agent_id.clone(),
            pool_id: state.config.pool_id.clone(),
            tunnel_ipv4: selection.address,
            state: NetworkState::Active,
            resource_version: 1,
            quarantine_until: None,
        };
        let assignment = PolicyAssignment {
            agent_id: agent_id.clone(),
            policy_id: PolicyId::parse(BUILTIN_DENY_ALL).expect("built-in policy ID"),
            revision: BUILTIN_REVISION,
            resource_version: 1,
        };
        state.networks.insert(agent_id.clone(), network.clone());
        state.assignments.insert(agent_id, assignment);
        Ok(network)
    }

    async fn agent_network(&self, agent_id: &AgentId) -> Result<AgentNetwork, RepositoryError> {
        self.state
            .lock()
            .await
            .networks
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)
    }

    async fn put_policy_revision(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, RepositoryError> {
        let candidate = policy_revision(policy_id.clone(), revision, spec);
        let mut state = self.state.lock().await;
        let key = (policy_id, revision);
        if let Some(existing) = state.revisions.get(&key) {
            return if existing.digest == candidate.digest {
                Ok(existing.clone())
            } else {
                Err(RepositoryError::PolicyRevisionConflict)
            };
        }
        state.revisions.insert(key, candidate.clone());
        Ok(candidate)
    }

    async fn policy_revision(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, RepositoryError> {
        self.state
            .lock()
            .await
            .revisions
            .get(&(policy_id.clone(), revision))
            .cloned()
            .ok_or(RepositoryError::PolicyRevisionNotFound)
    }

    async fn policy_assignment(
        &self,
        agent_id: &AgentId,
    ) -> Result<PolicyAssignment, RepositoryError> {
        self.state
            .lock()
            .await
            .assignments
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)
    }

    async fn compare_and_swap_assignment(
        &self,
        agent_id: &AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, RepositoryError> {
        let mut state = self.state.lock().await;
        if !state.revisions.contains_key(&(policy_id.clone(), revision)) {
            return Err(RepositoryError::PolicyRevisionNotFound);
        }
        let current = state
            .assignments
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if current.policy_id == policy_id && current.revision == revision {
            return Ok(current);
        }
        if current.resource_version != expected_resource_version {
            return Err(RepositoryError::ResourceVersionConflict);
        }
        let assignment = PolicyAssignment {
            agent_id: agent_id.clone(),
            policy_id,
            revision,
            resource_version: current.resource_version + 1,
        };
        state
            .assignments
            .insert(agent_id.clone(), assignment.clone());
        Ok(assignment)
    }

    async fn quarantine_agent_network(
        &self,
        agent_id: &AgentId,
        now: SystemTime,
    ) -> Result<AgentNetwork, RepositoryError> {
        let mut state = self.state.lock().await;
        let quarantine = state.config.quarantine;
        let network = state
            .networks
            .get_mut(agent_id)
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if network.state == NetworkState::Quarantined {
            return Ok(network.clone());
        }
        network.state = NetworkState::Quarantined;
        network.resource_version += 1;
        network.quarantine_until = Some(now + quarantine);
        Ok(network.clone())
    }

    async fn active_bindings(&self) -> Result<Vec<ActiveBinding>, RepositoryError> {
        let state = self.state.lock().await;
        state
            .networks
            .values()
            .filter(|network| network.state == NetworkState::Active)
            .map(|network| {
                let assignment = state
                    .assignments
                    .get(&network.agent_id)
                    .cloned()
                    .ok_or(RepositoryError::AgentNetworkNotFound)?;
                let revision = state
                    .revisions
                    .get(&(assignment.policy_id.clone(), assignment.revision))
                    .cloned()
                    .ok_or(RepositoryError::PolicyRevisionNotFound)?;
                Ok(ActiveBinding {
                    network: network.clone(),
                    assignment,
                    revision,
                })
            })
            .collect()
    }

    async fn expired_quarantines(
        &self,
        now: SystemTime,
    ) -> Result<Vec<AgentNetwork>, RepositoryError> {
        Ok(self
            .state
            .lock()
            .await
            .networks
            .values()
            .filter(|network| {
                network.state == NetworkState::Quarantined
                    && network
                        .quarantine_until
                        .is_some_and(|deadline| deadline <= now)
            })
            .cloned()
            .collect())
    }

    async fn delete_quarantined(
        &self,
        agent_id: &AgentId,
        expected_resource_version: u64,
    ) -> Result<bool, RepositoryError> {
        let mut state = self.state.lock().await;
        let matches = state.networks.get(agent_id).is_some_and(|network| {
            network.state == NetworkState::Quarantined
                && network.resource_version == expected_resource_version
        });
        if !matches {
            return Ok(false);
        }
        state.networks.remove(agent_id);
        state.assignments.remove(agent_id);
        Ok(true)
    }
}

fn builtin_revisions() -> HashMap<(PolicyId, u64), PolicyRevision> {
    [
        (
            PolicyId::parse(BUILTIN_ALLOW_ALL).expect("built-in policy ID"),
            PolicySpec::allow_all(),
        ),
        (
            PolicyId::parse(BUILTIN_DENY_ALL).expect("built-in policy ID"),
            PolicySpec::deny_all(),
        ),
    ]
    .into_iter()
    .map(|(policy_id, spec)| {
        let revision = policy_revision(policy_id.clone(), BUILTIN_REVISION, spec);
        ((policy_id, BUILTIN_REVISION), revision)
    })
    .collect()
}

pub fn policy_revision(policy_id: PolicyId, revision: u64, spec: PolicySpec) -> PolicyRevision {
    let canonical = serde_json::to_vec(&spec).expect("PolicySpec serialization");
    let digest = format!("sha256:{:x}", Sha256::digest(canonical));
    PolicyRevision {
        policy_id,
        revision,
        spec,
        digest,
    }
}

pub type SharedRepository<R> = Arc<R>;
