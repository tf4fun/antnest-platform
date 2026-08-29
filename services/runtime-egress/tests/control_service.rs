use std::{
    net::{Ipv4Addr, SocketAddrV4},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime},
};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlError, ControlService, FailureContext, KernelCleanup},
    domain::{AgentId, NetworkState, PolicyId},
    policy::PolicySpec,
    repository::{InMemoryRepository, RepositoryConfig},
};
use async_trait::async_trait;

#[derive(Default)]
struct RecordingKernel {
    cleared: Mutex<Vec<Ipv4Addr>>,
}

#[derive(Default)]
struct ToggleKernel {
    fail_next: AtomicBool,
    calls: AtomicUsize,
}

#[async_trait]
impl KernelCleanup for ToggleKernel {
    async fn clear_agent(&self, _: Ipv4Addr) -> Result<(), String> {
        self.calls.fetch_add(1, Ordering::AcqRel);
        if self.fail_next.swap(false, Ordering::AcqRel) {
            Err("injected cleanup failure".to_owned())
        } else {
            Ok(())
        }
    }
}

#[tokio::test]
async fn ensure_reconciles_cleanup_before_reopening_a_fenced_agent() {
    let repository = Arc::new(
        InMemoryRepository::new(RepositoryConfig {
            pool_id: "default".to_owned(),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        })
        .unwrap(),
    );
    let kernel = Arc::new(ToggleKernel::default());
    let service = ControlService::new(
        repository,
        kernel.clone(),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    );
    let agent = AgentId::parse("agent-reconcile").unwrap();
    service.ensure_agent_network(agent.clone()).await.unwrap();

    kernel.fail_next.store(true, Ordering::Release);
    assert_eq!(
        service.reset_agent_flows(&agent).await,
        Err(ControlError::CleanupFailed(FailureContext::new(
            "reset_agent_flows.kernel_cleanup",
            "kernel_command_failed",
        )))
    );
    assert!(service.dataplane().lock().unwrap().is_agent_fenced(&agent));

    service.ensure_agent_network(agent.clone()).await.unwrap();

    assert_eq!(kernel.calls.load(Ordering::Acquire), 2);
    assert!(!service.dataplane().lock().unwrap().is_agent_fenced(&agent));
}

#[async_trait]
impl KernelCleanup for RecordingKernel {
    async fn clear_agent(&self, address: Ipv4Addr) -> Result<(), String> {
        self.cleared.lock().unwrap().push(address);
        Ok(())
    }
}

fn service() -> (
    ControlService<InMemoryRepository, RecordingKernel>,
    Arc<RecordingKernel>,
) {
    let repository = InMemoryRepository::new(RepositoryConfig {
        pool_id: "default".to_owned(),
        tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
        resolver_ipv4: "100.64.0.1".parse().unwrap(),
        quarantine: Duration::from_secs(300),
    })
    .unwrap();
    let kernel = Arc::new(RecordingKernel::default());
    let control = ControlService::new(
        Arc::new(repository),
        kernel.clone(),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse::<SocketAddrV4>().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    );
    (control, kernel)
}

#[tokio::test]
async fn ensure_is_stable_and_starts_fail_closed() {
    let (service, _) = service();
    let agent = AgentId::parse("agent-1").unwrap();

    let first = service.ensure_agent_network(agent.clone()).await.unwrap();
    let second = service.ensure_agent_network(agent.clone()).await.unwrap();
    let assignment = service.policy_assignment(&agent).await.unwrap();

    assert_eq!(first, second);
    assert_eq!(first.tunnel_ipv4, "100.64.0.2".parse::<Ipv4Addr>().unwrap());
    assert_eq!(assignment.policy_id.as_str(), "builtin/deny-all");
}

#[tokio::test]
async fn assignment_is_cas_and_exact_retry_is_idempotent() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-1").unwrap();
    let policy_id = PolicyId::parse("internet-enabled").unwrap();
    service.ensure_agent_network(agent.clone()).await.unwrap();
    service
        .put_policy_revision(policy_id.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();

    let changed = service
        .assign_policy(agent.clone(), policy_id.clone(), 1, 1)
        .await
        .unwrap();
    let retried = service
        .assign_policy(agent.clone(), policy_id, 1, 1)
        .await
        .unwrap();

    assert_eq!(changed.resource_version, 2);
    assert_eq!(retried, changed);
    assert_eq!(kernel.cleared.lock().unwrap().len(), 1);
    assert_eq!(
        service
            .assign_policy(agent, PolicyId::parse("builtin/deny-all").unwrap(), 1, 1,)
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
}

#[tokio::test]
async fn release_cleans_before_entering_quarantine() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-1").unwrap();
    let network = service.ensure_agent_network(agent.clone()).await.unwrap();

    let released = service.release_agent_network(agent.clone()).await.unwrap();

    assert_eq!(released.state, NetworkState::Quarantined);
    assert_eq!(
        kernel.cleared.lock().unwrap().as_slice(),
        &[network.tunnel_ipv4]
    );
    assert_eq!(
        service.ensure_agent_network(agent).await,
        Err(ControlError::AgentNetworkUnavailable)
    );
}

#[tokio::test]
async fn quarantine_sweeper_rechecks_cleanup_before_deleting_the_allocation() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-1").unwrap();
    service.ensure_agent_network(agent.clone()).await.unwrap();
    service.release_agent_network(agent.clone()).await.unwrap();

    let removed = service
        .sweep_quarantine(SystemTime::now() + Duration::from_secs(301))
        .await
        .unwrap();

    assert_eq!(removed, 1);
    assert_eq!(kernel.cleared.lock().unwrap().len(), 2);
    assert_eq!(
        service.agent_network(&agent).await,
        Err(ControlError::AgentNetworkNotFound)
    );
}

#[tokio::test]
async fn recovery_rebuilds_the_in_memory_policy_snapshot() {
    let repository = Arc::new(
        InMemoryRepository::new(RepositoryConfig {
            pool_id: "default".to_owned(),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        })
        .unwrap(),
    );
    let kernel = Arc::new(RecordingKernel::default());
    let config = ControlConfig {
        advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
        resolver_ipv4: "100.64.0.1".parse().unwrap(),
        max_flows: 32,
        max_agent_flows: 16,
        flow_idle: Duration::from_secs(60),
    };
    let first = ControlService::new(repository.clone(), kernel.clone(), config.clone());
    let agent = AgentId::parse("agent-1").unwrap();
    first.ensure_agent_network(agent.clone()).await.unwrap();
    let policy = PolicyId::parse("internet-enabled").unwrap();
    first
        .put_policy_revision(policy.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();
    first
        .assign_policy(agent.clone(), policy, 1, 1)
        .await
        .unwrap();

    let recovered = ControlService::new(repository, kernel, config);
    assert_eq!(recovered.recover().await.unwrap(), 1);
    let route = recovered
        .dataplane()
        .lock()
        .unwrap()
        .snapshot()
        .route("100.64.0.2".parse().unwrap())
        .cloned();
    assert_eq!(
        route.unwrap().policy.decide(),
        antnest_runtime_egress::policy::Decision::Allow
    );
}

#[tokio::test]
async fn status_tracks_published_snapshots_instead_of_a_static_constant() {
    let (service, _) = service();

    assert_eq!(service.status().status, "degraded");
    assert_eq!(service.status().snapshot_revision, 0);
    service.recover().await.unwrap();
    let recovered = service.status();
    assert_eq!(recovered.status, "ready");
    assert!(recovered.data_plane_ready);
    assert!(recovered.control_plane_ready);
    assert_eq!(recovered.snapshot_revision, 1);

    service
        .ensure_agent_network(AgentId::parse("agent-observed").unwrap())
        .await
        .unwrap();
    assert_eq!(service.status().snapshot_revision, 2);
}

#[tokio::test]
async fn control_health_recovers_after_a_later_successful_operation() {
    let (service, _) = service();
    service.recover().await.unwrap();

    service.observe_control_result::<()>(&Err(ControlError::ControlPlaneUnavailable(
        FailureContext::new("test.repository", "repository_unavailable"),
    )));
    assert_eq!(service.status().status, "degraded");
    assert!(!service.status().control_plane_ready);
    assert!(service.status().data_plane_ready);

    service.observe_control_result(&Ok::<(), ControlError>(()));
    assert_eq!(service.status().status, "ready");
    assert!(service.status().control_plane_ready);

    service.observe_repository_health(false);
    service.observe_control_result(&Ok::<(), ControlError>(()));
    assert_eq!(service.status().status, "degraded");
    assert!(!service.status().control_plane_ready);

    service.observe_repository_health(true);
    assert_eq!(service.status().status, "ready");
}

#[tokio::test]
async fn cleanup_failure_keeps_only_that_agent_fenced_until_retry_completes() {
    let repository = Arc::new(
        InMemoryRepository::new(RepositoryConfig {
            pool_id: "default".to_owned(),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        })
        .unwrap(),
    );
    let kernel = Arc::new(ToggleKernel::default());
    let service = ControlService::new(
        repository,
        kernel.clone(),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    );
    service.recover().await.unwrap();
    let failed = AgentId::parse("agent-failed").unwrap();
    let unaffected = AgentId::parse("agent-unaffected").unwrap();
    service.ensure_agent_network(failed.clone()).await.unwrap();
    service
        .ensure_agent_network(unaffected.clone())
        .await
        .unwrap();
    let policy = PolicyId::parse("internet-enabled").unwrap();
    service
        .put_policy_revision(policy.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();

    kernel.fail_next.store(true, Ordering::Release);
    let result = service
        .assign_policy(failed.clone(), policy.clone(), 1, 1)
        .await;
    service.observe_control_result(&result);

    assert_eq!(
        result,
        Err(ControlError::CleanupFailed(FailureContext::new(
            "assign_policy.kernel_cleanup",
            "kernel_command_failed",
        )))
    );
    assert!(service.dataplane().lock().unwrap().is_agent_fenced(&failed));
    assert!(
        !service
            .dataplane()
            .lock()
            .unwrap()
            .is_agent_fenced(&unaffected)
    );
    assert_eq!(service.status().status, "degraded");

    let unrelated = service.agent_network(&unaffected).await;
    service.observe_control_result(&unrelated);
    assert_eq!(service.status().status, "degraded");

    let retried = service.assign_policy(failed.clone(), policy, 1, 1).await;
    service.observe_control_result(&retried);
    assert_eq!(retried.unwrap().resource_version, 2);
    assert!(!service.dataplane().lock().unwrap().is_agent_fenced(&failed));
    assert_eq!(service.status().status, "ready");
}
