#![cfg(target_os = "linux")]

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::path::Path;
use std::process::{Command, Stdio};

use nix::unistd::{Gid, Uid, chown, getuid};
use serde_json::{Value, json};

#[test]
fn explicit_tool_subcommands_execute_as_the_agent_user() {
    if !getuid().is_root() {
        eprintln!("executor boundary test requires a root Linux build environment");
        return;
    }

    let root = tempfile::tempdir().expect("temporary Runtime roots");
    let workspace = root.path().join("workspace");
    let system_skills = root.path().join("skills");
    fs::create_dir_all(&workspace).expect("workspace root");
    fs::create_dir_all(&system_skills).expect("system Skill root");
    make_traversable(root.path());
    make_agent_owned(&workspace);
    fs::set_permissions(&system_skills, fs::Permissions::from_mode(0o555))
        .expect("read-only system Skill root");

    let write = invoke(
        "write",
        &workspace,
        &system_skills,
        json!({
            "path": {"root": "workspace", "path": "notes/answer.txt"},
            "content": "hello from executor"
        }),
    );
    assert_eq!(write["status"], "success");
    assert_eq!(write["result"]["bytes_written"], 19);
    assert_eq!(
        fs::read_to_string(workspace.join("notes/answer.txt")).unwrap(),
        "hello from executor"
    );
    let metadata = fs::metadata(workspace.join("notes/answer.txt")).unwrap();
    assert_eq!((metadata.uid(), metadata.gid()), (1000, 1000));

    let bash = invoke(
        "bash",
        &workspace,
        &system_skills,
        json!({
            "command": "printf '%s:%s' \"$(id -u)\" \"$(id -g)\"",
            "working_dir": {"root": "workspace", "path": "."},
            "env": [],
            "timeout_ms": 5000
        }),
    );
    assert_eq!(bash["status"], "success");
    assert_eq!(bash["result"]["exit_code"], 0);
    assert_eq!(bash["result"]["stdout"], "1000:1000");

    let read = invoke(
        "read",
        &workspace,
        &system_skills,
        json!({
            "path": {"root": "workspace", "path": "notes/answer.txt"},
            "offset": 0,
            "limit": 1024
        }),
    );
    assert_eq!(read["status"], "success");
    assert_eq!(read["result"]["content"], "hello from executor");

    let instructions = workspace.join("AGENTS.md");
    fs::write(&instructions, "ROOT-ONLY-INSTRUCTIONS").unwrap();
    fs::set_permissions(&instructions, fs::Permissions::from_mode(0o600)).unwrap();
    let private = invoke("info", &workspace, &system_skills, json!({}));
    assert_eq!(private["status"], "success");
    assert!(private["result"]["instructions"].is_null());
    assert_eq!(private["result"]["warnings"][0]["code"], "unreadable");
    assert!(!private.to_string().contains("ROOT-ONLY-INSTRUCTIONS"));

    make_agent_owned(&instructions);
    let readable = invoke("info", &workspace, &system_skills, json!({}));
    assert_eq!(
        readable["result"]["instructions"]["content"],
        "ROOT-ONLY-INSTRUCTIONS"
    );
    assert_eq!(
        readable["result"]["environment"]["home"],
        workspace.to_str().unwrap()
    );
}

fn invoke(command: &str, workspace: &Path, system_skills: &Path, input: Value) -> Value {
    let mut child = Command::new(env!("CARGO_BIN_EXE_antnest-runtime"))
        .arg(command)
        .env_clear()
        .env("HOME", workspace)
        .env("PATH", "/usr/local/bin:/usr/bin:/bin")
        .env("ANTNEST_RUNTIME_WORKSPACE", workspace)
        .env("ANTNEST_RUNTIME_SYSTEM_SKILLS", system_skills)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn Runtime tool subcommand");
    child
        .stdin
        .take()
        .expect("executor stdin")
        .write_all(&serde_json::to_vec(&input).unwrap())
        .expect("write executor request");
    let output = child.wait_with_output().expect("wait for Runtime tool");
    assert!(
        output.status.success(),
        "executor failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).expect("executor JSON response")
}

fn make_traversable(path: &Path) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("traversable test root");
}

fn make_agent_owned(path: &Path) {
    chown(path, Some(Uid::from_raw(1000)), Some(Gid::from_raw(1000)))
        .expect("Agent-owned workspace");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("workspace permissions");
}
