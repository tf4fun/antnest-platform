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
