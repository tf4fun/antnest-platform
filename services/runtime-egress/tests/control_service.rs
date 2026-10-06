use std::{
    net::{Ipv4Addr, SocketAddrV4},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant, SystemTime},
};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlError, ControlService, FailureContext, KernelCleanup},
    dataplane::{DataPlaneAction, DropReason},
    domain::{AgentId, AttachmentState, NetworkState, PolicyId},
    policy::PolicySpec,
    repository::{InMemoryRepository, RepositoryConfig},
};
use async_trait::async_trait;

#[tokio::test]
async fn peer_rebinding_is_a_versioned_cleanup_barrier_and_survives_recovery() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-peer-rebind").unwrap();
    let network = service.ensure_agent_network(agent.clone()).await.unwrap();
    service
        .assign_policy(
            agent.clone(),
            PolicyId::parse("builtin/allow-all").unwrap(),
            1,
            1,
        )
        .await
        .unwrap();
    let first_peer = "10.20.0.9".parse().unwrap();
    let next_peer = "10.20.0.10".parse().unwrap();
    let opened = service
        .set_runtime_attachment(agent.clone(), AttachmentState::Open, 1, Some(first_peer))
        .await
        .unwrap();
    let mut packet = readiness_probe(network.tunnel_ipv4);
    packet[16..20].copy_from_slice(&Ipv4Addr::new(93, 184, 216, 34).octets());
    packet[22..24].copy_from_slice(&443_u16.to_be_bytes());
    assert!(matches!(
        service.dataplane().lock().unwrap().handle_uplink(
            &packet,
            "10.20.0.9:40000".parse().unwrap(),
            Instant::now()
        ),
        DataPlaneAction::WriteTun(_)
    ));
    let before = kernel.cleared.lock().unwrap().len();
    let rebound = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            opened.attachment_resource_version,
            Some(next_peer),
        )
        .await
        .unwrap();
    assert_eq!(
        rebound.attachment_resource_version,
        opened.attachment_resource_version + 1
    );
    assert_eq!(rebound.runtime_endpoint, Some(next_peer));
    assert_eq!(kernel.cleared.lock().unwrap().len(), before + 1);
    assert_eq!(service.dataplane().lock().unwrap().flow_count(), 0);
    assert_eq!(
        service
            .set_runtime_attachment(
                agent.clone(),
                AttachmentState::Open,
                opened.attachment_resource_version,
                Some(first_peer)
            )
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
    service.recover().await.unwrap();
    assert_eq!(
        service
            .agent_network(&agent)
            .await
            .unwrap()
            .runtime_endpoint,
        Some(next_peer)
    );
    let plane = service.dataplane();
    let mut plane = plane.lock().unwrap();
    assert_eq!(
        plane.handle_uplink(&packet, "10.20.0.9:40000".parse().unwrap(), Instant::now()),
        DataPlaneAction::Drop(DropReason::PeerMismatch)
    );
    assert!(matches!(
        plane.handle_uplink(&packet, "10.20.0.10:40000".parse().unwrap(), Instant::now()),
        DataPlaneAction::WriteTun(_)
    ));
}

#[tokio::test]
async fn invalid_peer_state_pairs_have_no_control_effect() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-peer-invalid").unwrap();
    let before = service.ensure_agent_network(agent.clone()).await.unwrap();
    for (state, peer) in [
        (AttachmentState::Open, None),
        (AttachmentState::Closed, Some("10.20.0.9".parse().unwrap())),
    ] {
        assert_eq!(
            service
                .set_runtime_attachment(agent.clone(), state, 1, peer)
                .await,
            Err(ControlError::InvalidRequest)
        );
        assert_eq!(service.agent_network(&agent).await.unwrap(), before);
    }
    assert!(kernel.cleared.lock().unwrap().is_empty());
}

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

fn toggle_service() -> (
    ControlService<InMemoryRepository, ToggleKernel>,
    Arc<ToggleKernel>,
) {
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
    (service, kernel)
}

#[tokio::test]
async fn failed_close_does_not_publish_closed_before_cleanup_succeeds() {
    let (service, kernel) = toggle_service();
    let agent = AgentId::parse("agent-reconcile").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    let opened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    let initial_calls = kernel.calls.load(Ordering::Acquire);

    kernel.fail_next.store(true, Ordering::Release);
    assert_eq!(
        service
            .set_runtime_attachment(
                agent.clone(),
                AttachmentState::Closed,
                opened.attachment_resource_version,
                None,
            )
            .await,
        Err(ControlError::CleanupFailed(
            FailureContext::new(
                "set_runtime_attachment.close_cleanup",
                "kernel_command_failed",
            )
            .with_kernel_source("injected cleanup failure".to_owned())
        ))
    );
    let unchanged = service.agent_network(&agent).await.unwrap();
    assert_eq!(unchanged.attachment_state, AttachmentState::Open);
    assert!(service.dataplane().lock().unwrap().is_agent_fenced(&agent));

    let reconciled = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Closed,
            opened.attachment_resource_version,
            None,
        )
        .await
        .unwrap();

    assert_eq!(kernel.calls.load(Ordering::Acquire), initial_calls + 2);
    assert_eq!(reconciled.attachment_state, AttachmentState::Closed);
}

#[tokio::test]
async fn healthy_same_policy_submission_preserves_existing_flow_and_reply_peer() {
    let (service, kernel) = toggle_service();
    let agent = AgentId::parse("agent-noop-policy").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    let policy = PolicyId::parse("builtin/allow-all").unwrap();
    let assignment = service
        .assign_policy(agent.clone(), policy.clone(), 1, 1)
        .await
        .unwrap();
    service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    let mut packet = readiness_probe(allocated.tunnel_ipv4);
    packet[16..20].copy_from_slice(&Ipv4Addr::new(93, 184, 216, 34).octets());
    packet[22..24].copy_from_slice(&443_u16.to_be_bytes());
    let peer = "10.20.0.9:12345".parse().unwrap();
    assert_eq!(
        service
            .dataplane()
            .lock()
            .unwrap()
            .handle_uplink(&packet, peer, Instant::now()),
        DataPlaneAction::WriteTun(packet.clone())
    );
    let calls = kernel.calls.load(Ordering::Acquire);
    for version in [assignment.resource_version, assignment.resource_version - 1] {
        assert_eq!(
            service
                .assign_policy(agent.clone(), policy.clone(), 1, version)
                .await
                .unwrap(),
            assignment
        );
        assert_eq!(kernel.calls.load(Ordering::Acquire), calls);
        assert_eq!(service.dataplane().lock().unwrap().flow_count(), 1);
    }
    let mut reply = packet.clone();
    reply[12..16].copy_from_slice(&packet[16..20]);
    reply[16..20].copy_from_slice(&packet[12..16]);
    reply[20..22].copy_from_slice(&packet[22..24]);
    reply[22..24].copy_from_slice(&packet[20..22]);
    assert!(
        matches!(service.dataplane().lock().unwrap().handle_downlink(&reply, Instant::now()), DataPlaneAction::SendUdp { peer: actual, .. } if actual == peer)
    );
    assert!(matches!(
        service.assign_policy(agent.clone(), policy, 1, 0).await,
        Err(ControlError::ResourceVersionConflict)
    ));
    assert_eq!(kernel.calls.load(Ordering::Acquire), calls);
}

#[tokio::test]
async fn same_policy_repairs_a_failed_barrier_instead_of_skipping_cleanup() {
    let (service, kernel) = toggle_service();
    let agent = AgentId::parse("agent-policy-repair").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    let policy = PolicyId::parse("builtin/allow-all").unwrap();
    let assignment = service
        .assign_policy(agent.clone(), policy.clone(), 1, 1)
        .await
        .unwrap();
    service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    kernel.fail_next.store(true, Ordering::Release);
    assert!(
        service
            .assign_policy(
                agent.clone(),
                PolicyId::parse("builtin/deny-all").unwrap(),
                1,
                assignment.resource_version
            )
            .await
            .is_err()
    );
    assert!(service.dataplane().lock().unwrap().is_agent_fenced(&agent));
    let calls = kernel.calls.load(Ordering::Acquire);
    assert_eq!(
        service
            .assign_policy(agent.clone(), policy, 1, assignment.resource_version)
            .await
            .unwrap(),
        assignment
    );
    assert_eq!(kernel.calls.load(Ordering::Acquire), calls + 1);
    assert!(!service.dataplane().lock().unwrap().is_agent_fenced(&agent));
}

#[tokio::test]
async fn reopening_a_failed_barrier_requires_successful_cleanup() {
    for (use_ensure, fail_close, previously_allowed) in [
        (true, true, true),
        (false, true, true),
        (true, false, true),
        (false, false, true),
        (true, false, false),
        (false, false, false),
    ] {
        let (service, kernel) = toggle_service();
        let agent = AgentId::parse("agent-fenced").unwrap();
        let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
        let persisted = service
            .assign_policy(
                agent.clone(),
                PolicyId::parse(if previously_allowed {
                    "builtin/allow-all"
                } else {
                    "builtin/deny-all"
                })
                .unwrap(),
                1,
                1,
            )
            .await
            .unwrap();
        let mut packet = readiness_probe(allocated.tunnel_ipv4);
        packet[16..20].copy_from_slice(&Ipv4Addr::new(93, 184, 216, 34).octets());
        packet[22..24].copy_from_slice(&443_u16.to_be_bytes());
        let peer = "10.20.0.9:12345".parse().unwrap();
        let opened = service
            .set_runtime_attachment(
                agent.clone(),
                AttachmentState::Open,
                allocated.attachment_resource_version,
                Some("10.20.0.9".parse().unwrap()),
            )
            .await
            .unwrap();
        kernel.fail_next.store(true, Ordering::Release);
        let failed = if fail_close {
            service
                .set_runtime_attachment(
                    agent.clone(),
                    AttachmentState::Closed,
                    opened.attachment_resource_version,
                    None,
                )
                .await
                .map(|_| ())
        } else {
            service
                .assign_policy(
                    agent.clone(),
                    PolicyId::parse(if previously_allowed {
                        "builtin/deny-all"
                    } else {
                        "builtin/allow-all"
                    })
                    .unwrap(),
                    1,
                    persisted.resource_version,
                )
                .await
                .map(|_| ())
        };
        assert!(matches!(failed, Err(ControlError::CleanupFailed(_))));
        let calls = kernel.calls.load(Ordering::Acquire);

        kernel.fail_next.store(true, Ordering::Release);
        let repair = if use_ensure {
            service.ensure_agent_network(agent.clone()).await
        } else {
            service
                .set_runtime_attachment(
                    agent.clone(),
                    AttachmentState::Open,
                    opened.attachment_resource_version,
                    Some("10.20.0.9".parse().unwrap()),
                )
                .await
        };
        assert!(
            matches!(repair, Err(ControlError::CleanupFailed(_))),
            "ensure={use_ensure}, close={fail_close}: {repair:?}"
        );
        assert_eq!(kernel.calls.load(Ordering::Acquire), calls + 1);
        assert!(service.dataplane().lock().unwrap().is_agent_fenced(&agent));
        assert_eq!(
            service
                .dataplane()
                .lock()
                .unwrap()
                .handle_uplink(&packet, peer, Instant::now()),
            DataPlaneAction::Drop(DropReason::AgentFenced)
        );
        assert_eq!(service.agent_network(&agent).await.unwrap(), opened);
        assert_eq!(service.policy_assignment(&agent).await.unwrap(), persisted);

        let repaired = if use_ensure {
            service.ensure_agent_network(agent.clone()).await
        } else {
            service
                .set_runtime_attachment(
                    agent.clone(),
                    AttachmentState::Open,
                    opened.attachment_resource_version,
                    Some("10.20.0.9".parse().unwrap()),
                )
                .await
        }
        .unwrap();
        assert_eq!(repaired, opened);
        assert_eq!(kernel.calls.load(Ordering::Acquire), calls + 2);
        assert!(!service.dataplane().lock().unwrap().is_agent_fenced(&agent));
        assert_eq!(service.policy_assignment(&agent).await.unwrap(), persisted);
        let plane = service.dataplane();
        {
            let mut plane = plane.lock().unwrap();
            let action = plane.handle_uplink(&packet, peer, Instant::now());
            if previously_allowed {
                assert_eq!(action, DataPlaneAction::WriteTun(packet));
                assert_eq!(plane.flow_count(), 1);
            } else {
                assert!(
                    matches!(action, DataPlaneAction::SendUdp { peer: actual, .. } if actual == peer)
                );
                assert_eq!(plane.flow_count(), 0);
            }
        }

        assert_eq!(service.ensure_agent_network(agent).await.unwrap(), opened);
        assert_eq!(kernel.calls.load(Ordering::Acquire), calls + 2);
    }
}

#[tokio::test]
async fn failed_initial_open_keeps_durable_attachment_closed() {
    let (service, kernel) = toggle_service();
    let agent = AgentId::parse("agent-open-failure").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    kernel.fail_next.store(true, Ordering::Release);
    let result = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await;
    assert!(matches!(result, Err(ControlError::CleanupFailed(_))));
    assert_eq!(service.agent_network(&agent).await.unwrap(), allocated);
    assert!(service.dataplane().lock().unwrap().is_agent_fenced(&agent));
    let opened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(
        opened.attachment_resource_version,
        allocated.attachment_resource_version + 1
    );
    assert_eq!(opened.attachment_state, AttachmentState::Open);
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

fn control_with_repository(
    repository: Arc<InMemoryRepository>,
) -> ControlService<InMemoryRepository, RecordingKernel> {
    ControlService::new(
        repository,
        Arc::new(RecordingKernel::default()),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    )
}

fn readiness_probe(tunnel: Ipv4Addr) -> Vec<u8> {
    let mut packet = vec![0_u8; 40];
    packet[0] = 0x45;
    packet[2..4].copy_from_slice(&40_u16.to_be_bytes());
    packet[6..8].copy_from_slice(&0x4000_u16.to_be_bytes());
    packet[8] = 64;
    packet[9] = 6;
    packet[12..16].copy_from_slice(&tunnel.octets());
    packet[16..20].copy_from_slice(&Ipv4Addr::new(192, 0, 2, 1).octets());
    packet[20..22].copy_from_slice(&49_153_u16.to_be_bytes());
    packet[22..24].copy_from_slice(&9_u16.to_be_bytes());
    packet[24..28].copy_from_slice(&41_u32.to_be_bytes());
    packet[32] = 5 << 4;
    packet[33] = 0x02;
    packet
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
    assert_eq!(first.attachment_state, AttachmentState::Closed);
}

#[tokio::test]
async fn closed_allocation_is_probe_only_before_runtime_readiness() {
    let (service, _) = service();
    let agent = AgentId::parse("agent-probe-only").unwrap();
    let allocation = service.ensure_agent_network(agent.clone()).await.unwrap();
    let peer = "10.20.0.9:41000".parse().unwrap();
    let mut probe = readiness_probe(allocation.tunnel_ipv4);

    let response =
        service
            .dataplane()
            .lock()
            .unwrap()
            .handle_uplink(&probe, peer, std::time::Instant::now());
    assert!(matches!(
        response,
        DataPlaneAction::SendUdp { agent_id, peer: actual, .. }
            if agent_id == agent && actual == peer
    ));

    probe[22..24].copy_from_slice(&10_u16.to_be_bytes());
    assert_eq!(
        service
            .dataplane()
            .lock()
            .unwrap()
            .handle_uplink(&probe, peer, std::time::Instant::now()),
        DataPlaneAction::Drop(DropReason::AgentFenced)
    );
}

#[tokio::test]
async fn cold_recovery_restores_closed_allocation_as_probe_only() {
    let repository = Arc::new(
        InMemoryRepository::new(RepositoryConfig {
            pool_id: "default".to_owned(),
            tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(300),
        })
        .unwrap(),
    );
    let first = control_with_repository(repository.clone());
    let agent = AgentId::parse("agent-recovered-probe").unwrap();
    let allocation = first.ensure_agent_network(agent.clone()).await.unwrap();

    let recovered = control_with_repository(repository);
    assert_eq!(recovered.recover().await.unwrap(), 1);
    let peer = "10.20.0.9:41000".parse().unwrap();
    assert!(matches!(
        recovered.dataplane().lock().unwrap().handle_uplink(
            &readiness_probe(allocation.tunnel_ipv4),
            peer,
            std::time::Instant::now(),
        ),
        DataPlaneAction::SendUdp { agent_id, .. } if agent_id == agent
    ));
}

#[tokio::test]
async fn stale_release_has_no_cleanup_or_admission_side_effect() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-stale-release").unwrap();
    let allocation = service.ensure_agent_network(agent.clone()).await.unwrap();

    assert_eq!(
        service
            .release_agent_network(agent.clone(), allocation.network_resource_version + 1)
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
    assert!(kernel.cleared.lock().unwrap().is_empty());
    assert_eq!(
        service.agent_network(&agent).await.unwrap().state,
        NetworkState::Active
    );
}

#[tokio::test]
async fn release_retry_reconciles_an_already_quarantined_allocation() {
    let (service, _) = service();
    let agent = AgentId::parse("agent-release-retry").unwrap();
    let allocation = service.ensure_agent_network(agent.clone()).await.unwrap();
    let first = service
        .release_agent_network(agent.clone(), allocation.network_resource_version)
        .await
        .unwrap();
    let replay = service
        .release_agent_network(agent, allocation.network_resource_version)
        .await
        .unwrap();

    assert_eq!(first, replay);
    assert_eq!(replay.state, NetworkState::Quarantined);
    assert_eq!(replay.attachment_state, AttachmentState::Closed);
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
    assert_eq!(kernel.cleared.lock().unwrap().len(), 0);
    assert_eq!(
        service
            .assign_policy(agent, PolicyId::parse("builtin/deny-all").unwrap(), 1, 1,)
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
}

#[tokio::test]
async fn desired_policy_survives_close_and_reopen() {
    let (service, _) = service();
    let agent = AgentId::parse("agent-fenced-cas").unwrap();
    let policy_id = PolicyId::parse("internet-enabled").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    service
        .put_policy_revision(policy_id.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();

    let enabled = service
        .assign_policy(agent.clone(), policy_id.clone(), 1, 1)
        .await
        .unwrap();
    let opened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    let closed = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Closed,
            opened.attachment_resource_version,
            None,
        )
        .await
        .unwrap();
    let assignment = service.policy_assignment(&agent).await.unwrap();
    let reopened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            closed.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();

    assert_eq!(assignment, enabled);
    assert_eq!(assignment.policy_id, policy_id);
    assert_eq!(reopened.attachment_state, AttachmentState::Open);
    assert_eq!(
        service
            .set_runtime_attachment(
                agent,
                AttachmentState::Closed,
                opened.attachment_resource_version,
                None,
            )
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
}

#[tokio::test]
async fn stale_same_state_attachment_replay_is_rejected_without_cleanup() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-stale-close").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    let opened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    let first_close = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Closed,
            opened.attachment_resource_version,
            None,
        )
        .await
        .unwrap();
    let reopened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            first_close.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Closed,
            reopened.attachment_resource_version,
            None,
        )
        .await
        .unwrap();
    let cleanup_count = kernel.cleared.lock().unwrap().len();

    assert_eq!(
        service
            .set_runtime_attachment(
                agent,
                AttachmentState::Closed,
                opened.attachment_resource_version,
                None,
            )
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
    assert_eq!(kernel.cleared.lock().unwrap().len(), cleanup_count);
}

#[tokio::test]
async fn release_cleans_before_entering_quarantine() {
    let (service, kernel) = service();
    let agent = AgentId::parse("agent-1").unwrap();
    let network = service.ensure_agent_network(agent.clone()).await.unwrap();

    let released = service
        .release_agent_network(agent.clone(), 1)
        .await
        .unwrap();

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
    service
        .release_agent_network(agent.clone(), 1)
        .await
        .unwrap();

    let report = service
        .sweep_quarantine(SystemTime::now() + Duration::from_secs(301))
        .await
        .unwrap();

    assert_eq!(report.examined, 1);
    assert_eq!(report.removed, 1);
    assert_eq!(report.cleanup_failures, 0);
    assert_eq!(kernel.cleared.lock().unwrap().len(), 2);
    assert_eq!(
        service.agent_network(&agent).await,
        Err(ControlError::AgentNetworkNotFound)
    );
}

#[tokio::test]
async fn quarantine_sweeper_isolates_one_agents_cleanup_failure() {
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
    let first = AgentId::parse("agent-first").unwrap();
    let second = AgentId::parse("agent-second").unwrap();
    service.ensure_agent_network(first.clone()).await.unwrap();
    service.ensure_agent_network(second.clone()).await.unwrap();
    service
        .release_agent_network(first.clone(), 1)
        .await
        .unwrap();
    service
        .release_agent_network(second.clone(), 1)
        .await
        .unwrap();
    kernel.fail_next.store(true, Ordering::Release);

    let report = service
        .sweep_quarantine(SystemTime::now() + Duration::from_secs(301))
        .await
        .unwrap();

    assert_eq!(report.examined, 2);
    assert_eq!(report.removed, 1);
    assert_eq!(report.cleanup_failures, 1);
    let retained = usize::from(service.agent_network(&first).await.is_ok())
        + usize::from(service.agent_network(&second).await.is_ok());
    assert_eq!(retained, 1);
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
    let allocated = first.ensure_agent_network(agent.clone()).await.unwrap();
    let policy = PolicyId::parse("internet-enabled").unwrap();
    first
        .put_policy_revision(policy.clone(), 1, PolicySpec::allow_all())
        .await
        .unwrap();
    first
        .assign_policy(agent.clone(), policy, 1, 1)
        .await
        .unwrap();
    first
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
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
        route
            .unwrap()
            .policy
            .decide("93.184.216.34".parse().unwrap(), 443),
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

    let agent = AgentId::parse("agent-observed").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    assert_eq!(service.status().snapshot_revision, 2);
    service
        .set_runtime_attachment(
            agent,
            AttachmentState::Open,
            allocated.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    assert_eq!(service.status().snapshot_revision, 3);
}

#[tokio::test]
async fn request_failures_never_override_repository_health() {
    let (service, _) = service();
    service.recover().await.unwrap();

    service.observe_control_result::<()>(&Err(ControlError::ControlPlaneUnavailable(
        FailureContext::new("test.repository", "repository_unavailable"),
    )));
    assert_eq!(service.status().status, "ready");
    assert!(service.status().control_plane_ready);

    service.observe_repository_health(false);
    service.observe_control_result(&Ok::<(), ControlError>(()));
    assert_eq!(service.status().status, "degraded");
    assert!(!service.status().control_plane_ready);

    service.observe_control_result::<()>(&Err(ControlError::ControlPlaneUnavailable(
        FailureContext::new("test.repository", "repository_unavailable"),
    )));
    assert_eq!(service.status().status, "degraded");

    service.observe_repository_health(true);
    assert_eq!(service.status().status, "ready");
}

#[tokio::test]
async fn one_repository_operation_failure_does_not_degrade_shared_health() {
    let (service, _) = service();
    service.recover().await.unwrap();
    let transitions = service.health_metrics().transitions;

    service.observe_control_result::<()>(&Err(ControlError::OperationFailed(FailureContext::new(
        "test.repository",
        "repository_operation_failed",
    ))));

    assert_eq!(service.status().status, "ready");
    assert!(service.status().control_plane_ready);
    assert_eq!(service.health_metrics().transitions, transitions);
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
    let failed_network = service.ensure_agent_network(failed.clone()).await.unwrap();
    let unaffected_network = service
        .ensure_agent_network(unaffected.clone())
        .await
        .unwrap();
    service
        .set_runtime_attachment(
            failed.clone(),
            AttachmentState::Open,
            failed_network.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
        .await
        .unwrap();
    service
        .set_runtime_attachment(
            unaffected.clone(),
            AttachmentState::Open,
            unaffected_network.attachment_resource_version,
            Some("10.20.0.9".parse().unwrap()),
        )
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
        Err(ControlError::CleanupFailed(
            FailureContext::new("assign_policy.kernel_cleanup", "kernel_command_failed",)
                .with_kernel_source("injected cleanup failure".to_owned())
        ))
    );
    assert!(service.dataplane().lock().unwrap().is_agent_fenced(&failed));
    assert!(
        !service
            .dataplane()
            .lock()
            .unwrap()
            .is_agent_fenced(&unaffected)
    );
    assert_eq!(service.status().status, "ready");
    assert_eq!(service.health_metrics().fenced_agents, 1);
    let unchanged_assignment = service.policy_assignment(&failed).await.unwrap();
    assert_eq!(unchanged_assignment.policy_id.as_str(), "builtin/deny-all");
    assert_eq!(unchanged_assignment.resource_version, 1);

    let unrelated = service.agent_network(&unaffected).await;
    service.observe_control_result(&unrelated);
    assert_eq!(service.status().status, "ready");

    let retried = service.assign_policy(failed.clone(), policy, 1, 1).await;
    service.observe_control_result(&retried);
    assert_eq!(retried.unwrap().resource_version, 2);
    assert!(!service.dataplane().lock().unwrap().is_agent_fenced(&failed));
    assert_eq!(service.status().status, "ready");
    assert_eq!(service.health_metrics().fenced_agents, 0);
}

#[tokio::test]
async fn health_transitions_track_shared_infrastructure_only() {
    let (service, _) = service();
    assert_eq!(service.health_metrics().transitions, 0);

    service.recover().await.unwrap();
    let recovered = service.health_metrics();
    assert!(recovered.service_ready);
    assert_eq!(recovered.transitions, 2);

    service.observe_repository_health(false);
    let unavailable = service.health_metrics();
    assert!(!unavailable.service_ready);
    assert_eq!(unavailable.transitions, 3);

    service.observe_repository_health(true);
    let available = service.health_metrics();
    assert!(available.service_ready);
    assert_eq!(available.transitions, 4);
}
