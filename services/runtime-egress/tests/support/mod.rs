use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlService, KernelCleanup},
    control::router_with_capture_rpc_content,
    repository::{InMemoryRepository, RepositoryConfig},
    telemetry::EgressMetrics,
};
use async_trait::async_trait;

struct NoopKernel;

#[async_trait]
impl KernelCleanup for NoopKernel {
    async fn clear_agent(&self, _: Ipv4Addr) -> Result<(), String> {
        Ok(())
    }
}

pub async fn app() -> axum::Router {
    app_with_capture_rpc_content(false).await
}

pub async fn app_with_capture_rpc_content(enabled: bool) -> axum::Router {
    let repository = InMemoryRepository::new(RepositoryConfig {
        pool_id: "default".to_owned(),
        tunnel_cidr: "100.64.0.0/29".parse().unwrap(),
        resolver_ipv4: "100.64.0.1".parse().unwrap(),
        quarantine: Duration::from_secs(300),
    })
    .unwrap();
    let service = ControlService::new(
        Arc::new(repository),
        Arc::new(NoopKernel),
        ControlConfig {
            advertised_udp_endpoint: "10.20.0.8:8092".parse().unwrap(),
            resolver_ipv4: "100.64.0.1".parse().unwrap(),
            max_flows: 32,
            max_agent_flows: 16,
            flow_idle: Duration::from_secs(60),
        },
    );
    let service = Arc::new(service);
    service.recover().await.unwrap();
    router_with_capture_rpc_content(service, EgressMetrics::default(), enabled)
}
