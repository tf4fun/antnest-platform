#![cfg(target_os = "linux")]

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{MetadataExt as _, PermissionsExt as _};
use std::os::unix::process::CommandExt as _;
use std::path::Path;
use std::process::{Command, Stdio};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use nix::unistd::{Gid, Uid, chown, getuid};
use serde_json::{Value, json};
use zip::{ZipWriter, write::SimpleFileOptions};

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
        write["result"]["file"]["path"],
        workspace.join("notes/answer.txt").to_str().unwrap()
    );
    assert_eq!(write["result"]["file"]["change"]["kind"], "text");
    assert!(write["result"]["file"]["change"]["before"].is_null());
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
            "offset": 1,
            "limit": 1024
        }),
    );
    assert_eq!(read["status"], "success");
    assert_eq!(read["result"]["content"], "hello from executor");
    assert!(read["result"]["file"]["change"].is_null());

    let unreadable = workspace.join("root-only.txt");
    fs::write(&unreadable, "ROOT-ONLY-BEFORE").unwrap();
    fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o600)).unwrap();
    let replacement = invoke(
        "write",
        &workspace,
        &system_skills,
        json!({
            "path": {"root": "workspace", "path": "root-only.txt"}, "content": "agent replacement"
        }),
    );
    assert_eq!(replacement["status"], "success");
    assert_eq!(
        replacement["result"]["file"]["change"]["kind"],
        "unavailable"
    );
    assert!(!replacement.to_string().contains("ROOT-ONLY-BEFORE"));
    assert_eq!(fs::read_to_string(unreadable).unwrap(), "agent replacement");

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

#[test]
fn temporary_package_executes_as_uid_1000_and_release_preserves_user_files() {
    if !getuid().is_root() {
        eprintln!("executor boundary test requires a root Linux build environment");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let system_skills = root.path().join("skills");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&system_skills).unwrap();
    make_traversable(root.path());
    make_agent_owned(&workspace);
    let skill = b"---\nname: temporary-check\ndescription: A real temporary script\n---\nRun scripts/check.sh.\n";
    let script = b"#!/bin/sh\nprintf 'temporary-executor-ok\\n'\n";
    let files = [
        ("SKILL.md", skill.as_slice(), false),
        ("scripts/check.sh", script.as_slice(), true),
    ];
    let mut zip = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let mut canonical = sha2::Sha256::new();
    use sha2::Digest as _;
    canonical.update(b"antnest-skill-manifest-v1\0");
    for (path, data, executable) in files {
        zip.start_file(
            path,
            SimpleFileOptions::default().unix_permissions(if executable { 0o755 } else { 0o644 }),
        )
        .unwrap();
        zip.write_all(data).unwrap();
        canonical.update((path.len() as u32).to_be_bytes());
        canonical.update(path.as_bytes());
        canonical.update((data.len() as u64).to_be_bytes());
        canonical.update(sha2::Sha256::digest(data));
        canonical.update([u8::from(executable)]);
    }
    let archive = zip.finish().unwrap().into_inner();
    let hex = |bytes: &[u8]| {
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let request = json!({"agent_id":"agent1","execution_id":"execution1","job_id":"run1","request_id":"load1","content_digest":format!("sha256:{}",hex(&canonical.finalize())),"artifact_digest":format!("sha256:{}",hex(&sha2::Sha256::digest(&archive))),"artifact_base64":STANDARD.encode(&archive)});
    let installed = invoke(
        "skill-temporary-install",
        &workspace,
        &system_skills,
        request.clone(),
    );
    assert_eq!(installed["status"], "success", "{installed}");
    let relative = installed["result"]["temporary_path"]
        .as_str()
        .unwrap()
        .strip_prefix("/workspace/")
        .unwrap();
    let package = workspace.join(relative);
    assert_eq!(fs::metadata(package.join("SKILL.md")).unwrap().uid(), 1000);
    assert_eq!(
        fs::metadata(package.join("scripts/check.sh"))
            .unwrap()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        invoke(
            "skill-temporary-install",
            &workspace,
            &system_skills,
            request
        )["result"],
        installed["result"]
    );
    let bash = invoke(
        "bash",
        &workspace,
        &system_skills,
        json!({"command":"./scripts/check.sh","working_dir":{"root":"workspace","path":relative},"env":[],"timeout_ms":3000}),
    );
    assert_eq!(bash["status"], "success", "{bash}");
    assert_eq!(bash["result"]["stdout"], "temporary-executor-ok\n");
    let user_attempt = Command::new(env!("CARGO_BIN_EXE_antnest-runtime"))
        .arg("skill-temporary-release")
        .uid(1000)
        .gid(1000)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert_eq!(user_attempt.status.code(), Some(77));
    assert!(package.exists());
    fs::write(workspace.join("user.txt"), "keep").unwrap();
    let release = json!({"agent_id":"agent1","execution_id":"execution1","job_id":"run1"});
    assert_eq!(
        invoke(
            "skill-temporary-release",
            &workspace,
            &system_skills,
            release.clone()
        )["status"],
        "success"
    );
    assert_eq!(
        invoke(
            "skill-temporary-release",
            &workspace,
            &system_skills,
            release
        )["status"],
        "success"
    );
    assert!(!package.exists());
    assert_eq!(
        fs::read_to_string(workspace.join("user.txt")).unwrap(),
        "keep"
    );
}

#[test]
fn skill_install_is_written_by_uid_1000_with_one_rename_and_resends_settle() {
    if !getuid().is_root() {
        eprintln!("executor boundary test requires a root Linux build environment");
        return;
    }
    let root = tempfile::tempdir().expect("temporary Runtime roots");
    let workspace = root.path().join("workspace");
    let system_skills = root.path().join("skills");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&system_skills).unwrap();
    make_traversable(root.path());
    make_agent_owned(&workspace);
    fs::set_permissions(&system_skills, fs::Permissions::from_mode(0o555)).unwrap();

    let skill = b"---\nname: retry-timeouts\ndescription: Retry safely\n---\n";
    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    writer.write_all(skill).unwrap();
    let archive = writer.finish().unwrap().into_inner();
    let hex = |bytes: &[u8]| {
        use sha2::{Digest as _, Sha256};
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    };
    let target = {
        use sha2::{Digest as _, Sha256};
        let mut canonical = Sha256::new();
        canonical.update(b"antnest-skill-manifest-v1\0");
        canonical.update(("SKILL.md".len() as u32).to_be_bytes());
        canonical.update(b"SKILL.md");
        canonical.update((skill.len() as u64).to_be_bytes());
        canonical.update(Sha256::digest(skill));
        canonical.update([0]);
        format!(
            "sha256:{}",
            canonical
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    };
    let install = json!({
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null,
        "target_digest":target,
        "artifact_digest":format!("sha256:{}", hex(&archive)),
        "artifact_base64":STANDARD.encode(&archive)
    });
    let digest = json!({"package_path":".antnest/skills/retry-timeouts"});

    let absent = invoke("skill-digest", &workspace, &system_skills, digest.clone());
    assert_eq!(absent["status"], "success");
    assert_eq!(absent["result"]["observed_digest"], Value::Null);

    let stale = workspace.join(".antnest/skill-learning/staging/install/package");
    fs::create_dir_all(&stale).unwrap();
    fs::write(stale.join("SKILL.md"), b"interrupted").unwrap();
    make_agent_owned_tree(&workspace.join(".antnest"));

    let applied = invoke("skill-install", &workspace, &system_skills, install.clone());
    assert_eq!(applied["status"], "success", "{applied}");
    assert_eq!(applied["result"]["outcome"], "applied");
    assert_eq!(applied["result"]["observed_digest"], target);
    let active = workspace.join(".antnest/skills/retry-timeouts");
    assert_eq!(fs::metadata(active.join("SKILL.md")).unwrap().uid(), 1000);
    assert!(!workspace.join(".antnest/skill-learning/staging").exists());
    let inode = fs::metadata(&active).unwrap().ino();

    let resent = invoke("skill-install", &workspace, &system_skills, install.clone());
    assert_eq!(resent["result"]["outcome"], "applied");
    assert_eq!(fs::metadata(&active).unwrap().ino(), inode);

    let present = invoke("skill-digest", &workspace, &system_skills, digest);
    assert_eq!(present["result"]["observed_digest"], target);

    let mut other = install.clone();
    other["target_digest"] = json!(format!("sha256:{}", "0".repeat(64)));
    assert_eq!(
        invoke("skill-install", &workspace, &system_skills, other)["status"],
        "failure"
    );

    fs::create_dir_all(&stale).unwrap();
    make_agent_owned_tree(&workspace.join(".antnest"));
    let cleaned = invoke("skill-install-clean", &workspace, &system_skills, json!({}));
    assert_eq!(cleaned["status"], "success");
    assert!(!workspace.join(".antnest/skill-learning/staging").exists());
}

#[test]
fn agent_user_cannot_invoke_private_skill_maintenance_subcommands() {
    if !getuid().is_root() {
        eprintln!("executor boundary test requires a root Linux build environment");
        return;
    }
    for command in ["skill-install", "skill-digest", "skill-install-clean"] {
        let output = Command::new(env!("CARGO_BIN_EXE_antnest-runtime"))
            .arg(command)
            .uid(1000)
            .gid(1000)
            .stdin(Stdio::null())
            .output()
            .expect("start private maintenance command as Agent user");
        assert!(
            !output.status.success(),
            "{command} was admitted as UID 1000"
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("private maintenance"));
    }
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
    let frames: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).expect("executor JSON frame"))
        .collect();
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame.get("status").is_some())
            .count(),
        1
    );
    frames.last().cloned().expect("executor terminal response")
}

fn make_traversable(path: &Path) {
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("traversable test root");
}

fn make_agent_owned_tree(path: &Path) {
    make_agent_owned(path);
    if path.is_dir() {
        for entry in fs::read_dir(path).unwrap() {
            make_agent_owned_tree(&entry.unwrap().path());
        }
    }
}

fn make_agent_owned(path: &Path) {
    chown(path, Some(Uid::from_raw(1000)), Some(Gid::from_raw(1000)))
        .expect("Agent-owned workspace");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("workspace permissions");
}
