use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use axum::{Json, Router, middleware, routing::get};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::rand::{SecureRandom as _, SystemRandom};
use serde_json::json;
use sha2::{Digest as _, Sha256};
use tokio_util::sync::CancellationToken;

use crate::service_auth::{AdmissionState, Receiver, SERVICE_HEADER, admit_http};

#[tokio::test]
async fn real_http_mount_admission_precedes_dispatch_and_keeps_liveness_identity_free() {
    let tokens = [(); 2].map(|()| {
        let mut raw = [0_u8; 32];
        SystemRandom::new().fill(&mut raw).unwrap();
        URL_SAFE_NO_PAD.encode(raw)
    });
    let digest = |token: &str| {
        "sha256:".to_owned()
            + &Sha256::digest(token.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
    };
    let receiver = Receiver::parse(
        json!({
            "runtime-controller": [digest(&tokens[0])],
            "agent-acp-service": [digest(&tokens[1])]
        })
        .to_string()
        .as_bytes(),
        "antnest-runtime",
        false,
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let called = Arc::new(AtomicUsize::new(0));
    let observed = called.clone();
    let router = Router::new()
        .route(
            "/status/live",
            get(|| async { Json(json!({"status":"ready"})) }),
        )
        .fallback(move |request: axum::extract::Request| {
            let observed = observed.clone();
            async move {
                assert!(!request.headers().contains_key(SERVICE_HEADER));
                assert!(!request.headers().contains_key("antnest-caller-context"));
                assert!(!request.headers().contains_key("x-antnest-organization-id"));
                if matches!(
                    request.uri().path(),
                    "/internal/skill-maintenance/prepare"
                        | "/internal/skill-maintenance/install"
                        | "/internal/skill-temporary/install"
                ) {
                    assert_eq!(
                        request.headers().get("authorization").unwrap(),
                        "AntnestMaintenance independently-signed-ticket"
                    );
                }
                if request.uri().path() == "/mcp" {
                    assert!(!request.headers().contains_key("authorization"));
                }
                observed.fetch_add(1, Ordering::SeqCst);
                Json(json!({"agent_id":"agent-1", "execution_id":"execution-1"}))
            }
        })
        .layer(middleware::from_fn_with_state(
            AdmissionState::new(receiver, "antnest-runtime-agent-1".into(), address.port()),
            admit_http,
        ));
    let shutdown = CancellationToken::new();
    let stop = shutdown.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(stop.cancelled_owned())
            .await
            .unwrap()
    });
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let base = format!("http://{address}");
    for path in [
        "/mcp",
        "/mcp/session",
        "/status",
        "/internal/skill-maintenance/prepare",
        "/internal/skill-maintenance/install",
        "/internal/skill-temporary/install",
    ] {
        for method in [
            reqwest::Method::GET,
            reqwest::Method::POST,
            reqwest::Method::DELETE,
            reqwest::Method::HEAD,
            reqwest::Method::OPTIONS,
        ] {
            let response = client
                .request(method, format!("{base}{path}"))
                .header("Authorization", "Bearer unrelated-user-authority")
                .header("X-Antnest-Expected-Execution-ID", "execution-1")
                .header("Content-Type", "application/json")
                .body("{}")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 401, "{path}");
            assert_eq!(
                response.headers().get("www-authenticate").unwrap(),
                "Bearer realm=\"antnest-service\""
            );
            let body = response.bytes().await.unwrap();
            assert!(!String::from_utf8_lossy(&body).contains("agent-1"));
        }
    }
    assert_eq!(
        called.load(Ordering::SeqCst),
        0,
        "unauthenticated mount reached a dispatcher"
    );
    for path in [
        "/mcp",
        "/mcp/session",
        "/internal/skill-maintenance/prepare",
        "/internal/skill-maintenance/install",
        "/internal/skill-temporary/install",
    ] {
        let response = client
            .post(format!("{base}{path}"))
            .header(SERVICE_HEADER, format!("Bearer {}", tokens[0]))
            .header("Content-Type", "application/json")
            .body("{}")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 403);
        assert_eq!(
            response.json::<serde_json::Value>().await.unwrap()["code"],
            "caller_not_allowed"
        );
    }
    assert_eq!(called.load(Ordering::SeqCst), 0);
    for path in [
        "/mcp",
        "/internal/skill-maintenance/check",
        "/internal/skill-maintenance/digest",
        "/internal/skill-temporary/release",
    ] {
        for media in [
            None,
            Some("text/plain"),
            Some("application/json; charset=latin1"),
            Some("application/json, application/json"),
        ] {
            let mut request = client
                .post(format!("{base}{path}"))
                .header(SERVICE_HEADER, format!("Bearer {}", tokens[1]))
                .body("{}");
            if let Some(media) = media {
                request = request.header("Content-Type", media);
            }
            assert_eq!(
                request.send().await.unwrap().status(),
                415,
                "{path} {media:?}"
            );
        }
        for body in [
            b"{\"name\":1,\"name\":2}".as_slice(),
            b"{\"nested\":{\"name\":1,\"name\":2}}",
            b"{\"name\":\"\xff\"}",
            b"{} {}",
        ] {
            assert_eq!(
                client
                    .post(format!("{base}{path}"))
                    .header(SERVICE_HEADER, format!("Bearer {}", tokens[1]))
                    .header("Content-Type", "application/json")
                    .body(body.to_vec())
                    .send()
                    .await
                    .unwrap()
                    .status(),
                400
            );
        }
    }
    assert_eq!(called.load(Ordering::SeqCst), 0);
    for path in [
        "/internal/skill-maintenance/prepare",
        "/internal/skill-maintenance/install",
        "/internal/skill-temporary/install",
    ] {
        let response = client.post(format!("{base}{path}"))
            .header(SERVICE_HEADER, format!("Bearer {}", tokens[1]))
            .header("Content-Type", "multipart/form-data; boundary=skill-boundary")
            .header("Authorization", "AntnestMaintenance independently-signed-ticket")
            .header("Antnest-Caller-Context", "unsigned-context-must-be-stripped")
            .header("X-Antnest-Organization-ID", "untrusted-org")
            .body("--skill-boundary\r\nContent-Disposition: form-data; name=\"artifact\"\r\n\r\nbinary skill archive\r\n--skill-boundary--\r\n")
            .send().await.unwrap();
        assert_eq!(
            response.status(),
            200,
            "authenticated multipart Skill upload must reach its signed-ticket parser: {path}"
        );
    }
    for host in [
        "evil.example",
        "0.0.0.0:8093",
        "antnest-runtime-agent-2:8093",
        "localhost:1",
    ] {
        assert_eq!(
            client
                .get(format!("{base}/status"))
                .header(SERVICE_HEADER, format!("Bearer {}", tokens[0]))
                .header("Host", host)
                .send()
                .await
                .unwrap()
                .status(),
            403
        );
    }
    assert_eq!(called.load(Ordering::SeqCst), 3);
    for token in &tokens {
        assert_eq!(
            client
                .get(format!("{base}/status"))
                .header(SERVICE_HEADER, format!("Bearer {token}"))
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    for method in [
        reqwest::Method::GET,
        reqwest::Method::POST,
        reqwest::Method::DELETE,
    ] {
        assert_eq!(
            client
                .request(method, format!("{base}/mcp"))
                .header(SERVICE_HEADER, format!("Bearer {}", tokens[1]))
                .header("Authorization", "Bearer unrelated-user-authority")
                .header("Content-Type", "application/json; charset=utf-8")
                .body("{}")
                .send()
                .await
                .unwrap()
                .status(),
            200
        );
    }
    let live = client
        .get(format!("{base}/status/live"))
        .send()
        .await
        .unwrap();
    assert_eq!(live.status(), 200);
    assert_eq!(
        live.json::<serde_json::Value>().await.unwrap(),
        json!({"status":"ready"})
    );
    let live = client
        .head(format!("{base}/status/live"))
        .send()
        .await
        .unwrap();
    assert_eq!(live.status(), 200);
    assert!(live.bytes().await.unwrap().is_empty());
    assert_eq!(called.load(Ordering::SeqCst), 8);
    shutdown.cancel();
    server.await.unwrap();
}
