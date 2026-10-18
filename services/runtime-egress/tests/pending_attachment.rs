mod support;

use antnest_runtime_egress::{
    application::ControlError,
    dataplane::{DataPlaneAction, DropReason},
    domain::{AgentId, AttachmentState, PolicyId},
};
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::json;
use std::{net::Ipv4Addr, time::Instant};
use tower::ServiceExt as _;

fn pending() -> AttachmentState {
    serde_json::from_value(json!("pending")).expect("pending is a durable attachment state")
}

fn packet(source: Ipv4Addr, target: Ipv4Addr, port: u16) -> Vec<u8> {
    let mut bytes = vec![0_u8; 40];
    bytes[0] = 0x45;
    bytes[2..4].copy_from_slice(&40_u16.to_be_bytes());
    bytes[8] = 64;
    bytes[9] = 6;
    bytes[12..16].copy_from_slice(&source.octets());
    bytes[16..20].copy_from_slice(&target.octets());
    bytes[20..22].copy_from_slice(&40000_u16.to_be_bytes());
    bytes[22..24].copy_from_slice(&port.to_be_bytes());
    bytes[32] = 5 << 4;
    bytes[33] = 2;
    bytes
}

#[tokio::test]
async fn pending_http_is_versioned_and_rejects_peer_or_key_material() {
    let app = support::app().await;
    let ensured = app
        .clone()
        .oneshot(
            Request::put("/internal/agent-networks/pending-http")
                .header("antnest-service-authorization", support::workload_header())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ensured.status(), StatusCode::OK);
    for (body, status) in [
        (
            json!({"state":"pending","expected_resource_version":1}),
            StatusCode::OK,
        ),
        (
            json!({"state":"pending","expected_resource_version":1,"runtime_endpoint":null,"tunnel_key_id":null}),
            StatusCode::OK,
        ),
        (
            json!({"state":"pending","expected_resource_version":2,"runtime_endpoint":"10.20.0.9"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"state":"pending","expected_resource_version":2,"tunnel_key_id":"rtk_0123456789abcdef0123456789abcdef"}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::put("/internal/agent-network-attachments/pending-http")
                    .header("antnest-service-authorization", support::workload_header())
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status, "{body}");
        if status == StatusCode::OK {
            let document: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap())
                    .unwrap();
            assert_eq!(document["attachment_state"], "pending");
            assert_eq!(document["attachment_resource_version"], 2);
            assert!(document["runtime_endpoint"].is_null());
            assert!(document["tunnel_key_id"].is_null());
        }
    }
}

#[tokio::test]
async fn pending_keeps_traffic_fenced_through_policy_ensure_and_recovery() {
    let service = support::service().await;
    let agent = AgentId::parse("pending-packets").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    service
        .register_tunnel(
            agent.clone(),
            support::auth::tunnel_registration(agent.as_str(), allocated.tunnel_ipv4),
        )
        .await
        .unwrap();
    let waiting = service
        .set_runtime_attachment(agent.clone(), pending(), 1, None, None)
        .await
        .unwrap();
    assert_eq!(waiting.attachment_resource_version, 2);
    assert!(waiting.runtime_endpoint.is_none() && waiting.tunnel_key_id.is_none());
    service
        .assign_policy(
            agent.clone(),
            PolicyId::parse("builtin/allow-all").unwrap(),
            1,
            1,
        )
        .await
        .unwrap();
    for recover in [false, true] {
        if recover {
            service.recover().await.unwrap();
        }
        assert_eq!(
            service.ensure_agent_network(agent.clone()).await.unwrap(),
            waiting
        );
        let plane = service.dataplane();
        let mut plane = plane.lock().unwrap();
        for (target, port) in [("93.184.216.34", 443), ("100.64.0.1", 53)] {
            let bytes = packet(allocated.tunnel_ipv4, target.parse().unwrap(), port);
            assert_eq!(
                plane.handle_uplink(&bytes, "10.20.0.9:40000".parse().unwrap(), Instant::now()),
                DataPlaneAction::Drop(DropReason::AgentFenced)
            );
        }
        assert_eq!(plane.flow_count(), 0);
    }
    assert_eq!(
        service.release_agent_network(agent.clone(), 1).await,
        Err(ControlError::AgentNetworkUnavailable)
    );
    let opened = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            2,
            Some("10.20.0.9".parse().unwrap()),
            Some(support::auth::key_id(agent.as_str())),
        )
        .await
        .unwrap();
    assert_eq!(opened.attachment_resource_version, 3);
    let bytes = packet(allocated.tunnel_ipv4, "93.184.216.34".parse().unwrap(), 443);
    assert_eq!(
        service.dataplane().lock().unwrap().handle_uplink(
            &bytes,
            "10.20.0.9:40000".parse().unwrap(),
            Instant::now()
        ),
        DataPlaneAction::WriteTun(bytes)
    );
}

#[tokio::test]
async fn closing_pending_fences_delayed_open_and_older_pending_cycles() {
    let service = support::service().await;
    let agent = AgentId::parse("pending-close").unwrap();
    let allocated = service.ensure_agent_network(agent.clone()).await.unwrap();
    let registration = support::auth::tunnel_registration(agent.as_str(), allocated.tunnel_ipv4);
    service
        .register_tunnel(
            agent.clone(),
            support::auth::tunnel_registration(agent.as_str(), allocated.tunnel_ipv4),
        )
        .await
        .unwrap();
    service
        .set_runtime_attachment(agent.clone(), pending(), 1, None, None)
        .await
        .unwrap();
    service
        .register_tunnel(agent.clone(), registration)
        .await
        .unwrap();
    let mut other = support::auth::tunnel_registration("new-key", allocated.tunnel_ipv4);
    other.runtime_revision = "rtv_11111111111111111111111111111111".to_owned();
    assert_eq!(
        service.register_tunnel(agent.clone(), other).await,
        Err(ControlError::AttachmentOpen)
    );
    let closed = service
        .set_runtime_attachment(agent.clone(), AttachmentState::Closed, 2, None, None)
        .await
        .unwrap();
    assert_eq!(closed.attachment_resource_version, 3);
    let opening = service
        .set_runtime_attachment(
            agent.clone(),
            AttachmentState::Open,
            2,
            Some("10.20.0.9".parse().unwrap()),
            Some(support::auth::key_id(agent.as_str())),
        )
        .await;
    assert_eq!(opening, Err(ControlError::ResourceVersionConflict));
    let next = service
        .set_runtime_attachment(agent.clone(), pending(), 3, None, None)
        .await
        .unwrap();
    assert_eq!(next.attachment_resource_version, 4);
    assert_eq!(
        service
            .set_runtime_attachment(agent.clone(), pending(), 1, None, None)
            .await,
        Err(ControlError::ResourceVersionConflict)
    );
    assert_eq!(service.agent_network(&agent).await.unwrap(), next);
}
