use serde_json::json;

use crate::command::{Command, CommandError, ToolCommand};
use crate::execution_actor::SingleFlight;
use crate::executor_protocol::{ExecutorFailure, ExecutorReply, Outcome};
use crate::tool_error::ToolErrorCode;

#[test]
fn release_dockerfile_stage_has_no_features() {
    let dockerfile = include_str!("../Dockerfile");
    let stages = dockerfile.split("\nFROM ").collect::<Vec<_>>();
    assert!(
        stages
            .last()
            .unwrap()
            .lines()
            .next()
            .unwrap()
            .ends_with(" AS release"),
        "default Docker target must be release"
    );
    let build = stages
        .iter()
        .find(|stage| stage.lines().next().unwrap().ends_with(" AS build"))
        .expect("release build stage");
    assert!(build.contains("cargo build --locked --release"));
    assert!(
        !build.contains("--features"),
        "release build may not enable Cargo features"
    );
    assert!(
        !build.contains("ANTNEST_RUNTIME_FEATURES"),
        "release build may not consume the E2E argument"
    );
    let release = stages.last().unwrap();
    assert!(release.contains("COPY --from=build /tmp/antnest-runtime "));
    assert!(release.contains("LABEL dev.antnest.runtime.test-features=\"\""));
    assert!(!release.contains("ALLOW_TEST_FEATURES"));
}

#[test]
fn e2e_dockerfile_target_is_explicit_and_identifiable() {
    let dockerfile = include_str!("../Dockerfile");
    let stages = dockerfile.split("\nFROM ").collect::<Vec<_>>();
    let build = stages
        .iter()
        .find(|stage| stage.lines().next().unwrap() == "build AS build-e2e")
        .expect("separate E2E build stage");
    assert!(build.contains("ARG ANTNEST_RUNTIME_FEATURES\n"));
    assert!(build.contains("cargo test --locked --features"));
    let e2e = stages
        .iter()
        .find(|stage| stage.lines().next().unwrap() == "runtime-base AS e2e")
        .expect("explicit E2E image target");
    assert!(e2e.contains("COPY --from=build-e2e /tmp/antnest-runtime-e2e "));
    assert!(
        e2e.contains("LABEL dev.antnest.runtime.test-features=\"${ANTNEST_RUNTIME_FEATURES}\"")
    );
    assert!(e2e.contains("ENV ANTNEST_RUNTIME_ALLOW_TEST_FEATURES=true"));
    let base = stages
        .iter()
        .find(|stage| stage.lines().next().unwrap().ends_with(" AS runtime-base"))
        .expect("common image base");
    assert!(!base.contains("ALLOW_TEST_FEATURES"));
}

#[test]
fn process_execution_core_does_not_import_mcp_transport_types() {
    for (name, source) in [
        ("execution_actor", include_str!("execution_actor.rs")),
        ("executor", include_str!("executor.rs")),
    ] {
        assert!(
            !source.contains("crate::protocol"),
            "{name} must depend on execution requests, not MCP DTOs"
        );
    }
}

#[test]
fn network_transport_is_registered_before_the_service_can_be_ready() {
    let source = include_str!("network_session.rs");
    let connect = source
        .split_once("fn connect(")
        .expect("UDP transport constructor")
        .1
        .split_once("async fn run(")
        .expect("network run loop")
        .0;

    assert!(
        connect.contains("AsyncFd::new"),
        "TUN reactor registration must be part of transport construction"
    );
}

#[test]
fn release_build_preserves_executor_panic_containment() {
    let manifest = include_str!("../Cargo.toml");
    let release_profile = manifest
        .split_once("[profile.release]")
        .expect("release profile")
        .1;

    assert!(
        !release_profile.lines().any(|line| {
            let setting = line.split('#').next().unwrap_or_default().trim();
            setting == "panic = \"abort\"" || setting == "panic='abort'"
        }),
        "release panic=abort bypasses Execution Actor poisoning and fatal telemetry"
    );
}

#[test]
fn runtime_commands_are_explicit_and_closed() {
    assert_eq!(Command::parse(["serve"]), Ok(Command::Serve));
    assert_eq!(Command::parse(["mcp-stdio"]), Ok(Command::McpStdio));
    assert!(Command::parse(["mcp-stdio", "node"]).is_err());
    assert_eq!(
        Command::parse(["bash"]),
        Ok(Command::Tool(ToolCommand::Bash))
    );
    assert_eq!(
        Command::parse(["read"]),
        Ok(Command::Tool(ToolCommand::Read))
    );
    assert_eq!(
        Command::parse(["write"]),
        Ok(Command::Tool(ToolCommand::Write))
    );
    assert_eq!(
        Command::parse(["edit"]),
        Ok(Command::Tool(ToolCommand::Edit))
    );
    assert_eq!(
        Command::parse(std::iter::empty::<&str>()),
        Err(CommandError::Missing)
    );
    assert_eq!(
        Command::parse(["execute", "write"]),
        Err(CommandError::UnexpectedArguments)
    );
    assert_eq!(
        Command::parse(["unknown"]),
        Err(CommandError::Unknown("unknown".into()))
    );
}

#[test]
fn tool_commands_map_to_fixed_process_arguments() {
    assert_eq!(ToolCommand::Bash.as_str(), "bash");
    assert_eq!(ToolCommand::Read.as_str(), "read");
    assert_eq!(ToolCommand::Write.as_str(), "write");
    assert_eq!(ToolCommand::Edit.as_str(), "edit");
}

#[test]
fn information_command_is_read_only_and_accepts_no_selection_parameters() {
    assert_eq!(
        Command::parse(["info"]),
        Ok(Command::Tool(ToolCommand::Info))
    );
    assert_eq!(ToolCommand::Info.as_str(), "info");
    assert!(!ToolCommand::Info.may_have_side_effects());
    assert!(crate::executor_protocol::decode_info_request(b"{}").is_ok());
    assert!(crate::executor_protocol::decode_info_request(b"{\"path\":\"/root\"}").is_err());
    assert!(crate::executor_protocol::decode_info_request(b"null").is_err());
}

#[test]
fn executor_reply_has_one_unambiguous_json_envelope() {
    let success = ExecutorReply::Success {
        result: json!({"bytes_written": 5}),
    };
    assert_eq!(
        serde_json::to_value(success).unwrap(),
        json!({"status": "success", "result": {"bytes_written": 5}})
    );

    let failure: ExecutorReply<serde_json::Value> = ExecutorReply::Failure {
        error: ExecutorFailure {
            code: ToolErrorCode::WriteFailed,
            message: "disk full".into(),
            outcome: Outcome::Known,
        },
    };
    let encoded = serde_json::to_value(&failure).unwrap();
    assert_eq!(
        encoded,
        json!({
            "status": "failure",
            "error": {
                "code": "write_failed",
                "message": "disk full",
                "outcome": "known"
            }
        })
    );
    assert_eq!(
        serde_json::from_value::<ExecutorReply<serde_json::Value>>(encoded).unwrap(),
        failure
    );
}

#[test]
fn runtime_single_flight_rejects_instead_of_queueing() {
    let gate = SingleFlight::new();
    let lease = gate.try_acquire().expect("first execution lease");
    assert_eq!(
        gate.try_acquire()
            .expect_err("concurrent call must fail")
            .code(),
        ToolErrorCode::RuntimeBusy
    );
    drop(lease);
    assert!(gate.try_acquire().is_ok());
}

#[test]
fn runtime_admission_terminal_states_cannot_be_reopened_by_a_lease() {
    let closing = SingleFlight::new();
    let lease = closing.try_acquire().expect("active execution lease");
    closing.close();
    drop(lease);
    assert_eq!(
        closing
            .try_acquire()
            .expect_err("closed Runtime must reject new work")
            .code(),
        ToolErrorCode::RuntimeUnavailable
    );

    let poisoned = SingleFlight::new();
    let lease = poisoned.try_acquire().expect("active execution lease");
    poisoned.poison();
    drop(lease);
    assert_eq!(
        poisoned
            .try_acquire()
            .expect_err("poisoned Runtime must reject new work")
            .code(),
        ToolErrorCode::RuntimeUnavailable
    );
}

#[tokio::test]
async fn runtime_shutdown_waits_for_the_active_execution_lease() {
    let gate = SingleFlight::new();
    let lease = gate.try_acquire().expect("active execution lease");
    let draining_gate = gate.clone();
    let draining = tokio::spawn(async move { draining_gate.close_and_drain().await });
    tokio::task::yield_now().await;
    assert!(!draining.is_finished());

    drop(lease);
    tokio::time::timeout(std::time::Duration::from_secs(1), draining)
        .await
        .expect("Runtime drain deadline")
        .expect("join Runtime drain")
        .expect("clean Runtime drain");
    assert_eq!(
        gate.try_acquire()
            .expect_err("drained Runtime must remain closed")
            .code(),
        ToolErrorCode::RuntimeUnavailable
    );
}

#[tokio::test]
async fn poisoned_runtime_reports_failure_after_the_active_lease_releases() {
    let gate = SingleFlight::new();
    let lease = gate.try_acquire().expect("active execution lease");
    let draining_gate = gate.clone();
    let draining = tokio::spawn(async move { draining_gate.close_and_drain().await });
    gate.poison();
    drop(lease);

    tokio::time::timeout(std::time::Duration::from_secs(1), draining)
        .await
        .expect("Runtime drain deadline")
        .expect("join Runtime drain")
        .expect_err("poisoned Runtime drain must fail");
}
