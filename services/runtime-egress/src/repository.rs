use std::{
    collections::{HashMap, HashSet},
    fmt::Write as _,
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
        ActiveBinding, AgentId, AgentNetwork, AttachmentState, NetworkState, PolicyAssignment,
        PolicyId, PolicyRevision, RuntimeAttachment,
    },
    policy::PolicySpec,
};

mod observation;
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
    #[error("Runtime peer does not match attachment state")]
    InvalidRuntimeEndpoint,
    #[error("database connection is unavailable; raw detail omitted")]
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
    #[error("repository is unavailable; raw detail omitted")]
    Unavailable(String),
    #[error("repository operation failed; raw detail omitted")]
    OperationFailed(String),
    #[error("database connection failed")]
    DatabaseConnection(#[source] DriverError),
    #[error("database operation failed")]
    DatabaseOperation(#[source] DriverError),
    #[error("database operation exceeded its configured deadline")]
    OperationTimedOut,
}

#[derive(Clone, Debug)]
pub struct DriverError {
    source: Arc<tokio_postgres::Error>,
}

impl std::fmt::Display for DriverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PostgreSQL driver failure; raw detail omitted")
    }
}

impl std::error::Error for DriverError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(self.source.as_ref())
    }
}

impl DriverError {
    pub(crate) fn new(source: tokio_postgres::Error) -> Self {
        Self {
            source: Arc::new(source),
        }
    }
}

impl PartialEq for DriverError {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.source, &other.source)
    }
}
impl Eq for DriverError {}

impl RepositoryError {
    pub(crate) fn is_connection_failure(&self) -> bool {
        matches!(
            self,
            Self::ConnectionUnavailable(_) | Self::DatabaseConnection(_)
        )
    }
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

    async fn runtime_attachment(
        &self,
        agent_id: &AgentId,
    ) -> Result<RuntimeAttachment, RepositoryError>;

    async fn compare_and_swap_attachment(
        &self,
        agent_id: &AgentId,
        state: AttachmentState,
        expected_resource_version: u64,
        runtime_endpoint: Option<Ipv4Addr>,
    ) -> Result<RuntimeAttachment, RepositoryError>;

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
        expected_resource_version: u64,
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
    attachments: HashMap<AgentId, RuntimeAttachment>,
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
                attachments: HashMap::new(),
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
        let attachment = RuntimeAttachment {
            agent_id: agent_id.clone(),
            state: AttachmentState::Closed,
            resource_version: 1,
            runtime_endpoint: None,
        };
        state.networks.insert(agent_id.clone(), network.clone());
        state.assignments.insert(agent_id.clone(), assignment);
        state.attachments.insert(agent_id, attachment);
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

    async fn runtime_attachment(
        &self,
        agent_id: &AgentId,
    ) -> Result<RuntimeAttachment, RepositoryError> {
        self.state
            .lock()
            .await
            .attachments
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)
    }

    async fn compare_and_swap_attachment(
        &self,
        agent_id: &AgentId,
        desired: AttachmentState,
        expected_resource_version: u64,
        runtime_endpoint: Option<Ipv4Addr>,
    ) -> Result<RuntimeAttachment, RepositoryError> {
        if !crate::domain::valid_runtime_endpoint(desired, runtime_endpoint) {
            return Err(RepositoryError::InvalidRuntimeEndpoint);
        }
        let mut state = self.state.lock().await;
        let network = state
            .networks
            .get(agent_id)
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if network.state != NetworkState::Active {
            return Err(RepositoryError::AgentNetworkUnavailable);
        }
        let current = state
            .attachments
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if current.state == desired && current.runtime_endpoint == runtime_endpoint {
            return if retry_version_matches(current.resource_version, expected_resource_version) {
                Ok(current)
            } else {
                Err(RepositoryError::ResourceVersionConflict)
            };
        }
        if current.resource_version != expected_resource_version {
            return Err(RepositoryError::ResourceVersionConflict);
        }
        let attachment = RuntimeAttachment {
            agent_id: agent_id.clone(),
            state: desired,
            resource_version: current.resource_version + 1,
            runtime_endpoint,
        };
        state
            .attachments
            .insert(agent_id.clone(), attachment.clone());
        Ok(attachment)
    }

    async fn compare_and_swap_assignment(
        &self,
        agent_id: &AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, RepositoryError> {
        let mut state = self.state.lock().await;
        let network = state
            .networks
            .get(agent_id)
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if network.state != NetworkState::Active {
            return Err(RepositoryError::AgentNetworkUnavailable);
        }
        if !state.revisions.contains_key(&(policy_id.clone(), revision)) {
            return Err(RepositoryError::PolicyRevisionNotFound);
        }
        let current = state
            .assignments
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if current.policy_id == policy_id && current.revision == revision {
            return if retry_version_matches(current.resource_version, expected_resource_version) {
                Ok(current)
            } else {
                Err(RepositoryError::ResourceVersionConflict)
            };
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
        expected_resource_version: u64,
        now: SystemTime,
    ) -> Result<AgentNetwork, RepositoryError> {
        let mut state = self.state.lock().await;
        let quarantine = state.config.quarantine;
        let current = state
            .networks
            .get(agent_id)
            .cloned()
            .ok_or(RepositoryError::AgentNetworkNotFound)?;
        if current.state == NetworkState::Quarantined {
            return if retry_version_matches(current.resource_version, expected_resource_version) {
                Ok(current)
            } else {
                Err(RepositoryError::ResourceVersionConflict)
            };
        }
        if current.resource_version != expected_resource_version {
            return Err(RepositoryError::ResourceVersionConflict);
        }
        if state
            .attachments
            .get(agent_id)
            .is_none_or(|attachment| attachment.state != AttachmentState::Closed)
        {
            return Err(RepositoryError::AgentNetworkUnavailable);
        }
        let network = state
            .networks
            .get_mut(agent_id)
            .expect("validated Agent network exists");
        network.state = NetworkState::Quarantined;
        network.resource_version += 1;
        network.quarantine_until = Some(now + quarantine);
        Ok(network.clone())
    }

    async fn active_bindings(&self) -> Result<Vec<ActiveBinding>, RepositoryError> {
        let state = self.state.lock().await;
        let mut bindings = Vec::new();
        for network in state
            .networks
            .values()
            .filter(|network| network.state == NetworkState::Active)
        {
            let attachment = state
                .attachments
                .get(&network.agent_id)
                .cloned()
                .ok_or(RepositoryError::AgentNetworkNotFound)?;
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
            bindings.push(ActiveBinding {
                network: network.clone(),
                attachment,
                assignment,
                revision,
            });
        }
        Ok(bindings)
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
        state.attachments.remove(agent_id);
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

fn content_digest(bytes: &[u8]) -> String {
    let mut digest = String::with_capacity(71);
    digest.push_str("sha256:");
    for byte in Sha256::digest(bytes) {
        write!(digest, "{byte:02x}").expect("writing to String is infallible");
    }
    digest
}

pub fn policy_revision(policy_id: PolicyId, revision: u64, spec: PolicySpec) -> PolicyRevision {
    let canonical = serde_json::to_vec(&spec).expect("PolicySpec serialization");
    let digest = content_digest(&canonical);
    PolicyRevision {
        policy_id,
        revision,
        spec,
        digest,
    }
}

fn retry_version_matches(current: u64, expected: u64) -> bool {
    current == expected
        || expected
            .checked_add(1)
            .is_some_and(|version| version == current)
}

pub type SharedRepository<R> = Arc<R>;

#[cfg(test)]
mod digest_tests {
    use super::*;

    #[test]
    fn published_policy_digests_remain_stable_across_sdk_upgrades() {
        for (policy, spec, expected) in [
            (
                BUILTIN_ALLOW_ALL,
                PolicySpec::allow_all(),
                "sha256:5171cd901b624f9a6dcf7a750e0030741cb9476dcc4a9b74405dcd2ef0065ea8",
            ),
            (
                BUILTIN_DENY_ALL,
                PolicySpec::deny_all(),
                "sha256:d9a620482e1aff562a27f3d76c9a40b3c9223e9f1a2bf184e068f627e98a7755",
            ),
        ] {
            assert_eq!(
                policy_revision(PolicyId::parse(policy).unwrap(), BUILTIN_REVISION, spec).digest,
                expected
            );
        }
    }
}
