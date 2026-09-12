use std::{
    collections::HashMap,
    net::{Ipv4Addr, SocketAddrV4},
    sync::{
        Arc, Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, SystemTime},
};

use async_trait::async_trait;
use serde::Serialize;
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::{
    dataplane::{AgentRoute, DataPlaneEngine, NetworkSnapshot, RouteGate},
    domain::{
        AgentId, AgentNetwork, AttachmentState, NetworkState, PolicyAssignment, PolicyId,
        PolicyRevision, RuntimeAttachment,
    },
    policy::{CompiledPolicy, PolicySpec},
    repository::{Repository, RepositoryError},
};

#[derive(Clone, Debug)]
pub struct ControlConfig {
    pub advertised_udp_endpoint: SocketAddrV4,
    pub resolver_ipv4: Ipv4Addr,
    pub max_flows: usize,
    pub max_agent_flows: usize,
    pub flow_idle: Duration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RuntimeNetworkAttachment {
    pub agent_id: AgentId,
    pub tunnel_ipv4: Ipv4Addr,
    pub resolver_ipv4: Ipv4Addr,
    pub egress_endpoint: SocketAddrV4,
    pub state: NetworkState,
    pub network_resource_version: u64,
    pub attachment_state: AttachmentState,
    pub attachment_resource_version: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ServiceStatus {
    pub status: &'static str,
    pub data_plane_ready: bool,
    pub control_plane_ready: bool,
    pub snapshot_revision: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HealthMetricsSnapshot {
    pub service_ready: bool,
    pub data_plane_ready: bool,
    pub control_plane_ready: bool,
    pub fenced_agents: usize,
    pub transitions: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct SweepReport {
    pub examined: usize,
    pub removed: usize,
    pub cleanup_failures: usize,
}

#[derive(Default)]
struct ServiceHealth {
    data_plane_ready: AtomicBool,
    repository_ready: AtomicBool,
    snapshot_revision: AtomicU64,
    transitions: AtomicU64,
}

impl ServiceHealth {
    fn snapshot(&self) -> ServiceStatus {
        let data_plane_ready = self.data_plane_ready.load(Ordering::Acquire);
        let control_plane_ready = self.repository_ready.load(Ordering::Acquire);
        ServiceStatus {
            status: if data_plane_ready && control_plane_ready {
                "ready"
            } else {
                "degraded"
            },
            data_plane_ready,
            control_plane_ready,
            snapshot_revision: self.snapshot_revision.load(Ordering::Acquire),
        }
    }

    fn recovered(&self) {
        self.snapshot_revision.fetch_add(1, Ordering::AcqRel);
        self.transition(
            "repository",
            &self.repository_ready,
            true,
            "recovery_completed",
        );
        self.transition(
            "data_plane",
            &self.data_plane_ready,
            true,
            "recovery_completed",
        );
    }

    fn snapshot_published(&self) {
        self.snapshot_revision.fetch_add(1, Ordering::AcqRel);
    }

    fn repository_available(&self, available: bool) {
        self.transition(
            "repository",
            &self.repository_ready,
            available,
            if available {
                "repository_available"
            } else {
                "repository_unavailable"
            },
        );
    }

    fn metrics(&self, fenced_agents: usize) -> HealthMetricsSnapshot {
        let status = self.snapshot();
        HealthMetricsSnapshot {
            service_ready: status.status == "ready",
            data_plane_ready: status.data_plane_ready,
            control_plane_ready: status.control_plane_ready,
            fenced_agents,
            transitions: self.transitions.load(Ordering::Acquire),
        }
    }

    fn transition(
        &self,
        component: &'static str,
        flag: &AtomicBool,
        available: bool,
        reason: &'static str,
    ) {
        let previous = flag.swap(available, Ordering::AcqRel);
        if previous == available {
            return;
        }
        let transition = self.transitions.fetch_add(1, Ordering::AcqRel) + 1;
        tracing::info!(
            lifecycle.event = "health_transition",
            health.component = component,
            health.from = availability(previous),
            health.to = availability(available),
            health.reason = reason,
            health.transition = transition,
            snapshot_revision = self.snapshot_revision.load(Ordering::Acquire),
            "Runtime Egress health changed"
        );
    }
}

const fn availability(available: bool) -> &'static str {
    if available {
        "available"
    } else {
        "unavailable"
    }
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ControlError {
    #[error("Agent network was not found")]
    AgentNetworkNotFound,
    #[error("Agent network is unavailable")]
    AgentNetworkUnavailable,
    #[error("address pool is exhausted")]
    AddressPoolExhausted,
    #[error("policy revision was not found")]
    PolicyRevisionNotFound,
    #[error("policy revision key has different content")]
    PolicyRevisionConflict,
    #[error("policy assignment resource version changed")]
    ResourceVersionConflict,
    #[error("data-plane cleanup failed")]
    CleanupFailed(#[source] FailureContext),
    #[error("control operation failed")]
    OperationFailed(#[source] FailureContext),
    #[error("control plane is unavailable")]
    ControlPlaneUnavailable(#[source] FailureContext),
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("{stage}: {cause}")]
pub struct FailureContext {
    pub stage: &'static str,
    pub cause: &'static str,
    #[source]
    source: Option<Arc<FailureSource>>,
}

#[derive(Clone, Debug, Error, Eq, PartialEq)]
enum FailureSource {
    #[error("repository operation failed; raw detail omitted")]
    Repository(#[source] RepositoryError),
    #[error("kernel cleanup failed; raw detail omitted")]
    Kernel(String),
}

impl FailureContext {
    pub const fn new(stage: &'static str, cause: &'static str) -> Self {
        Self {
            stage,
            cause,
            source: None,
        }
    }

    pub fn with_kernel_source(mut self, source: String) -> Self {
        self.source = Some(Arc::new(FailureSource::Kernel(source)));
        self
    }

    fn with_repository_source(mut self, source: RepositoryError) -> Self {
        self.source = Some(Arc::new(FailureSource::Repository(source)));
        self
    }
}

impl ControlError {
    pub fn diagnostic(&self) -> Option<FailureContext> {
        match self {
            Self::CleanupFailed(context)
            | Self::OperationFailed(context)
            | Self::ControlPlaneUnavailable(context) => Some(context.clone()),
            _ => None,
        }
    }

    fn repository(stage: &'static str, error: RepositoryError) -> Self {
        match error {
            RepositoryError::AddressPoolExhausted => Self::AddressPoolExhausted,
            RepositoryError::AgentNetworkNotFound => Self::AgentNetworkNotFound,
            RepositoryError::AgentNetworkUnavailable => Self::AgentNetworkUnavailable,
            RepositoryError::PolicyRevisionNotFound => Self::PolicyRevisionNotFound,
            RepositoryError::PolicyRevisionConflict => Self::PolicyRevisionConflict,
            RepositoryError::ResourceVersionConflict => Self::ResourceVersionConflict,
            error @ RepositoryError::InvalidPool(_) => Self::ControlPlaneUnavailable(
                FailureContext::new(stage, "repository_invalid_pool").with_repository_source(error),
            ),
            error @ (RepositoryError::ConnectionUnavailable(_)
            | RepositoryError::DatabaseConnection(_)) => Self::ControlPlaneUnavailable(
                FailureContext::new(stage, "repository_connection_unavailable")
                    .with_repository_source(error),
            ),
            error @ (RepositoryError::OperationFailed(_)
            | RepositoryError::DatabaseOperation(_)
            | RepositoryError::OperationTimedOut) => {
                let cause = if matches!(error, RepositoryError::OperationTimedOut) {
                    "repository_operation_timeout"
                } else {
                    "repository_operation_failed"
                };
                Self::OperationFailed(
                    FailureContext::new(stage, cause).with_repository_source(error),
                )
            }
            error @ RepositoryError::Unavailable(_) => Self::ControlPlaneUnavailable(
                FailureContext::new(stage, "repository_unavailable").with_repository_source(error),
            ),
        }
    }

    fn cleanup(stage: &'static str, source: String) -> Self {
        Self::CleanupFailed(
            FailureContext::new(stage, "kernel_command_failed").with_kernel_source(source),
        )
    }
}

#[async_trait]
pub trait KernelCleanup: Send + Sync + 'static {
    async fn clear_agent(&self, address: Ipv4Addr) -> Result<(), String>;
}

#[derive(Default)]
struct AgentOperations {
    locks: AsyncMutex<HashMap<AgentId, Weak<AsyncMutex<()>>>>,
}

impl AgentOperations {
    async fn lock(&self, agent_id: &AgentId) -> OwnedMutexGuard<()> {
        let mut locks = self.locks.lock().await;
        locks.retain(|_, lock| lock.strong_count() > 0);
        let lock = locks
            .get(agent_id)
            .and_then(Weak::upgrade)
            .unwrap_or_else(|| {
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(agent_id.clone(), Arc::downgrade(&lock));
                lock
            });
        drop(locks);
        lock.lock_owned().await
    }
}

pub struct ControlService<R, K> {
    repository: Arc<R>,
    kernel: Arc<K>,
    config: ControlConfig,
    dataplane: Arc<Mutex<DataPlaneEngine>>,
    output_barrier: Arc<AsyncMutex<()>>,
    operations: AgentOperations,
    applied_assignments: AsyncMutex<HashMap<AgentId, u64>>,
    health: ServiceHealth,
}

impl<R, K> ControlService<R, K>
where
    R: Repository,
    K: KernelCleanup,
{
    pub fn new(repository: Arc<R>, kernel: Arc<K>, config: ControlConfig) -> Self {
        Self {
            repository,
            kernel,
            dataplane: Arc::new(Mutex::new(DataPlaneEngine::new(
                NetworkSnapshot::default(),
                crate::packet::INNER_MTU,
                config.max_flows,
                config.max_agent_flows,
                config.flow_idle,
            ))),
            config,
            output_barrier: Arc::new(AsyncMutex::new(())),
            operations: AgentOperations::default(),
            applied_assignments: AsyncMutex::new(HashMap::new()),
            health: ServiceHealth::default(),
        }
    }

    pub fn status(&self) -> ServiceStatus {
        self.health.snapshot()
    }

    pub fn health_metrics(&self) -> HealthMetricsSnapshot {
        let fenced_agents = self
            .dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .fenced_agent_count();
        self.health.metrics(fenced_agents)
    }

    pub fn observe_control_result<T>(&self, result: &Result<T, ControlError>) {
        match result {
            Ok(_) => {}
            Err(ControlError::CleanupFailed(context)) => {
                tracing::warn!(
                    lifecycle.event = "agent_operation_degraded",
                    failure.stage = context.stage,
                    failure.cause = context.cause,
                    "Agent remains fenced after cleanup failure"
                );
            }
            Err(ControlError::OperationFailed(context)) => {
                tracing::warn!(
                    lifecycle.event = "control_operation_failed",
                    failure.stage = context.stage,
                    failure.cause = context.cause,
                    "Runtime Egress control operation failed without degrading shared health"
                );
            }
            Err(ControlError::ControlPlaneUnavailable(context)) => {
                tracing::warn!(
                    lifecycle.event = "control_operation_unavailable",
                    failure.stage = context.stage,
                    failure.cause = context.cause,
                    "Runtime Egress control operation was unavailable; repository health remains authoritative"
                );
            }
            Err(_) => {}
        }
    }

    pub fn observe_repository_health(&self, available: bool) {
        self.health.repository_available(available);
    }

    pub fn dataplane(&self) -> Arc<Mutex<DataPlaneEngine>> {
        self.dataplane.clone()
    }

    pub fn output_barrier(&self) -> Arc<AsyncMutex<()>> {
        self.output_barrier.clone()
    }

    pub async fn ensure_agent_network(
        &self,
        agent_id: AgentId,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        let _guard = self.operations.lock(&agent_id).await;
        let network = self
            .repository
            .ensure_agent_network(agent_id.clone())
            .await
            .map_err(|error| ControlError::repository("ensure_agent_network.repository", error))?;
        let attachment = self
            .repository
            .runtime_attachment(&agent_id)
            .await
            .map_err(|error| ControlError::repository("ensure_agent_network.repository", error))?;
        let assignment = self
            .repository
            .policy_assignment(&agent_id)
            .await
            .map_err(|error| ControlError::repository("ensure_agent_network.repository", error))?;
        if attachment.state == AttachmentState::Closed {
            self.fence_dataplane(agent_id.clone()).await;
            self.publish_route(&network, &assignment, RouteGate::ProbeOnly)
                .await?;
            self.applied_assignments.lock().await.remove(&agent_id);
            return Ok(self.attachment(network, attachment));
        }
        let was_fenced = self
            .dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .is_agent_fenced(&agent_id);
        let already_applied = self
            .applied_assignments
            .lock()
            .await
            .get(&agent_id)
            .is_some_and(|version| *version == assignment.resource_version);
        if was_fenced || !already_applied {
            self.fence_dataplane(agent_id.clone()).await;
            self.reset_flows_and_kernel(
                &agent_id,
                network.tunnel_ipv4,
                "ensure_agent_network.open_cleanup",
            )
            .await?;
            self.publish_route(&network, &assignment, RouteGate::Open)
                .await?;
            self.applied_assignments
                .lock()
                .await
                .insert(agent_id.clone(), assignment.resource_version);
        }
        Ok(self.attachment(network, attachment))
    }

    pub async fn agent_network(
        &self,
        agent_id: &AgentId,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        let network = self
            .repository
            .agent_network(agent_id)
            .await
            .map_err(|error| ControlError::repository("agent_network.repository", error))?;
        let attachment = self
            .repository
            .runtime_attachment(agent_id)
            .await
            .map_err(|error| ControlError::repository("agent_network.repository", error))?;
        Ok(self.attachment(network, attachment))
    }

    pub async fn set_runtime_attachment(
        &self,
        agent_id: AgentId,
        desired: AttachmentState,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        if expected_resource_version == 0 {
            return Err(ControlError::ResourceVersionConflict);
        }
        let _guard = self.operations.lock(&agent_id).await;
        let network = self
            .repository
            .agent_network(&agent_id)
            .await
            .map_err(|error| {
                ControlError::repository("set_runtime_attachment.repository", error)
            })?;
        if network.state != NetworkState::Active {
            return Err(ControlError::AgentNetworkUnavailable);
        }
        let current = self
            .repository
            .runtime_attachment(&agent_id)
            .await
            .map_err(|error| {
                ControlError::repository("set_runtime_attachment.repository", error)
            })?;
        if !attachment_request_matches(&current, desired, expected_resource_version) {
            return Err(ControlError::ResourceVersionConflict);
        }

        let attachment = match desired {
            AttachmentState::Closed => {
                if current.state != AttachmentState::Closed {
                    self.fence_dataplane(agent_id.clone()).await;
                    self.reset_flows_and_kernel(
                        &agent_id,
                        network.tunnel_ipv4,
                        "set_runtime_attachment.close_cleanup",
                    )
                    .await?;
                }
                let attachment = self
                    .repository
                    .compare_and_swap_attachment(&agent_id, desired, expected_resource_version)
                    .await
                    .map_err(|error| {
                        ControlError::repository("set_runtime_attachment.repository", error)
                    })?;
                let assignment =
                    self.repository
                        .policy_assignment(&agent_id)
                        .await
                        .map_err(|error| {
                            ControlError::repository("set_runtime_attachment.repository", error)
                        })?;
                self.publish_route(&network, &assignment, RouteGate::ProbeOnly)
                    .await?;
                self.applied_assignments.lock().await.remove(&agent_id);
                attachment
            }
            AttachmentState::Open => {
                self.fence_dataplane(agent_id.clone()).await;
                self.reset_flows_and_kernel(
                    &agent_id,
                    network.tunnel_ipv4,
                    "set_runtime_attachment.open_cleanup",
                )
                .await?;
                let attachment = self
                    .repository
                    .compare_and_swap_attachment(&agent_id, desired, expected_resource_version)
                    .await
                    .map_err(|error| {
                        ControlError::repository("set_runtime_attachment.repository", error)
                    })?;
                let assignment =
                    self.repository
                        .policy_assignment(&agent_id)
                        .await
                        .map_err(|error| {
                            ControlError::repository("set_runtime_attachment.repository", error)
                        })?;
                self.publish_route(&network, &assignment, RouteGate::Open)
                    .await?;
                self.applied_assignments
                    .lock()
                    .await
                    .insert(agent_id.clone(), assignment.resource_version);
                attachment
            }
        };
        Ok(self.attachment(network, attachment))
    }

    pub async fn put_policy_revision(
        &self,
        policy_id: PolicyId,
        revision: u64,
        spec: PolicySpec,
    ) -> Result<PolicyRevision, ControlError> {
        if revision == 0 {
            return Err(ControlError::PolicyRevisionConflict);
        }
        self.repository
            .put_policy_revision(policy_id, revision, spec)
            .await
            .map_err(|error| ControlError::repository("put_policy_revision.repository", error))
    }

    pub async fn policy_assignment(
        &self,
        agent_id: &AgentId,
    ) -> Result<PolicyAssignment, ControlError> {
        self.repository
            .policy_assignment(agent_id)
            .await
            .map_err(|error| ControlError::repository("policy_assignment.repository", error))
    }

    pub async fn policy_revision(
        &self,
        policy_id: &PolicyId,
        revision: u64,
    ) -> Result<PolicyRevision, ControlError> {
        self.repository
            .policy_revision(policy_id, revision)
            .await
            .map_err(|error| ControlError::repository("policy_revision.repository", error))
    }

    pub async fn assign_policy(
        &self,
        agent_id: AgentId,
        policy_id: PolicyId,
        revision: u64,
        expected_resource_version: u64,
    ) -> Result<PolicyAssignment, ControlError> {
        let _guard = self.operations.lock(&agent_id).await;
        let policy = self
            .repository
            .policy_revision(&policy_id, revision)
            .await
            .map_err(|error| ControlError::repository("assign_policy.repository", error))?;
        let current = self
            .repository
            .policy_assignment(&agent_id)
            .await
            .map_err(|error| ControlError::repository("assign_policy.repository", error))?;
        if !assignment_request_matches(&current, &policy_id, revision, expected_resource_version) {
            return Err(ControlError::ResourceVersionConflict);
        }
        let attachment = self
            .repository
            .runtime_attachment(&agent_id)
            .await
            .map_err(|error| ControlError::repository("assign_policy.repository", error))?;
        let network = self
            .repository
            .agent_network(&agent_id)
            .await
            .map_err(|error| ControlError::repository("assign_policy.repository", error))?;
        if network.state != NetworkState::Active {
            return Err(ControlError::AgentNetworkUnavailable);
        }
        if attachment.state == AttachmentState::Open
            && current.policy_id == policy_id
            && current.revision == revision
            && self
                .assignment_is_active(&agent_id, current.resource_version)
                .await
        {
            return self
                .repository
                .compare_and_swap_assignment(
                    &agent_id,
                    policy_id,
                    revision,
                    expected_resource_version,
                )
                .await
                .map_err(|error| ControlError::repository("assign_policy.repository", error));
        }
        let compiled_policy = policy.spec.compile(self.config.resolver_ipv4);
        if attachment.state == AttachmentState::Closed {
            let assignment = self
                .repository
                .compare_and_swap_assignment(
                    &agent_id,
                    policy_id,
                    revision,
                    expected_resource_version,
                )
                .await
                .map_err(|error| ControlError::repository("assign_policy.repository", error))?;
            self.fence_dataplane(agent_id.clone()).await;
            self.replace_route(&network, &assignment, compiled_policy, RouteGate::ProbeOnly);
            self.applied_assignments.lock().await.remove(&agent_id);
            return Ok(assignment);
        }
        self.fence_dataplane(agent_id.clone()).await;
        self.reset_flows_and_kernel(
            &agent_id,
            network.tunnel_ipv4,
            "assign_policy.kernel_cleanup",
        )
        .await?;
        let assignment = self
            .repository
            .compare_and_swap_assignment(&agent_id, policy_id, revision, expected_resource_version)
            .await
            .map_err(|error| ControlError::repository("assign_policy.repository", error))?;
        self.replace_route(&network, &assignment, compiled_policy, RouteGate::Open);
        self.applied_assignments
            .lock()
            .await
            .insert(agent_id.clone(), assignment.resource_version);
        Ok(assignment)
    }

    async fn assignment_is_active(&self, agent_id: &AgentId, version: u64) -> bool {
        let applied = self.applied_assignments.lock().await.get(agent_id).copied() == Some(version);
        applied
            && !self
                .dataplane
                .lock()
                .expect("data-plane mutex poisoned")
                .is_agent_fenced(agent_id)
    }

    pub async fn release_agent_network(
        &self,
        agent_id: AgentId,
        expected_resource_version: u64,
    ) -> Result<RuntimeNetworkAttachment, ControlError> {
        if expected_resource_version == 0 {
            return Err(ControlError::ResourceVersionConflict);
        }
        let _guard = self.operations.lock(&agent_id).await;
        let attachment = self
            .repository
            .runtime_attachment(&agent_id)
            .await
            .map_err(|error| ControlError::repository("release_agent_network.repository", error))?;
        if attachment.state != AttachmentState::Closed {
            return Err(ControlError::AgentNetworkUnavailable);
        }
        let network = self
            .repository
            .quarantine_agent_network(&agent_id, expected_resource_version, SystemTime::now())
            .await
            .map_err(|error| ControlError::repository("release_agent_network.repository", error))?;
        self.fence_dataplane(agent_id.clone()).await;
        self.dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .remove_agent(&agent_id);
        self.health.snapshot_published();
        self.applied_assignments.lock().await.remove(&agent_id);
        self.kernel
            .clear_agent(network.tunnel_ipv4)
            .await
            .map_err(|error| {
                ControlError::cleanup("release_agent_network.kernel_cleanup", error)
            })?;
        Ok(self.attachment(network, attachment))
    }

    pub async fn recover(&self) -> Result<usize, ControlError> {
        let bindings = self
            .repository
            .active_bindings()
            .await
            .map_err(|error| ControlError::repository("recover.repository", error))?;
        let routes = bindings.iter().map(|binding| AgentRoute {
            agent_id: binding.network.agent_id.clone(),
            tunnel_ipv4: binding.network.tunnel_ipv4,
            assignment_version: binding.assignment.resource_version,
            policy: binding.revision.spec.compile(self.config.resolver_ipv4),
            gate: route_gate(binding.attachment.state),
        });
        self.dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .replace_snapshot(NetworkSnapshot::from_routes(routes));
        let mut applied = self.applied_assignments.lock().await;
        applied.clear();
        applied.extend(
            bindings
                .iter()
                .filter(|binding| binding.attachment.state == AttachmentState::Open)
                .map(|binding| {
                    (
                        binding.network.agent_id.clone(),
                        binding.assignment.resource_version,
                    )
                }),
        );
        self.health.recovered();
        Ok(bindings.len())
    }

    pub async fn sweep_quarantine(&self, now: SystemTime) -> Result<SweepReport, ControlError> {
        let candidates = self
            .repository
            .expired_quarantines(now)
            .await
            .map_err(|error| ControlError::repository("sweep_quarantine.repository", error))?;
        let mut report = SweepReport {
            examined: candidates.len(),
            ..SweepReport::default()
        };
        for network in candidates {
            let _guard = self.operations.lock(&network.agent_id).await;
            self.fence_dataplane(network.agent_id.clone()).await;
            if let Err(error) = self.kernel.clear_agent(network.tunnel_ipv4).await {
                report.cleanup_failures += 1;
                log_cleanup_failure(&network.agent_id, "sweep_quarantine.kernel_cleanup", &error);
                continue;
            }
            if self
                .repository
                .delete_quarantined(&network.agent_id, network.resource_version)
                .await
                .map_err(|error| ControlError::repository("sweep_quarantine.repository", error))?
            {
                self.dataplane
                    .lock()
                    .expect("data-plane mutex poisoned")
                    .remove_agent(&network.agent_id);
                self.health.snapshot_published();
                self.applied_assignments
                    .lock()
                    .await
                    .remove(&network.agent_id);
                report.removed += 1;
            }
        }
        Ok(report)
    }

    async fn publish_route(
        &self,
        network: &AgentNetwork,
        assignment: &PolicyAssignment,
        gate: RouteGate,
    ) -> Result<(), ControlError> {
        let revision = self
            .repository
            .policy_revision(&assignment.policy_id, assignment.revision)
            .await
            .map_err(|error| ControlError::repository("publish_route.repository", error))?;
        let policy = revision.spec.compile(self.config.resolver_ipv4);
        self.replace_route(network, assignment, policy, gate);
        Ok(())
    }

    fn replace_route(
        &self,
        network: &AgentNetwork,
        assignment: &PolicyAssignment,
        policy: CompiledPolicy,
        gate: RouteGate,
    ) {
        self.dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .upsert_route(AgentRoute {
                agent_id: network.agent_id.clone(),
                tunnel_ipv4: network.tunnel_ipv4,
                assignment_version: assignment.resource_version,
                policy,
                gate,
            });
        self.health.snapshot_published();
    }

    async fn reset_flows_and_kernel(
        &self,
        agent_id: &AgentId,
        address: Ipv4Addr,
        stage: &'static str,
    ) -> Result<(), ControlError> {
        self.dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .reset_agent_flows(agent_id);
        self.kernel
            .clear_agent(address)
            .await
            .map_err(|error| ControlError::cleanup(stage, error))
    }

    async fn fence_dataplane(&self, agent_id: AgentId) {
        self.dataplane
            .lock()
            .expect("data-plane mutex poisoned")
            .fence_agent(agent_id);
        let _drained = self.output_barrier.lock().await;
    }

    fn attachment(
        &self,
        network: AgentNetwork,
        attachment: RuntimeAttachment,
    ) -> RuntimeNetworkAttachment {
        RuntimeNetworkAttachment {
            agent_id: network.agent_id,
            tunnel_ipv4: network.tunnel_ipv4,
            resolver_ipv4: self.config.resolver_ipv4,
            egress_endpoint: self.config.advertised_udp_endpoint,
            state: network.state,
            network_resource_version: network.resource_version,
            attachment_state: attachment.state,
            attachment_resource_version: attachment.resource_version,
        }
    }
}

fn attachment_request_matches(
    current: &RuntimeAttachment,
    desired: AttachmentState,
    expected_resource_version: u64,
) -> bool {
    if current.state != desired {
        return current.resource_version == expected_resource_version;
    }
    current.resource_version == expected_resource_version
        || expected_resource_version
            .checked_add(1)
            .is_some_and(|version| version == current.resource_version)
}

fn assignment_request_matches(
    current: &PolicyAssignment,
    policy_id: &PolicyId,
    revision: u64,
    expected_resource_version: u64,
) -> bool {
    if current.policy_id != *policy_id || current.revision != revision {
        return current.resource_version == expected_resource_version;
    }
    current.resource_version == expected_resource_version
        || expected_resource_version
            .checked_add(1)
            .is_some_and(|version| version == current.resource_version)
}

const fn route_gate(state: AttachmentState) -> RouteGate {
    match state {
        AttachmentState::Open => RouteGate::Open,
        AttachmentState::Closed => RouteGate::ProbeOnly,
    }
}

fn log_cleanup_failure(agent_id: &AgentId, stage: &'static str, _detail: &str) {
    tracing::warn!(
        lifecycle.event = "agent_cleanup_failed",
        "antnest.agent.id" = agent_id.as_str(),
        failure.stage = stage,
        failure.cause = "kernel_command_failed",
        "Agent kernel cleanup failed"
    );
}

#[cfg(test)]
mod tests {
    use super::{AgentId, AgentOperations};

    #[tokio::test]
    async fn operation_lock_registry_prunes_inactive_agents() {
        let operations = AgentOperations::default();
        let first = AgentId::parse("agent-first").unwrap();
        let second = AgentId::parse("agent-second").unwrap();

        drop(operations.lock(&first).await);
        drop(operations.lock(&second).await);

        let locks = operations.locks.lock().await;
        assert_eq!(locks.len(), 1);
        assert!(locks.contains_key(&second));
    }
}
