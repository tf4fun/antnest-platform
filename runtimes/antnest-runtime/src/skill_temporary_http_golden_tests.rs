use super::*;
use crate::skill_temporary::TemporaryInstalled;
use serde_json::Value;

const EXAMPLES: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/runtime/examples"
);

fn assert_golden(name: &str, actual: &Value) {
    let path = format!("{EXAMPLES}/{name}");
    if std::env::var("UPDATE_GOLDEN").as_deref() == Ok("1") {
        let rendered = serde_json::to_string_pretty(actual).expect("render golden");
        std::fs::write(&path, format!("{rendered}\n")).expect("write golden");
    }
    let expected: Value = serde_json::from_str(
        &std::fs::read_to_string(&path).expect("missing immutable golden capture"),
    )
    .expect("parse golden");
    assert_eq!(*actual, expected, "golden mismatch for {name}");
}

async fn body_value(response: axum::response::Response) -> Value {
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("response body");
    serde_json::from_slice(&bytes).expect("response JSON")
}

fn assert_headers(response: &axum::response::Response, status: StatusCode) {
    assert_eq!(response.status(), status);
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CACHE_CONTROL)
            .and_then(|v| v.to_str().ok()),
        Some("no-store")
    );
    assert_eq!(
        response
            .headers()
            .get(axum::http::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok()),
        Some("application/json")
    );
}

#[tokio::test]
async fn temporary_install_response_matches_producer_golden() {
    let installed = TemporaryInstalled {
        temporary_path: format!(
            "/workspace/.antnest/skill-temporary/v1/{}/{}/package",
            "c".repeat(64),
            "a".repeat(64)
        ),
        content_digest: format!("sha256:{}", "a".repeat(64)),
        artifact_digest: format!("sha256:{}", "b".repeat(64)),
        unpacked_size: 80,
    };
    let response = installed_response(
        &format!("request_{}", "1".repeat(32)),
        "run-1",
        "execution-1",
        installed,
    );
    assert_headers(&response, StatusCode::OK);
    assert_golden(
        "temporary-install.installed.json",
        &body_value(response).await,
    );
}

#[tokio::test]
async fn temporary_release_response_matches_producer_golden() {
    let response = released_response(
        &format!("release_{}", "1".repeat(32)),
        "run-1",
        "execution-1",
    );
    assert_headers(&response, StatusCode::OK);
    assert_golden(
        "temporary-release.released.json",
        &body_value(response).await,
    );
}

#[tokio::test]
async fn temporary_disabled_response_matches_producer_golden() {
    let response = failure_with_request_id(
        StatusCode::FORBIDDEN,
        crate::api_errors_gen::TEMPORARY_DISABLED,
        ToolEffectState::None,
        true,
        "request-golden-1",
    );
    assert_headers(&response, StatusCode::FORBIDDEN);
    assert_golden(
        "temporary-operation.disabled.json",
        &body_value(response).await,
    );
}
