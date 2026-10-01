use super::types::{BashInput, EditFileInput, EnvironmentVariable, ReadFileInput, WriteFileInput};
use crate::execution::{BashRequest, EditRequest, ReadRequest, WriteRequest};

#[test]
fn model_facing_file_arguments_use_string_paths_and_safe_defaults() {
    let read: ReadFileInput = serde_json::from_value(serde_json::json!({
        "path": "demo/check.md"
    }))
    .expect("read only requires a string path");
    let request = ReadRequest::try_from(read).unwrap();
    assert_eq!(request.path().root(), crate::execution::RootName::Workspace);
    assert_eq!(request.path().path(), "demo/check.md");
    assert_eq!(request.offset(), 1);
    assert_eq!(request.limit(), 2000);

    let bash: BashInput = serde_json::from_value(serde_json::json!({
        "command": "pwd"
    }))
    .expect("bash only requires a command");
    let request = BashRequest::try_from(bash).unwrap();
    assert_eq!(request.working_dir().path(), ".");
    assert_eq!(request.timeout().as_millis(), 120000);
}

#[test]
fn string_paths_still_enforce_named_root_boundaries() {
    for path in ["demo/x", "/workspace/demo/x", "~/demo/x"] {
        let input: ReadFileInput = serde_json::from_value(serde_json::json!({
            "path": path
        }))
        .unwrap();
        let request = ReadRequest::try_from(input).unwrap();
        assert_eq!(request.path().root(), crate::execution::RootName::Workspace);
        assert_eq!(request.path().path(), "demo/x");
    }
    let input: ReadFileInput = serde_json::from_value(serde_json::json!({
        "path": "/skills/demo/SKILL.md"
    }))
    .unwrap();
    assert_eq!(
        ReadRequest::try_from(input).unwrap().path().root(),
        crate::execution::RootName::SystemSkills
    );
    for path in [
        "../outside",
        "/workspace/../outside",
        "/skills/../outside",
        "/etc/passwd",
        "x\u{0000}y",
    ] {
        let input: ReadFileInput =
            serde_json::from_value(serde_json::json!({"path": path})).unwrap();
        assert!(ReadRequest::try_from(input).is_err(), "{path:?}");
    }
    let input: WriteFileInput = serde_json::from_value(serde_json::json!({
        "path": "/skills/demo/SKILL.md", "content": "changed"
    }))
    .unwrap();
    assert!(WriteRequest::try_from(input).is_err());
}

#[test]
fn primitive_inputs_are_execution_intent_without_work_identity() {
    let bash: BashInput = serde_json::from_value(serde_json::json!({
        "command": "printf hello",
        "working_dir": ".",
        "env": [{"name": "LANG", "value": "C.UTF-8"}],
        "timeout_ms": 1000
    }))
    .expect("decode minimal bash input");
    assert!(BashRequest::try_from(bash.clone()).is_ok());

    let mut value = serde_json::to_value(&bash).expect("encode bash");
    value["work_id"] = serde_json::json!("legacy");
    assert!(serde_json::from_value::<BashInput>(value).is_err());
}

#[test]
fn exactly_four_primitive_inputs_keep_the_sandbox_boundary() {
    let workspace_file = "notes.txt".to_owned();
    assert!(
        ReadRequest::try_from(ReadFileInput {
            path: workspace_file.clone(),
            offset: 1,
            limit: 1024,
        })
        .is_ok()
    );
    assert!(
        WriteRequest::try_from(WriteFileInput {
            path: workspace_file.clone(),
            content: "before".into(),
        })
        .is_ok()
    );
    assert!(
        EditRequest::try_from(EditFileInput {
            path: workspace_file,
            old_string: "before".into(),
            new_string: "after".into(),
        })
        .is_ok()
    );

    let system_write = WriteFileInput {
        path: "/skills/example/SKILL.md".into(),
        content: String::new(),
    };
    assert!(WriteRequest::try_from(system_write).is_err());

    let duplicate_env = BashInput {
        command: "true".into(),
        working_dir: ".".into(),
        env: vec![
            EnvironmentVariable {
                name: "DUP".into(),
                value: "1".into(),
            },
            EnvironmentVariable {
                name: "DUP".into(),
                value: "2".into(),
            },
        ],
        timeout_ms: 1000,
    };
    assert!(BashRequest::try_from(duplicate_env).is_err());
}

#[test]
fn published_input_shapes_match_the_shared_tool_contract() {
    let contract: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/builtin-tools.schema.json"
    )))
    .unwrap();
    for (name, actual) in [
        (
            "read",
            serde_json::to_value(schemars::schema_for!(ReadFileInput)).unwrap(),
        ),
        (
            "write",
            serde_json::to_value(schemars::schema_for!(WriteFileInput)).unwrap(),
        ),
        (
            "edit",
            serde_json::to_value(schemars::schema_for!(EditFileInput)).unwrap(),
        ),
        (
            "bash",
            serde_json::to_value(schemars::schema_for!(BashInput)).unwrap(),
        ),
    ] {
        let expected = &contract["$defs"][name];
        assert_eq!(actual["required"], expected["required"], "{name}");
        assert_eq!(
            actual["additionalProperties"], expected["additionalProperties"],
            "{name}"
        );
        for (field, shape) in expected["properties"].as_object().unwrap() {
            for keyword in [
                "type",
                "minLength",
                "maxLength",
                "minimum",
                "maximum",
                "default",
            ] {
                if let Some(value) = shape.get(keyword) {
                    let emitted = &actual["properties"][field][keyword];
                    if value.is_number() {
                        assert_eq!(emitted.as_f64(), value.as_f64(), "{name}.{field}.{keyword}");
                    } else {
                        assert_eq!(emitted, value, "{name}.{field}.{keyword}");
                    }
                }
            }
        }
    }
}
