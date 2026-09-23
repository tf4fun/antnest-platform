use rmcp::model::InputRequiredResult;
use serde_json::{Value, json};

fn requirement(params: Value) -> Value {
    json!({
        "resultType": "input_required",
        "inputRequests": {"answer": {"method": "elicitation/create", "params": params}},
        "requestState": "opaque-state-canary"
    })
}

fn url_requirement() -> Value {
    requirement(json!({
        "mode": "url",
        "message": "Authorize access",
        "url": "https://example.com/authorize"
    }))
}

#[test]
fn standard_form_roundtrips_with_opaque_state() {
    let input = requirement(json!({
        "mode": "form",
        "message": "Select a name",
        "requestedSchema": {
            "type": "object",
            "properties": {"name": {"type": "string", "minLength": 1, "maxLength": 50}},
            "required": ["name"]
        }
    }));
    let typed: InputRequiredResult = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), input);
}

#[test]
fn standard_url_without_legacy_id_still_exposes_upstream_gap() {
    // A failure here means the deferral must be revisited, not worked around.
    assert!(
        serde_json::from_value::<InputRequiredResult>(url_requirement()).is_err(),
        "The SDK now accepts standard URL input: revisit F07 and test transport boundaries"
    );
}

#[test]
fn adding_only_legacy_id_makes_the_same_url_roundtrip() {
    let mut input = url_requirement();
    input["inputRequests"]["answer"]["params"]["elicitationId"] = json!("legacy-id");
    let typed: InputRequiredResult = serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(typed).unwrap(), input);
}
