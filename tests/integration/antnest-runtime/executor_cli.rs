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
fn skill_candidate_is_prepared_by_uid_1000_outside_discovery_and_replayed() {
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

    let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
    writer
        .start_file("SKILL.md", SimpleFileOptions::default())
        .unwrap();
    writer
        .write_all(b"---\nname: retry-timeouts\ndescription: Retry safely\n---\n")
        .unwrap();
    writer
        .start_file(
            "scripts/check.sh",
            SimpleFileOptions::default().unix_permissions(0o755),
        )
        .unwrap();
    writer.write_all(b"#!/bin/sh\nexit 0\n").unwrap();
    let archive = writer.finish().unwrap().into_inner();
    let content_digest = {
        use sha2::{Digest as _, Sha256};
        let mut canonical = Sha256::new();
        canonical.update(b"antnest-skill-manifest-v1\0");
        let mut files = [
            (
                "SKILL.md",
                b"---\nname: retry-timeouts\ndescription: Retry safely\n---\n".as_slice(),
                false,
            ),
            ("scripts/check.sh", b"#!/bin/sh\nexit 0\n".as_slice(), true),
        ];
        files.sort_by_key(|(path, _, _)| *path);
        for (path, content, executable) in files {
            canonical.update((path.len() as u32).to_be_bytes());
            canonical.update(path.as_bytes());
            canonical.update((content.len() as u64).to_be_bytes());
            canonical.update(Sha256::digest(content));
            canonical.update([u8::from(executable)]);
        }
        format!(
            "sha256:{}",
            canonical
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    };
    let digest = |bytes: &[u8]| {
        use sha2::{Digest as _, Sha256};
        format!(
            "sha256:{}",
            Sha256::digest(bytes)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        )
    };
    let request = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"request-1",
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null,
        "target_digest":content_digest,
        "artifact_digest":digest(&archive),
        "artifact_base64":STANDARD.encode(&archive)
    });
    let first = invoke("skill-prepare", &workspace, &system_skills, request.clone());
    assert_eq!(first["status"], "success");
    let key = first["result"]["candidate_key"].as_str().unwrap();
    let candidate = workspace
        .join(".antnest/skill-learning/candidates")
        .join(key);
    let check = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"check-1",
        "package_path":".antnest/skills/retry-timeouts",
        "target_digest":content_digest
    });
    let checked = invoke("skill-check", &workspace, &system_skills, check.clone());
    assert_eq!(checked["status"], "success");
    assert_eq!(checked["result"]["observed_digest"], content_digest);
    let skill = candidate.join("package/SKILL.md");
    assert!(skill.is_file());
    assert_eq!(fs::metadata(&skill).unwrap().uid(), 1000);
    assert_ne!(
        fs::metadata(candidate.join("package/scripts/check.sh"))
            .unwrap()
            .permissions()
            .mode()
            & 0o111,
        0
    );
    assert_eq!(
        invoke("skill-prepare", &workspace, &system_skills, request)["status"],
        "success"
    );
    let restarted = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-2",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"request-1",
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null,
        "target_digest":content_digest,
        "artifact_digest":digest(&archive),
        "artifact_base64":STANDARD.encode(&archive)
    });
    let after_restart = invoke("skill-prepare", &workspace, &system_skills, restarted);
    assert_eq!(after_restart["status"], "success");
    assert_ne!(after_restart["result"]["candidate_key"], key);
    let info = invoke("info", &workspace, &system_skills, json!({}));
    assert!(info["result"]["skills"].as_array().unwrap().is_empty());

    let changed_base = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"request-1",
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":digest(b"different base"),
        "target_digest":content_digest,
        "artifact_digest":digest(&archive),
        "artifact_base64":STANDARD.encode(&archive)
    });
    assert_eq!(
        invoke("skill-prepare", &workspace, &system_skills, changed_base)["status"],
        "failure"
    );

    fs::write(candidate.join("package/extra.txt"), b"drift").unwrap();
    let drifted = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"request-1",
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null,
        "target_digest":content_digest,
        "artifact_digest":digest(&archive),
        "artifact_base64":STANDARD.encode(&archive)
    });
    assert_eq!(
        invoke("skill-prepare", &workspace, &system_skills, drifted)["status"],
        "failure"
    );
    assert_eq!(
        invoke("skill-check", &workspace, &system_skills, check.clone())["status"],
        "failure"
    );
    fs::remove_file(candidate.join("package/extra.txt")).unwrap();
    fs::set_permissions(
        candidate.join("package/scripts/check.sh"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    let mode_drifted = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"request-1",
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null,
        "target_digest":content_digest,
        "artifact_digest":digest(&archive),
        "artifact_base64":STANDARD.encode(&archive)
    });
    assert_eq!(
        invoke("skill-prepare", &workspace, &system_skills, mode_drifted)["status"],
        "failure"
    );
    assert_eq!(
        invoke("skill-check", &workspace, &system_skills, check)["status"],
        "failure"
    );

    let changed = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "candidate_id":"candidate-1", "request_id":"request-1",
        "package_path":".antnest/skills/retry-timeouts",
        "expected_base_digest":null,
        "target_digest":content_digest,
        "artifact_digest":digest(b"changed"), "artifact_base64":STANDARD.encode(b"changed")
    });
    assert_eq!(
        invoke("skill-prepare", &workspace, &system_skills, changed)["status"],
        "failure"
    );
    assert!(skill.is_file());
}

#[test]
fn agent_user_cannot_invoke_private_skill_maintenance_subcommands() {
    if !getuid().is_root() {
        eprintln!("executor boundary test requires a root Linux build environment");
        return;
    }
    for command in [
        "skill-prepare",
        "skill-check",
        "skill-commit",
        "skill-observe",
        "skill-cancel",
        "skill-release",
    ] {
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

#[test]
fn skill_commit_is_conditional_atomic_and_idempotent() {
    if !getuid().is_root() {
        eprintln!("executor boundary test requires a root Linux build environment");
        return;
    }
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let system_skills = root.path().join("skills");
    fs::create_dir_all(&workspace).unwrap();
    fs::create_dir_all(&system_skills).unwrap();
    make_traversable(root.path());
    make_agent_owned(&workspace);
    fs::set_permissions(&system_skills, fs::Permissions::from_mode(0o555)).unwrap();

    let make_package = |version: &str| {
        use sha2::{Digest as _, Sha256};
        let contents =
            format!("---\nname: retry-timeouts\ndescription: Retry safely\n---\n{version}\n")
                .into_bytes();
        let mut writer = ZipWriter::new(std::io::Cursor::new(Vec::new()));
        writer
            .start_file("SKILL.md", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&contents).unwrap();
        let archive = writer.finish().unwrap().into_inner();
        let mut canonical = Sha256::new();
        canonical.update(b"antnest-skill-manifest-v1\0");
        canonical.update((8u32).to_be_bytes());
        canonical.update(b"SKILL.md");
        canonical.update((contents.len() as u64).to_be_bytes());
        canonical.update(Sha256::digest(&contents));
        canonical.update([0]);
        let digest = format!(
            "sha256:{}",
            canonical
                .finalize()
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let artifact_digest = format!(
            "sha256:{}",
            Sha256::digest(&archive)
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        (contents, archive, digest, artifact_digest)
    };
    let (first_contents, first_archive, first_digest, first_artifact) = make_package("first");
    let (second_contents, second_archive, second_digest, second_artifact) = make_package("second");
    let prepare = |candidate: &str,
                   request: &str,
                   base: Option<&str>,
                   target: &str,
                   artifact: &str,
                   archive: &[u8]| {
        json!({
            "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
            "job_id":"job-1", "candidate_id":candidate, "request_id":request,
            "package_path":".antnest/skills/retry-timeouts", "expected_base_digest":base,
            "target_digest":target, "artifact_digest":artifact, "artifact_base64":STANDARD.encode(archive)
        })
    };
    let commit = |candidate: &str, request: &str, base: Option<&str>, target: &str| {
        json!({
            "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
            "job_id":"job-1", "candidate_id":candidate, "request_id":request,
            "package_path":".antnest/skills/retry-timeouts", "expected_base_digest":base,
            "target_digest":target
        })
    };
    assert_eq!(
        invoke(
            "skill-prepare",
            &workspace,
            &system_skills,
            prepare(
                "candidate-1",
                "prepare-1",
                None,
                &first_digest,
                &first_artifact,
                &first_archive
            )
        )["status"],
        "success"
    );
    let first_commit = commit("candidate-1", "commit-1", None, &first_digest);
    assert_eq!(
        invoke(
            "skill-commit",
            &workspace,
            &system_skills,
            first_commit.clone()
        )["status"],
        "failure"
    );
    let check = |candidate: &str, request: &str, target: &str| {
        json!({
            "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
            "job_id":"job-1", "candidate_id":candidate, "request_id":request,
            "package_path":".antnest/skills/retry-timeouts", "target_digest":target
        })
    };
    assert_eq!(
        invoke(
            "skill-check",
            &workspace,
            &system_skills,
            check("candidate-1", "check-1", &first_digest)
        )["status"],
        "success"
    );
    assert_eq!(
        invoke(
            "skill-commit",
            &workspace,
            &system_skills,
            first_commit.clone()
        )["status"],
        "success"
    );
    let active = workspace.join(".antnest/skills/retry-timeouts/SKILL.md");
    assert_eq!(fs::read(&active).unwrap(), first_contents);
    assert_eq!(
        invoke("skill-commit", &workspace, &system_skills, first_commit)["status"],
        "success"
    );
    assert_eq!(fs::read(&active).unwrap(), first_contents);

    assert_eq!(
        invoke(
            "skill-prepare",
            &workspace,
            &system_skills,
            prepare(
                "candidate-2",
                "prepare-2",
                Some(&first_digest),
                &second_digest,
                &second_artifact,
                &second_archive
            )
        )["status"],
        "success"
    );
    assert_eq!(
        invoke(
            "skill-check",
            &workspace,
            &system_skills,
            check("candidate-2", "check-2", &second_digest)
        )["status"],
        "success"
    );
    let conflict = commit("candidate-2", "commit-bad", None, &second_digest);
    assert_eq!(
        invoke("skill-commit", &workspace, &system_skills, conflict)["status"],
        "failure"
    );
    assert_eq!(fs::read(&active).unwrap(), first_contents);
    let second_commit = commit(
        "candidate-2",
        "commit-2",
        Some(&first_digest),
        &second_digest,
    );
    assert_eq!(
        invoke(
            "skill-commit",
            &workspace,
            &system_skills,
            second_commit.clone()
        )["status"],
        "success"
    );
    assert_eq!(fs::read(&active).unwrap(), second_contents);
    let mark_effect_intent = |subdir: &str, request_id: &str| {
        let folder = workspace.join(".antnest/skill-learning").join(subdir);
        let entry = fs::read_dir(folder)
            .unwrap()
            .map(Result::unwrap)
            .find(|entry| {
                let record: serde_json::Value =
                    serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
                record["request_id"] == request_id
            })
            .expect("effect receipt");
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(entry.path()).unwrap()).unwrap();
        record["phase"] = json!("intent");
        fs::write(entry.path(), serde_json::to_vec(&record).unwrap()).unwrap();
    };
    // Simulate an executor exit after atomic exchange but before final receipt.
    // A fresh executor must observe the target and avoid a second exchange.
    mark_effect_intent("effects", "commit-2");
    assert_eq!(
        invoke("skill-commit", &workspace, &system_skills, second_commit)["status"],
        "success"
    );
    assert_eq!(fs::read(&active).unwrap(), second_contents);
    let candidates = workspace.join(".antnest/skill-learning/candidates");
    let candidate = fs::read_dir(&candidates)
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| {
            let receipt: serde_json::Value =
                serde_json::from_slice(&fs::read(entry.path().join("receipt.json")).unwrap())
                    .unwrap();
            receipt["candidate_id"] == "candidate-2"
        })
        .expect("second candidate");
    let candidate_key = candidate.file_name().into_string().unwrap();
    let receipt = fs::read(candidate.path().join("receipt.json")).unwrap();
    let release = json!({
        "agent_id":"agent-1", "generation":1, "execution_id":"execution-1",
        "job_id":"job-1", "request_id":"release-2", "storage_class":"candidate",
        "storage_key":candidate_key,
        "package_path":".antnest/skills/retry-timeouts", "expected_digest":second_digest,
    });
    assert_eq!(
        invoke("skill-release", &workspace, &system_skills, release.clone())["status"],
        "success"
    );
    let releases = workspace.join(".antnest/skill-learning/releases");
    let release_record = fs::read_dir(releases)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let release_key = release_record.file_stem().unwrap().to_str().unwrap();
    let stage = workspace
        .join(".antnest/skill-learning/release-stage")
        .join(release_key);
    // Model a restart after detach, before writing the Detached receipt.
    fs::create_dir_all(&stage).unwrap();
    make_agent_owned(&stage);
    fs::write(stage.join("receipt.json"), receipt).unwrap();
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&release_record).unwrap()).unwrap();
    state["phase"] = json!("intent");
    fs::write(&release_record, serde_json::to_vec(&state).unwrap()).unwrap();
    let resumed = invoke("skill-release", &workspace, &system_skills, release.clone());
    assert_eq!(resumed["status"], "success", "{resumed}");
    assert!(!stage.exists());
    assert_eq!(fs::read(&active).unwrap(), second_contents);
    // Model a restart after unlink, before the final Applied receipt.
    state["phase"] = json!("detached");
    fs::write(&release_record, serde_json::to_vec(&state).unwrap()).unwrap();
    assert_eq!(
        invoke("skill-release", &workspace, &system_skills, release)["status"],
        "success"
    );
    assert!(!stage.exists());
    assert_eq!(fs::read(&active).unwrap(), second_contents);
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

fn make_agent_owned(path: &Path) {
    chown(path, Some(Uid::from_raw(1000)), Some(Gid::from_raw(1000)))
        .expect("Agent-owned workspace");
    fs::set_permissions(path, fs::Permissions::from_mode(0o755)).expect("workspace permissions");
}
