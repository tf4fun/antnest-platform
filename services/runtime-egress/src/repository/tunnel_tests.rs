use super::*;
use crate::tunnel::{KeyBox, Registration};
use antnest_runtime_tunnel::KeyId;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use rand_core::{OsRng, RngCore as _};

fn key_box() -> KeyBox {
    KeyBox::new(std::array::from_fn(|_| OsRng.next_u32() as u8))
}

fn prepared(vault: &KeyBox, agent: &AgentId, ip: Ipv4Addr, id: u8) -> crate::tunnel::PreparedKey {
    let input:Registration=serde_json::from_value(serde_json::json!({"key_id":KeyId::from_bytes([id;16]).to_string(),"runtime_revision":format!("rtv_{:032x}",id),"tunnel_ipv4":ip.to_string(),"egress_private_key":URL_SAFE_NO_PAD.encode([29;32]),"runtime_public_key":URL_SAFE_NO_PAD.encode(antnest_runtime_tunnel::Peer::public_key([11;32])),"preshared_key":URL_SAFE_NO_PAD.encode([53;32])})).unwrap();
    vault.seal(agent.clone(), &input).unwrap()
}
#[tokio::test]
async fn prepared_key_selection_is_atomic_bounded_and_retired_on_cutover() {
    let repo = InMemoryRepository::new(RepositoryConfig {
        pool_id: "test".into(),
        tunnel_cidr: "100.96.0.0/24".parse().unwrap(),
        resolver_ipv4: "100.96.0.1".parse().unwrap(),
        quarantine: Duration::from_secs(60),
    })
    .unwrap();
    let agent = AgentId::parse("agent_a").unwrap();
    let network = repo.ensure_agent_network(agent.clone()).await.unwrap();
    let vault = key_box();
    let first = prepared(&vault, &agent, network.tunnel_ipv4, 1);
    repo.prepare_tunnel(first.clone()).await.unwrap();
    let replay = repo
        .prepare_tunnel(prepared(&vault, &agent, network.tunnel_ipv4, 1))
        .await
        .unwrap();
    assert_eq!(replay.sealed, first.sealed);
    let wrong = KeyId::from_bytes([9; 16]);
    let endpoint = Some("10.243.0.2".parse().unwrap());
    assert!(
        repo.compare_and_swap_attachment(&agent, AttachmentState::Open, 1, endpoint, Some(wrong))
            .await
            .is_err()
    );
    let open = repo
        .compare_and_swap_attachment(
            &agent,
            AttachmentState::Open,
            1,
            endpoint,
            Some(first.key_id),
        )
        .await
        .unwrap();
    assert_eq!(open.tunnel_key_id, Some(first.key_id));
    assert!(
        repo.prepare_tunnel(prepared(&vault, &agent, network.tunnel_ipv4, 2))
            .await
            .is_err()
    );
    repo.compare_and_swap_attachment(
        &agent,
        AttachmentState::Closed,
        open.resource_version,
        None,
        None,
    )
    .await
    .unwrap();
    let second = prepared(&vault, &agent, network.tunnel_ipv4, 2);
    repo.prepare_tunnel(second.clone()).await.unwrap();
    let third = prepared(&vault, &agent, network.tunnel_ipv4, 3);
    repo.prepare_tunnel(third.clone()).await.unwrap();
    let keys = repo.prepared_tunnels(&agent).await.unwrap();
    assert_eq!(keys.len(), 2);
    assert!(!keys.iter().any(|r| r.key_id == second.key_id));
    let closed = repo.runtime_attachment(&agent).await.unwrap();
    repo.compare_and_swap_attachment(
        &agent,
        AttachmentState::Open,
        closed.resource_version,
        endpoint,
        Some(third.key_id),
    )
    .await
    .unwrap();
    let keys = repo.prepared_tunnels(&agent).await.unwrap();
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].key_id, third.key_id);
    assert!(
        repo.compare_and_swap_attachment(
            &agent,
            AttachmentState::Open,
            closed.resource_version + 1,
            endpoint,
            Some(first.key_id)
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn recovery_rejects_open_attachment_whose_key_row_is_missing() {
    struct NoopKernel;
    #[async_trait]
    impl crate::application::KernelCleanup for NoopKernel {
        async fn clear_agent(&self, _: Ipv4Addr) -> Result<(), String> {
            Ok(())
        }
    }
    let repository = std::sync::Arc::new(
        InMemoryRepository::new(RepositoryConfig {
            pool_id: "test".into(),
            tunnel_cidr: "100.96.0.0/24".parse().unwrap(),
            resolver_ipv4: "100.96.0.1".parse().unwrap(),
            quarantine: Duration::from_secs(60),
        })
        .unwrap(),
    );
    let agent = AgentId::parse("agent_missing_key").unwrap();
    let network = repository
        .ensure_agent_network(agent.clone())
        .await
        .unwrap();
    let vault = key_box();
    let key = prepared(&vault, &agent, network.tunnel_ipv4, 1);
    repository.prepare_tunnel(key.clone()).await.unwrap();
    repository
        .compare_and_swap_attachment(
            &agent,
            AttachmentState::Open,
            1,
            Some("10.243.0.2".parse().unwrap()),
            Some(key.key_id),
        )
        .await
        .unwrap();
    repository.state.lock().await.tunnels.clear();
    let control = crate::application::ControlService::new(
        repository,
        std::sync::Arc::new(NoopKernel),
        crate::application::ControlConfig {
            advertised_udp_endpoint: "10.243.0.1:8092".parse().unwrap(),
            resolver_ipv4: "100.96.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
        vault,
    );
    assert!(control.recover().await.is_err());
    assert!(!control.status().control_plane_ready);
}
