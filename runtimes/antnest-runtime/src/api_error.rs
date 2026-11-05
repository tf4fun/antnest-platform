use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

pub(crate) fn http_response(status: StatusCode, envelope: serde_json::Value) -> Response {
    let request_id = envelope["request_id"]
        .as_str()
        .unwrap_or_default()
        .to_owned();
    let mut response = (status, axum::Json(envelope)).into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(&request_id) {
        response.headers_mut().insert("x-request-id", value);
    }
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    response
}
