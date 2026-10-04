use antnest_runtime_egress::service_auth::{
    AdmissionError, Mode, Receiver, valid_json_body, valid_json_media, valid_token,
};
use serde_json::Value;

fn fixtures() -> Value {
    serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/platform/service-token-fixtures.json"
    )))
    .unwrap()
}

#[test]
fn canonical_sender_bytes_match_all_shared_token_vectors() {
    for case in fixtures()["token_vectors"].as_array().unwrap() {
        assert_eq!(
            valid_token(case["token"].as_str().unwrap()),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn receiver_profiles_reject_semantic_duplicates_and_match_shared_vectors() {
    for case in fixtures()["configuration_vectors"].as_array().unwrap() {
        assert_eq!(
            Receiver::parse(
                case["callers_json"].as_str().unwrap().as_bytes(),
                case["receiver"].as_str().unwrap(),
                case["self_allowed"].as_bool().unwrap(),
            )
            .is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
    for raw in [
        b"{\"agent-controller\":[\"\xff\"]}".as_slice(),
        &[b' '; 8193],
    ] {
        assert!(Receiver::parse(raw, "runtime-egress", false).is_err());
    }
}

#[test]
fn every_shared_field_line_has_exactly_one_workload_outcome() {
    let fixtures = fixtures();
    for case in fixtures["header_vectors"].as_array().unwrap() {
        let receiver = Receiver::parse(
            fixtures["receiver_configurations"][case["configuration"].as_str().unwrap()]
                .to_string()
                .as_bytes(),
            "runtime-controller",
            false,
        )
        .unwrap();
        let fields = case["fields"]
            .as_array()
            .unwrap()
            .iter()
            .map(|field| {
                (
                    field["name"].as_str().unwrap(),
                    field["value"].as_str().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        let allowed = case["allowed_callers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|name| name.as_str().unwrap())
            .collect::<Vec<_>>();
        let result = receiver.authorize_fields(&fields, &allowed);
        match case["expected"]["http_status"].as_u64().unwrap() {
            200 => assert_eq!(
                result.unwrap(),
                case["expected"]["caller"].as_str().unwrap(),
                "{}",
                case["name"]
            ),
            401 => assert_eq!(result.unwrap_err(), AdmissionError::Unauthenticated),
            403 => assert_eq!(result.unwrap_err(), AdmissionError::Forbidden),
            _ => panic!("unknown shared outcome"),
        }
    }
}

#[test]
fn mode_and_insecure_flags_use_all_exact_shared_values() {
    for case in fixtures()["mode_vectors"].as_array().unwrap() {
        assert_eq!(
            Mode::parse(
                case["mode"].as_str(),
                case["allow_insecure_transport"].as_str(),
            )
            .and_then(|mode| mode.validate_transport(case["transport"] == "https"))
            .is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn control_json_is_a_bounded_utf8_object_with_unique_nested_names() {
    for raw in [
        br#"{"spec":{},"spec":{}}"#.as_slice(),
        br#"{"spec":{"action":"deny_all","\u0061ction":"allow_all"}}"#,
        br#"{"items":[{"a":1,"a":2}]}"#,
        b"{\"spec\":\"\xff\"}",
        b"{} {}",
        b"{} trailing",
        b"\xef\xbb\xbf{}",
        b"[]",
        b"null",
        b"42",
    ] {
        assert!(!valid_json_body(raw), "{raw:?}");
    }
    assert!(valid_json_body(
        br#"{"state":"closed","expected_resource_version":7}"#
    ));
    assert!(valid_json_body(
        br#"{"quoted":"[\\\"{}]","nested":[{"x":1}]}"#
    ));
    assert!(!valid_json_body(&vec![b' '; 4097]));
    let deep = format!("{{\"x\":{}0{}}}", "[".repeat(32), "]".repeat(32));
    assert!(!valid_json_body(deep.as_bytes()));
    let allowed = format!("{{\"x\":{}0{}}}", "[".repeat(31), "]".repeat(31));
    assert!(valid_json_body(allowed.as_bytes()));
}

#[test]
fn media_is_one_json_field_with_only_an_optional_utf8_charset() {
    for value in [
        "",
        "text/plain",
        "application/problem+json",
        "application/json, application/json",
        "application/json; charset=latin1",
        "application/json; charset=utf-8; charset=utf-8",
        "application/json; boundary=a",
    ] {
        assert!(!valid_json_media(&[value]), "{value}");
    }
    assert!(!valid_json_media(&[]));
    assert!(!valid_json_media(&["application/json", "application/json"]));
    for value in [
        "application/json",
        "Application/JSON",
        "application/json; charset=UTF-8",
        "application/json; charset=\"utf-8\"",
    ] {
        assert!(valid_json_media(&[value]), "{value}");
    }
}
