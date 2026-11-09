use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use ring::signature::{Ed25519KeyPair, KeyPair};
use serde_json::{Value, json};
use std::collections::BTreeSet;

use crate::skill_maintenance_auth::{MaintenanceAuthError, verify_maintenance_ticket};
use crate::spec::{RuntimeIdentity, SkillMaintenanceVerifier};

const BODY: &[u8] =
    br#"{"action":"install","request_id":"request-1","job_id":"job-1","generation":1}"#;

pub(crate) fn fixture() -> (
    Ed25519KeyPair,
    RuntimeIdentity,
    Vec<SkillMaintenanceVerifier>,
) {
    let pair = Ed25519KeyPair::from_seed_unchecked(&[7; 32]).unwrap();
    let identity = RuntimeIdentity::new("agent-1", 1).unwrap();
    let verifier = SkillMaintenanceVerifier::new(
        "key-1".into(),
        pair.public_key().as_ref().try_into().unwrap(),
    );
    (pair, identity, vec![verifier])
}

pub(crate) fn signed(
    pair: &Ed25519KeyPair,
    body: &[u8],
    override_payload: impl FnOnce(&mut Value),
) -> String {
    use sha2::{Digest, Sha256};

    let digest = Sha256::digest(body)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let mut payload = json!({
        "organization_id": "org-1", "agent_id": "agent-1",
        "execution_id": "execution-1", "job_id": "job-1", "generation": 1,
        "action": "install", "request_id": "request-1",
        "body_sha256": format!("sha256:{digest}"),
        "issued_at": 1_790_000_000_u64, "expires_at": 1_790_000_060_u64
    });
    override_payload(&mut payload);
    let header = URL_SAFE_NO_PAD.encode(br#"{"version":1,"algorithm":"Ed25519","kid":"key-1"}"#);
    let payload = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&payload).unwrap());
    let message = format!("antnest-skill-maintenance-v1\n{header}.{payload}");
    let signature = URL_SAFE_NO_PAD.encode(pair.sign(message.as_bytes()).as_ref());
    format!("AntnestMaintenance {header}.{payload}.{signature}")
}

#[test]
fn verified_ticket_binds_current_runtime_action_body_and_time() {
    let (pair, identity, keys) = fixture();
    let token = signed(&pair, BODY, |_| {});
    let ticket = verify_maintenance_ticket(
        &token,
        BODY,
        "install",
        &identity,
        "execution-1",
        &keys,
        1_790_000_030,
    )
    .unwrap();
    assert_eq!(ticket.job_id, "job-1");
    assert_eq!(ticket.request_id, "request-1");
    assert_eq!(ticket.generation, 1);

    for (body, action, execution) in [
        (&b"altered"[..], "install", "execution-1"),
        (BODY, "digest", "execution-1"),
        (BODY, "install", "execution-2"),
    ] {
        assert_eq!(
            verify_maintenance_ticket(
                &token,
                body,
                action,
                &identity,
                execution,
                &keys,
                1_790_000_030
            ),
            Err(MaintenanceAuthError::Unauthorized)
        );
    }
    assert_eq!(
        verify_maintenance_ticket(
            &token,
            BODY,
            "install",
            &identity,
            "execution-1",
            &keys,
            1_790_000_091
        ),
        Err(MaintenanceAuthError::Unauthorized)
    );
}

#[test]
fn verification_fails_closed_for_missing_keys_or_noncanonical_credentials() {
    let (pair, identity, keys) = fixture();
    let token = signed(&pair, BODY, |_| {});
    assert_eq!(
        verify_maintenance_ticket(
            &token,
            BODY,
            "install",
            &identity,
            "execution-1",
            &[],
            1_790_000_030
        ),
        Err(MaintenanceAuthError::Disabled)
    );
    let replacement = if token.ends_with('A') { "B" } else { "A" };
    let tampered = format!("{}{replacement}", &token[..token.len() - 1]);
    for invalid in [
        String::new(),
        "Bearer invalid".into(),
        "AntnestMaintenance a.b.c".into(),
        token.replacen("AntnestMaintenance ", "AntnestMaintenance  ", 1),
        format!("{token}="),
        tampered,
    ] {
        assert_eq!(
            verify_maintenance_ticket(
                &invalid,
                BODY,
                "install",
                &identity,
                "execution-1",
                &keys,
                1_790_000_030
            ),
            Err(MaintenanceAuthError::Unauthorized)
        );
    }
    let wrong_agent = signed(&pair, BODY, |value| value["agent_id"] = json!("agent-2"));
    assert_eq!(
        verify_maintenance_ticket(
            &wrong_agent,
            BODY,
            "install",
            &identity,
            "execution-1",
            &keys,
            1_790_000_030
        ),
        Err(MaintenanceAuthError::Unauthorized)
    );
    let long_ttl = signed(&pair, BODY, |value| {
        value["expires_at"] = json!(1_790_000_061_u64)
    });
    assert_eq!(
        verify_maintenance_ticket(
            &long_ttl,
            BODY,
            "install",
            &identity,
            "execution-1",
            &keys,
            1_790_000_030
        ),
        Err(MaintenanceAuthError::Unauthorized)
    );
    let future = signed(&pair, BODY, |value| {
        value["issued_at"] = json!(1_790_000_061_u64)
    });
    assert_eq!(
        verify_maintenance_ticket(
            &future,
            BODY,
            "install",
            &identity,
            "execution-1",
            &keys,
            1_790_000_030
        ),
        Err(MaintenanceAuthError::Unauthorized)
    );
}

const MAINTENANCE_VECTORS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/runtime/maintenance-ticket-fixtures.json"
));

#[test]
fn shared_valid_vectors_sign_schema_clean_tickets_for_all_four_actions() {
    let (pair, identity, keys) = fixture();
    let vectors: Value = serde_json::from_str(MAINTENANCE_VECTORS).unwrap();
    assert_eq!(
        vectors["valid"]
            .as_array()
            .unwrap()
            .iter()
            .map(|vector| vector["action"].as_str().unwrap())
            .collect::<BTreeSet<_>>(),
        [
            "digest",
            "install",
            "temporary_install",
            "temporary_release"
        ]
        .into_iter()
        .collect::<BTreeSet<_>>()
    );
    for vector in vectors["valid"].as_array().unwrap() {
        let action = vector["action"].as_str().unwrap();
        let generation = vector["generation"].as_u64().unwrap();
        let token = signed(&pair, BODY, |payload| {
            payload["action"] = json!(action);
            payload["generation"] = json!(generation);
        });
        let ticket = verify_maintenance_ticket(
            &token,
            BODY,
            action,
            &identity,
            "execution-1",
            &keys,
            1_790_000_030,
        )
        .unwrap_or_else(|error| panic!("shared valid vector {vector} rejected: {error:?}"));
        assert_eq!(
            (ticket.action.as_str(), ticket.generation),
            (action, generation)
        );
        let encoded_payload = token
            .strip_prefix("AntnestMaintenance ")
            .and_then(|value| value.split('.').nth(1))
            .unwrap();
        let payload: Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded_payload).unwrap()).unwrap();
        crate::http_route_contract_tests::assert_valid(
            "maintenance-ticket.schema.json#/$defs/ticket",
            &payload,
        );
    }
}

#[test]
fn shared_invalid_vectors_and_temporary_generation_zero_fail_closed() {
    let (pair, identity, keys) = fixture();
    let vectors: Value = serde_json::from_str(MAINTENANCE_VECTORS).unwrap();
    for vector in vectors["invalid"].as_array().unwrap() {
        let action = vector["action"].as_str().unwrap();
        let generation = vector["generation"].as_u64().unwrap();
        let token = signed(&pair, BODY, |payload| {
            payload["action"] = json!(action);
            payload["generation"] = json!(generation);
        });
        assert_eq!(
            verify_maintenance_ticket(
                &token,
                BODY,
                action,
                &identity,
                "execution-1",
                &keys,
                1_790_000_030
            ),
            Err(MaintenanceAuthError::Unauthorized),
            "shared invalid vector {vector} accepted"
        );
    }
    for action in ["temporary_install", "temporary_release"] {
        let token = signed(&pair, BODY, |payload| {
            payload["action"] = json!(action);
            payload["generation"] = json!(0);
        });
        assert_eq!(
            verify_maintenance_ticket(
                &token,
                BODY,
                action,
                &identity,
                "execution-1",
                &keys,
                1_790_000_030
            ),
            Err(MaintenanceAuthError::Unauthorized),
            "temporary action {action} accepted at generation zero"
        );
    }
}

#[test]
fn a_signed_ticket_cannot_serve_another_route_action() {
    let (pair, identity, keys) = fixture();
    let vectors: Value = serde_json::from_str(MAINTENANCE_VECTORS).unwrap();
    for vector in vectors["valid"].as_array().unwrap() {
        let action = vector["action"].as_str().unwrap();
        let generation = vector["generation"].as_u64().unwrap();
        let token = signed(&pair, BODY, |payload| {
            payload["action"] = json!(action);
            payload["generation"] = json!(generation);
        });
        for other in vectors["valid"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|entry| entry["action"].as_str())
            .filter(|other| *other != action)
            .collect::<BTreeSet<_>>()
        {
            assert_eq!(
                verify_maintenance_ticket(
                    &token,
                    BODY,
                    other,
                    &identity,
                    "execution-1",
                    &keys,
                    1_790_000_030
                ),
                Err(MaintenanceAuthError::Unauthorized),
                "ticket for {action} accepted under route action {other}"
            );
        }
    }
}
