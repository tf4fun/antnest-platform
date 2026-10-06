//! Ephemeral Egress test credentials; public conformance values are never installed.
#![allow(dead_code)]

use antnest_runtime_egress::service_auth::{Admission, Receiver};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest as _, Sha256};

pub fn workload_token() -> &'static str {
    static TOKEN: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    TOKEN.get_or_init(|| {
        let mut raw = [0_u8; 32];
        rustls::crypto::ring::default_provider()
            .secure_random
            .fill(&mut raw)
            .expect("ephemeral test credential entropy");
        URL_SAFE_NO_PAD.encode(raw)
    })
}

pub fn workload_header() -> String {
    format!("Bearer {}", workload_token())
}

pub fn admission_for(caller: &str) -> Admission {
    let digest = Sha256::digest(workload_token().as_bytes());
    let hex = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let raw = format!("{{\"{caller}\":[\"sha256:{hex}\"]}}");
    Admission::Token(Receiver::parse(raw.as_bytes(), "runtime-egress", false).unwrap())
}

pub fn key_id(agent: &str) -> antnest_runtime_tunnel::KeyId {
    let digest = Sha256::digest(agent.as_bytes());
    antnest_runtime_tunnel::KeyId::from_bytes(digest[..16].try_into().unwrap())
}
pub fn key_box() -> antnest_runtime_egress::tunnel::KeyBox {
    antnest_runtime_egress::tunnel::KeyBox::new([91; 32])
}
pub fn tunnel_registration(
    agent: &str,
    ip: std::net::Ipv4Addr,
) -> antnest_runtime_egress::tunnel::Registration {
    // Public unit-test vectors only. Docker fixtures generate private CSPRNG keys.
    serde_json::from_value(serde_json::json!({"key_id":key_id(agent).to_string(),"runtime_revision":"rtv_0102030405060708090a0b0c0d0e0f10","tunnel_ipv4":ip.to_string(),"egress_private_key":URL_SAFE_NO_PAD.encode([29;32]),"runtime_public_key":URL_SAFE_NO_PAD.encode(antnest_runtime_tunnel::Peer::public_key([11;32])),"preshared_key":URL_SAFE_NO_PAD.encode([53;32])})).unwrap()
}
pub fn runtime_peer(agent: &str) -> antnest_runtime_tunnel::Peer {
    antnest_runtime_tunnel::Peer::new(
        key_id(agent),
        [11; 32],
        antnest_runtime_tunnel::Peer::public_key([29; 32]),
        [53; 32],
    )
}

#[async_trait::async_trait]
pub trait TestRepositoryAttachment {
    async fn set_test_repository_attachment(
        &self,
        agent: &antnest_runtime_egress::domain::AgentId,
        state: antnest_runtime_egress::domain::AttachmentState,
        version: u64,
        endpoint: Option<std::net::Ipv4Addr>,
    ) -> Result<
        antnest_runtime_egress::domain::RuntimeAttachment,
        antnest_runtime_egress::repository::RepositoryError,
    >;
}
#[async_trait::async_trait]
impl<R: antnest_runtime_egress::repository::Repository> TestRepositoryAttachment for R {
    async fn set_test_repository_attachment(
        &self,
        agent: &antnest_runtime_egress::domain::AgentId,
        state: antnest_runtime_egress::domain::AttachmentState,
        version: u64,
        endpoint: Option<std::net::Ipv4Addr>,
    ) -> Result<
        antnest_runtime_egress::domain::RuntimeAttachment,
        antnest_runtime_egress::repository::RepositoryError,
    > {
        let id = if state == antnest_runtime_egress::domain::AttachmentState::Open {
            if let Ok(network) = self.agent_network(agent).await {
                self.prepare_tunnel(
                    key_box()
                        .seal(
                            agent.clone(),
                            &tunnel_registration(agent.as_str(), network.tunnel_ipv4),
                        )
                        .unwrap(),
                )
                .await?;
            }
            Some(key_id(agent.as_str()))
        } else {
            None
        };
        self.compare_and_swap_attachment(agent, state, version, endpoint, id)
            .await
    }
}

#[async_trait::async_trait]
pub trait TestAttachment {
    async fn set_test_attachment(
        &self,
        agent: antnest_runtime_egress::domain::AgentId,
        state: antnest_runtime_egress::domain::AttachmentState,
        version: u64,
        endpoint: Option<std::net::Ipv4Addr>,
    ) -> Result<
        antnest_runtime_egress::application::RuntimeNetworkAttachment,
        antnest_runtime_egress::application::ControlError,
    >;
}
#[async_trait::async_trait]
impl<R, K> TestAttachment for antnest_runtime_egress::application::ControlService<R, K>
where
    R: antnest_runtime_egress::repository::Repository,
    K: antnest_runtime_egress::application::KernelCleanup,
{
    async fn set_test_attachment(
        &self,
        agent: antnest_runtime_egress::domain::AgentId,
        state: antnest_runtime_egress::domain::AttachmentState,
        version: u64,
        endpoint: Option<std::net::Ipv4Addr>,
    ) -> Result<
        antnest_runtime_egress::application::RuntimeNetworkAttachment,
        antnest_runtime_egress::application::ControlError,
    > {
        let id = if state == antnest_runtime_egress::domain::AttachmentState::Open {
            if let Ok(network) = self.agent_network(&agent).await {
                self.register_tunnel(
                    agent.clone(),
                    tunnel_registration(agent.as_str(), network.tunnel_ipv4),
                )
                .await?;
            }
            Some(key_id(agent.as_str()))
        } else {
            None
        };
        self.set_runtime_attachment(agent, state, version, endpoint, id)
            .await
    }
}
