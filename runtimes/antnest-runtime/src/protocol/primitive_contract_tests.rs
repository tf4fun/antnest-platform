use super::types::{
    BashInput, EditFileInput, EnvironmentVariable, ReadFileInput, RootName, RootPath,
    WriteFileInput,
};
use crate::execution::{BashRequest, EditRequest, ReadRequest, WriteRequest};

#[test]
fn primitive_inputs_are_execution_intent_without_work_identity() {
    let bash: BashInput = serde_json::from_value(serde_json::json!({
        "command": "printf hello",
        "working_dir": {"root": "workspace", "path": "."},
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
    let workspace_file = RootPath {
        root: RootName::Workspace,
        path: "notes.txt".into(),
    };
    assert!(
        ReadRequest::try_from(ReadFileInput {
            path: workspace_file.clone(),
            offset: 0,
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
        path: RootPath {
            root: RootName::SystemSkills,
            path: "example/SKILL.md".into(),
        },
        content: String::new(),
    };
    assert!(WriteRequest::try_from(system_write).is_err());

    let duplicate_env = BashInput {
        command: "true".into(),
        working_dir: RootPath {
            root: RootName::Workspace,
            path: ".".into(),
        },
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
