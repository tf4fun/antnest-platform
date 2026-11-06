use super::decode_runtime_spec;

const CURRENT: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/runtime/examples/runtime-spec.current.json"
));
const N_1: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../contracts/runtime/examples/runtime-spec.n-1.json"
));

fn with_future_fields(value: &serde_json::Value) -> serde_json::Value {
    match value {
        serde_json::Value::Object(map) => {
            let mut projected = serde_json::Map::new();
            projected.insert("x_future_field".to_string(), serde_json::Value::from(1));
            for (key, item) in map {
                projected.insert(key.clone(), with_future_fields(item));
            }
            serde_json::Value::Object(projected)
        }
        serde_json::Value::Array(items) => {
            serde_json::Value::Array(items.iter().map(with_future_fields).collect())
        }
        other => other.clone(),
    }
}

fn assert_known_fields(encoded: &str, spec: &crate::spec::RuntimeSpec) {
    let document: serde_json::Value = serde_json::from_str(encoded).unwrap();
    assert_eq!(spec.identity().agent_id(), "agent-1");
    assert_eq!(spec.identity().generation(), 7);
    assert_eq!(spec.listen().to_string(), "0.0.0.0:8093");
    let authentication = serde_json::to_value(
        spec.authentication()
            .expect("authentication descriptor required"),
    )
    .unwrap();
    assert_eq!(
        &authentication,
        document
            .get("authentication")
            .expect("golden document carries authentication")
    );
}

#[test]
fn runtime_spec_current_golden_decodes_marker_and_tolerates_extensions() {
    let spec = decode_runtime_spec(CURRENT).expect("current producer document must decode");
    assert_known_fields(CURRENT, &spec);
    let future = with_future_fields(&serde_json::from_str::<serde_json::Value>(CURRENT).unwrap());
    let extended = decode_runtime_spec(&serde_json::to_string(&future).unwrap())
        .expect("additive members must be ignored");
    assert_known_fields(CURRENT, &extended);
    assert_eq!(format!("{spec:?}"), format!("{extended:?}"));
}

#[test]
fn runtime_spec_n_1_golden_decodes_and_tolerates_extensions() {
    let spec = decode_runtime_spec(N_1).expect("n-1 producer document must decode");
    assert_known_fields(N_1, &spec);
    let future = with_future_fields(&serde_json::from_str::<serde_json::Value>(N_1).unwrap());
    let extended = decode_runtime_spec(&serde_json::to_string(&future).unwrap())
        .expect("additive members must be ignored");
    assert_known_fields(N_1, &extended);
    assert_eq!(format!("{spec:?}"), format!("{extended:?}"));
}

#[test]
fn runtime_spec_rejects_unsupported_schema_version_markers() {
    let document: serde_json::Value = serde_json::from_str(N_1).unwrap();
    for marker in [
        serde_json::json!(0),
        serde_json::json!(2),
        serde_json::Value::Null,
        serde_json::json!("1"),
        serde_json::json!(1.5),
        serde_json::json!(-1),
    ] {
        let mut mutated = document.clone();
        mutated
            .as_object_mut()
            .unwrap()
            .insert("schema_version".to_string(), marker.clone());
        assert!(
            decode_runtime_spec(&serde_json::to_string(&mutated).unwrap()).is_err(),
            "schema_version {marker} must be rejected"
        );
    }
}

#[test]
fn runtime_spec_rejects_invalid_known_fields_even_with_extensions() {
    let document: serde_json::Value = serde_json::from_str(N_1).unwrap();
    let mutators: [fn(&mut serde_json::Value); 7] = [
        |document| {
            document.as_object_mut().unwrap().remove("agent_id");
        },
        |document| {
            *document.get_mut("generation").unwrap() = serde_json::json!(0);
        },
        |document| {
            *document
                .get_mut("network")
                .and_then(|network| network.get_mut("egress_endpoint"))
                .and_then(|endpoint| endpoint.get_mut("port"))
                .unwrap() = serde_json::json!(0);
        },
        |document| {
            *document
                .get_mut("authentication")
                .and_then(|auth| auth.get_mut("callers_file"))
                .unwrap() = serde_json::json!(42);
        },
        |document| {
            *document
                .get_mut("authentication")
                .and_then(|auth| auth.get_mut("tunnel"))
                .and_then(|tunnel| tunnel.get_mut("key_id"))
                .unwrap() = serde_json::json!(42);
        },
        |document| {
            *document
                .get_mut("authentication")
                .and_then(|auth| auth.get_mut("callers_file"))
                .unwrap() = serde_json::json!("/tmp/callers.json");
        },
        |document| {
            *document
                .get_mut("authentication")
                .and_then(|auth| auth.get_mut("tunnel"))
                .and_then(|tunnel| tunnel.get_mut("key_id"))
                .unwrap() = serde_json::json!("rtk_invalid");
        },
    ];
    for mutate in mutators {
        let mut mutated = document.clone();
        mutate(&mut mutated);
        let extended = with_future_fields(&mutated);
        assert!(decode_runtime_spec(&serde_json::to_string(&extended).unwrap()).is_err());
    }
}

#[test]
fn runtime_spec_rejects_duplicate_members_and_trailing_documents() {
    assert!(decode_runtime_spec("{\"a\":1,\"a\":2}").is_err());
    assert!(decode_runtime_spec(&format!("{CURRENT} {{}}")).is_err());
}
