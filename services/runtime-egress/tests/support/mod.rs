// Each test binary consumes a different subset of these common fixtures.
#![allow(dead_code)]

use std::{net::Ipv4Addr, sync::Arc, time::Duration};

use antnest_runtime_egress::{
    application::{ControlConfig, ControlService, KernelCleanup},
    control::{health_router, router_with_capture_rpc_content},
    repository::{InMemoryRepository, RepositoryConfig},
    telemetry::EgressMetrics,
};
use async_trait::async_trait;

#[path = "../../../../tests/support/egress-auth.rs"]
mod auth;
pub fn workload_token() -> &'static str {
    auth::workload_token()
}
pub fn workload_header() -> String {
    auth::workload_header()
}
pub fn admission_for(caller: &str) -> antnest_runtime_egress::service_auth::Admission {
    auth::admission_for(caller)
}

pub struct NoopKernel;

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
    router_with_capture_rpc_content(
        service().await,
        EgressMetrics::default(),
        admission_for("agent-controller"),
        enabled,
    )
}

pub async fn app_for_caller(caller: &str) -> axum::Router {
    router_with_capture_rpc_content(
        service().await,
        EgressMetrics::default(),
        admission_for(caller),
        false,
    )
}

pub async fn health_app() -> axum::Router {
    health_router(service().await, EgressMetrics::default())
}

pub async fn app_and_health() -> (axum::Router, axum::Router) {
    let service = service().await;
    (
        router_with_capture_rpc_content(
            service.clone(),
            EgressMetrics::default(),
            admission_for("agent-controller"),
            false,
        ),
        health_router(service, EgressMetrics::default()),
    )
}

pub async fn service() -> Arc<ControlService<InMemoryRepository, NoopKernel>> {
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
    service
}
