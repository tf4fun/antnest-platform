use crate::information::{MAX_INSTRUCTION_BYTES, RuntimeContext, parse_skill_manifest};

#[test]
fn information_contract_matches_collection_limits() {
    use crate::information;
    let contract: serde_json::Value =
        serde_json::from_str(include_str!("../../../contracts/runtime/contract.json")).unwrap();
    let info = &contract["information"];
    assert_eq!(info["uri"], information::INFORMATION_URI);
    assert_eq!(
        info["max_instruction_bytes"],
        information::MAX_INSTRUCTION_BYTES
    );
    assert_eq!(info["max_manifest_bytes"], information::MAX_MANIFEST_BYTES);
    assert_eq!(
        info["max_scan_entries_per_root"],
        information::MAX_SCAN_ENTRIES
    );
    assert_eq!(
        info["max_skills_per_root"],
        information::MAX_SKILLS_PER_ROOT
    );
    assert_eq!(info["max_warnings"], information::MAX_WARNINGS);
    let schema: serde_json::Value = serde_json::from_str(include_str!(
        "../../../contracts/runtime/runtime-information.schema.json"
    ))
    .unwrap();
    assert_eq!(info["schema"], "runtime-information.schema.json");
    assert_eq!(schema["additionalProperties"], false);
    assert_eq!(
        schema["properties"]["skills"]["maxItems"],
        information::MAX_SKILLS_PER_ROOT * 2
    );
    assert_eq!(
        schema["properties"]["warnings"]["maxItems"],
        information::MAX_WARNINGS
    );
}

#[test]
fn skill_frontmatter_uses_yaml_and_does_not_return_body() {
    let (name, description) = parse_skill_manifest(
        "---\r\nname: \"release: notes\"\r\ndescription: >-\r\n  Summarize changes\r\n  for people.\r\n---\r\nPRIVATE SKILL BODY",
    )
    .expect("valid frontmatter");
    assert_eq!(name, "release: notes");
    assert_eq!(description, "Summarize changes for people.");
}

#[test]
fn invalid_skill_metadata_is_not_invented_from_body() {
    for input in [
        "# Only a heading",
        "---\nname: hello\ndescription: [not, text]\n---\nbody",
        "---\nname: ''\ndescription: desc\n---\nbody",
        "---\nname: hello\ndescription: desc\n",
    ] {
        assert!(parse_skill_manifest(input).is_err(), "{input:?}");
    }
}

#[test]
fn discovery_only_requires_complete_frontmatter_not_the_skill_body() {
    assert_eq!(
        parse_skill_manifest("---\nname: hello\ndescription: desc\n---\n").unwrap(),
        ("hello".into(), "desc".into())
    );
}

#[cfg(target_os = "linux")]
mod filesystem {
    use std::fs;
    use std::os::unix::fs::symlink;

    use super::*;
    use crate::roots::NamedRoots;

    #[test]
    fn fresh_snapshot_includes_guidance_and_both_skill_namespaces() {
        let workspace = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("AGENTS.md"), "Use concise replies.").unwrap();
        write_skill(&skills.path().join("release"), "shared");
        write_skill(&workspace.path().join(".antnest/skills/local"), "shared");
        let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();

        let snapshot = RuntimeContext::collect(&roots).unwrap();
        assert_eq!(
            snapshot.environment.home,
            workspace.path().to_str().unwrap()
        );
        assert_eq!(
            snapshot.instructions.unwrap().content,
            "Use concise replies."
        );
        assert_eq!(snapshot.skills.len(), 2);
        let value = serde_json::to_value(&snapshot.skills).unwrap();
        assert_eq!(value[0]["source"], "system");
        assert_eq!(value[0]["path"]["root"], "system_skills");
        assert_eq!(value[1]["source"], "personal");
        assert_eq!(value[1]["path"]["path"], ".antnest/skills/local/SKILL.md");
        assert!(!value.to_string().contains("PRIVATE SKILL BODY"));

        fs::write(workspace.path().join("AGENTS.md"), "Changed guidance.").unwrap();
        assert_eq!(
            RuntimeContext::collect(&roots)
                .unwrap()
                .instructions
                .unwrap()
                .content,
            "Changed guidance."
        );
    }

    #[test]
    fn missing_optional_content_is_an_empty_snapshot() {
        let workspace = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
        let snapshot = RuntimeContext::collect(&roots).unwrap();
        assert!(snapshot.instructions.is_none());
        assert!(snapshot.skills.is_empty());
        assert!(snapshot.warnings.is_empty());
        assert!(!snapshot.truncated);
    }

    #[test]
    fn large_skill_body_does_not_hide_valid_metadata() {
        let workspace = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        write_skill(&skills.path().join("large"), "large");
        fs::write(
            skills.path().join("large/SKILL.md"),
            format!(
                "---\nname: large\ndescription: Compact summary\n---\n{}",
                "PRIVATE BODY ".repeat(10000)
            ),
        )
        .unwrap();
        let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
        let snapshot = RuntimeContext::collect(&roots).unwrap();
        assert_eq!(snapshot.skills.len(), 1);
        assert_eq!(snapshot.skills[0].description, "Compact summary");
        assert!(snapshot.warnings.is_empty());
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("PRIVATE BODY")
        );
    }

    #[test]
    fn invalid_files_do_not_hide_valid_skills_or_read_symlinks() {
        let workspace = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        let secret = tempfile::NamedTempFile::new().unwrap();
        fs::write(secret.path(), "ROOT SECRET").unwrap();
        symlink(secret.path(), workspace.path().join("AGENTS.md")).unwrap();
        write_skill(&skills.path().join("good"), "good");
        fs::create_dir(skills.path().join("bad")).unwrap();
        fs::write(skills.path().join("bad/SKILL.md"), b"\xff\xfe").unwrap();
        fs::create_dir(skills.path().join("fifo")).unwrap();
        nix::unistd::mkfifo(
            &skills.path().join("fifo/SKILL.md"),
            nix::sys::stat::Mode::S_IRUSR,
        )
        .unwrap();
        let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
        let snapshot = RuntimeContext::collect(&roots).unwrap();
        assert!(snapshot.instructions.is_none());
        assert_eq!(snapshot.skills.len(), 1);
        assert_eq!(snapshot.skills[0].name, "good");
        assert_eq!(snapshot.warnings.len(), 3);
        assert!(
            !serde_json::to_string(&snapshot)
                .unwrap()
                .contains("ROOT SECRET")
        );
    }

    #[test]
    fn guidance_and_skill_catalog_have_explicit_bounds() {
        let workspace = tempfile::tempdir().unwrap();
        let skills = tempfile::tempdir().unwrap();
        fs::write(
            workspace.path().join("AGENTS.md"),
            "界".repeat(MAX_INSTRUCTION_BYTES),
        )
        .unwrap();
        for index in 0..40 {
            write_skill(&skills.path().join(format!("skill-{index:02}")), "skill");
        }
        let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
        let snapshot = RuntimeContext::collect(&roots).unwrap();
        let instructions = snapshot.instructions.unwrap();
        assert!(instructions.truncated);
        assert!(instructions.content.len() <= MAX_INSTRUCTION_BYTES);
        assert!(instructions.content.ends_with('界'));
        assert_eq!(snapshot.skills.len(), 32);
        assert!(snapshot.truncated);
        assert_eq!(snapshot.warnings.last().unwrap().code, "skill_limit");
    }

    fn write_skill(path: &std::path::Path, name: &str) {
        fs::create_dir_all(path).unwrap();
        fs::write(
            path.join("SKILL.md"),
            format!("---\nname: {name}\ndescription: A compact summary.\n---\nPRIVATE SKILL BODY"),
        )
        .unwrap();
    }
}
