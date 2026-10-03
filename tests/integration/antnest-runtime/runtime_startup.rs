use std::process::Command;

use serde_json::Value;
#[cfg(feature = "skill-maintenance-e2e-gate")]
use serde_json::json;

fn serve(opt_in: Option<&str>) -> Vec<Value> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_antnest-runtime"));
    command.arg("serve").env_clear();
    if let Some(value) = opt_in {
        command.env("ANTNEST_RUNTIME_ALLOW_TEST_FEATURES", value);
    }
    // No RuntimeSpec: after admission, ordinary bootstrap must stop before any
    // network resources, listener, executor or managed child can be created.
    let output = command.output().expect("invoke Runtime serve");
    assert_eq!(output.status.code(), Some(78));
    assert!(output.stdout.is_empty());
    String::from_utf8(output.stderr)
        .expect("structured startup diagnostics")
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect()
}

#[test]
#[cfg(feature = "skill-maintenance-e2e-gate")]
fn gated_binary_rejects_every_non_exact_opt_in_before_bootstrap() {
    for value in [
        None,
        Some("false"),
        Some(""),
        Some(" "),
        Some(" true "),
        Some("TRUE"),
        Some("1"),
    ] {
        let events = serve(value);
        let failure = events.last().expect("startup failure");
        assert_eq!(
            failure["error.type"], "invalid_config",
            "{value:?}: {events:?}"
        );
        assert_eq!(failure["bootstrap.stage"], "entry");
        let reason = failure["reason"].as_str().unwrap();
        assert!(reason.contains("ANTNEST_RUNTIME_ALLOW_TEST_FEATURES=true"));
        assert!(reason.contains("skill-maintenance-e2e-gate"));
        assert_eq!(events.len(), 1, "rejection must precede ordinary bootstrap");
    }
}

#[test]
#[cfg(feature = "skill-maintenance-e2e-gate")]
fn permitted_test_binary_logs_one_feature_warning_before_ordinary_bootstrap() {
    let events = serve(Some("true"));
    let warnings = events
        .iter()
        .filter(|event| event["lifecycle.event"] == "test_features_enabled")
        .collect::<Vec<_>>();
    assert_eq!(warnings.len(), 1, "{events:?}");
    assert_eq!(warnings[0]["level"], "WARN");
    assert_eq!(
        warnings[0]["test_features"],
        json!(["skill-maintenance-e2e-gate"])
    );
    assert_ne!(events.last().unwrap()["error.type"], "invalid_config");
}

#[test]
#[cfg(not(feature = "skill-maintenance-e2e-gate"))]
fn release_binary_reaches_ordinary_bootstrap_without_test_feature_admission() {
    for value in [None, Some("true"), Some("false"), Some(" true ")] {
        let events = serve(value);
        assert!(!events.is_empty());
        assert!(
            events
                .iter()
                .all(|event| event["lifecycle.event"] != "test_features_enabled")
        );
        assert!(
            !events.last().unwrap()["reason"]
                .as_str()
                .unwrap()
                .contains("ANTNEST_RUNTIME_ALLOW_TEST_FEATURES")
        );
    }
}
