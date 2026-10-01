use crate::file_observation::{FileChange, MAX_CHANGE_BYTES};

#[test]
fn file_observation_private_codec_preserves_facts_and_bounds_json_expansion() {
    use crate::execution::{EditResult, ReadResult, WriteResult};
    use crate::executor_protocol::*;
    use crate::file_observation::FileObservation;
    use crate::file_observation_wire::{FILE_META_KEY, WireFileObservation};

    let path = "/workspace/actual.txt".to_owned();
    for change in [
        None,
        Some(FileChange::text(None, b"new")),
        Some(FileChange::text(Some(b""), b"new")),
        Some(FileChange::Unavailable),
        Some(FileChange::NonUtf8),
        Some(FileChange::TooLarge),
    ] {
        let file = Some(FileObservation {
            path: path.clone(),
            change,
        });
        let write = WriteResult {
            bytes_written: 3,
            file: file.clone(),
        };
        let encoded = encode_write_reply(Ok(write.clone())).unwrap();
        assert_eq!(decode_write_reply(&encoded).unwrap().unwrap(), write);
        let edit = EditResult {
            bytes_written: 3,
            file: file.clone(),
        };
        assert_eq!(
            decode_edit_reply(&encode_edit_reply(Ok(edit.clone())).unwrap())
                .unwrap()
                .unwrap(),
            edit
        );
        let read = ReadResult {
            content: "new".into(),
            truncated: false,
            next_offset: None,
            file,
        };
        assert_eq!(
            decode_read_reply(&encode_read_reply(Ok(read.clone())).unwrap())
                .unwrap()
                .unwrap(),
            read
        );
    }

    for after in ["\0".repeat(6000), "a".repeat(MAX_CHANGE_BYTES)] {
        let file = FileObservation {
            path: path.clone(),
            change: Some(FileChange::Text {
                before: None,
                after,
            }),
        };
        let wire = WireFileObservation::bounded(file.clone()).unwrap();
        assert!(serde_json::to_vec(&wire).unwrap().len() <= MAX_CHANGE_BYTES);
        assert!(serde_json::to_vec(&wire.metadata()).unwrap().len() <= MAX_CHANGE_BYTES);
        assert_eq!(wire.metadata()[FILE_META_KEY]["diffOmitted"], "too_large");
        assert!(wire.metadata()[FILE_META_KEY]["diff"].is_null());
        let encoded = encode_write_reply(Ok(WriteResult {
            bytes_written: 6000,
            file: Some(file),
        }))
        .unwrap();
        assert!(encoded.len() < MAX_CHANGE_BYTES);
        let decoded = decode_write_reply(&encoded).unwrap().unwrap();
        assert_eq!(decoded.bytes_written, 6000);
        assert_eq!(decoded.file.unwrap().change, Some(FileChange::TooLarge));
    }
    assert!(
        WireFileObservation::bounded(FileObservation {
            path: "x".repeat(MAX_CHANGE_BYTES),
            change: None
        })
        .is_none()
    );
}

#[test]
fn file_observation_distinguishes_missing_empty_binary_and_large_sources() {
    assert_eq!(
        FileChange::text(None, b"new"),
        FileChange::Text {
            before: None,
            after: "new".into()
        }
    );
    assert_eq!(
        FileChange::text(Some(b""), b"new"),
        FileChange::Text {
            before: Some(String::new()),
            after: "new".into()
        }
    );
    assert_eq!(FileChange::text(Some(&[0xff]), b"new"), FileChange::NonUtf8);
    assert_eq!(
        FileChange::text(None, &vec![b'x'; MAX_CHANGE_BYTES + 1]),
        FileChange::TooLarge
    );
    assert_eq!(
        FileChange::text(Some(&vec![b'x'; MAX_CHANGE_BYTES]), b"x"),
        FileChange::TooLarge
    );
}

#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use crate::execution::{EditRequest, ReadRequest, RootName, RootPath, WriteRequest};
    use crate::roots::NamedRoots;
    use crate::tools::ToolEngine;
    use std::{fs, sync::Arc};
    use tempfile::tempdir;
    use tokio_util::sync::CancellationToken;

    fn path(name: &str) -> RootPath {
        RootPath::new(RootName::Workspace, name.into()).unwrap()
    }

    #[tokio::test]
    async fn file_observation_write_edit_read_use_execution_facts_not_fragments() {
        let workspace = tempdir().unwrap();
        let skills = tempdir().unwrap();
        let engine = ToolEngine::new(Arc::new(
            NamedRoots::open(workspace.path(), skills.path()).unwrap(),
        ));
        let written = engine
            .write(
                WriteRequest::new(path("  ./nested/file.txt  "), "head\nbefore\ntail\n".into())
                    .unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        let observed = written.file.unwrap();
        assert_eq!(
            observed.path,
            workspace.path().join("nested/file.txt").to_str().unwrap()
        );
        assert_eq!(
            observed.change,
            Some(FileChange::Text {
                before: None,
                after: "head\nbefore\ntail\n".into()
            })
        );
        let edited = engine
            .edit(
                EditRequest::new(path("nested/file.txt"), "before".into(), "after".into()).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            edited.file.unwrap().change,
            Some(FileChange::Text {
                before: Some("head\nbefore\ntail\n".into()),
                after: "head\nafter\ntail\n".into()
            })
        );
        let read = engine
            .read(
                ReadRequest::new(path("nested/file.txt"), 2, 1).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(read.content, "after\n");
        assert_eq!(read.next_offset, Some(3));
        assert!(read.file.unwrap().change.is_none());
        fs::write(skills.path().join("SKILL.md"), "guide").unwrap();
        let read = engine
            .read(
                ReadRequest::new(
                    RootPath::new(RootName::SystemSkills, "SKILL.md".into()).unwrap(),
                    1,
                    100,
                )
                .unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            read.file.unwrap().path,
            skills.path().join("SKILL.md").to_str().unwrap()
        );
    }

    #[tokio::test]
    async fn file_observation_fifo_before_image_does_not_block_replacement() {
        let workspace = tempdir().unwrap();
        let skills = tempdir().unwrap();
        let fifo = workspace.path().join("pipe");
        nix::unistd::mkfifo(
            &fifo,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .unwrap();
        let engine = ToolEngine::new(Arc::new(
            NamedRoots::open(workspace.path(), skills.path()).unwrap(),
        ));
        let result = engine
            .write(
                WriteRequest::new(path("pipe"), "new".into()).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(result.file.unwrap().change, Some(FileChange::Unavailable));
        assert_eq!(fs::read(fifo).unwrap(), b"new");
    }

    #[test]
    fn file_observation_failed_parent_walk_does_not_create_outside_root() {
        let workspace = tempdir().unwrap();
        let skills = tempdir().unwrap();
        let outside = tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("link")).unwrap();
        let roots = NamedRoots::open(workspace.path(), skills.path()).unwrap();
        assert!(
            roots
                .write(
                    crate::roots::NamedRoot::Workspace,
                    "link/created/file",
                    b"x",
                    false
                )
                .is_err()
        );
        assert!(!outside.path().join("created").exists());
        roots
            .write(
                crate::roots::NamedRoot::Workspace,
                "space dir /child/file",
                b"x",
                false,
            )
            .unwrap();
        assert_eq!(
            fs::read(workspace.path().join("space dir /child/file")).unwrap(),
            b"x"
        );
    }

    #[tokio::test]
    async fn file_observation_parent_whitespace_never_selects_a_different_file() {
        let workspace = tempdir().unwrap();
        let skills = tempdir().unwrap();
        for directory in ["dir", "dir "] {
            fs::create_dir(workspace.path().join(directory)).unwrap();
        }
        fs::write(workspace.path().join("dir/f"), "sentinel").unwrap();
        fs::write(workspace.path().join("dir /f"), "new").unwrap();
        let engine = ToolEngine::new(Arc::new(
            NamedRoots::open(workspace.path(), skills.path()).unwrap(),
        ));
        let result = engine
            .write(
                WriteRequest::new(path("dir /f"), "new".into()).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            fs::read(workspace.path().join("dir/f")).unwrap(),
            b"sentinel"
        );
        assert_eq!(
            result.file.unwrap().path,
            workspace.path().join("dir /f").to_str().unwrap()
        );
        let edited = engine
            .edit(
                EditRequest::new(path("dir /f"), "new".into(), "updated".into()).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            edited.file.unwrap().change,
            Some(FileChange::text(Some(b"new"), b"updated"))
        );
        assert_eq!(
            fs::read(workspace.path().join("dir/f")).unwrap(),
            b"sentinel"
        );
        assert_eq!(
            fs::read(workspace.path().join("dir /f")).unwrap(),
            b"updated"
        );
    }

    #[tokio::test]
    async fn file_observation_omissions_do_not_fail_successful_replacements() {
        let workspace = tempdir().unwrap();
        let skills = tempdir().unwrap();
        let engine = ToolEngine::new(Arc::new(
            NamedRoots::open(workspace.path(), skills.path()).unwrap(),
        ));
        for (old, expected) in [
            (vec![0xff], FileChange::NonUtf8),
            (vec![b'a'; MAX_CHANGE_BYTES + 1], FileChange::TooLarge),
        ] {
            fs::write(workspace.path().join("file.txt"), old).unwrap();
            let result = engine
                .write(
                    WriteRequest::new(path("file.txt"), "new".into()).unwrap(),
                    CancellationToken::new(),
                )
                .await
                .unwrap();
            assert_eq!(result.file.unwrap().change, Some(expected));
            assert_eq!(fs::read(workspace.path().join("file.txt")).unwrap(), b"new");
        }
        fs::write(workspace.path().join("file.txt"), "").unwrap();
        let result = engine
            .write(
                WriteRequest::new(path("file.txt"), "new".into()).unwrap(),
                CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            result.file.unwrap().change,
            Some(FileChange::Text {
                before: Some(String::new()),
                after: "new".into()
            })
        );
    }

    #[tokio::test]
    async fn file_observation_does_not_turn_failed_edits_into_success() {
        let workspace = tempdir().unwrap();
        let skills = tempdir().unwrap();
        let engine = ToolEngine::new(Arc::new(
            NamedRoots::open(workspace.path(), skills.path()).unwrap(),
        ));
        fs::write(workspace.path().join("file.txt"), "same same").unwrap();
        for old in ["same", "missing"] {
            assert!(
                engine
                    .edit(
                        EditRequest::new(path("file.txt"), old.into(), "new".into()).unwrap(),
                        CancellationToken::new()
                    )
                    .await
                    .is_err()
            );
            assert_eq!(
                fs::read(workspace.path().join("file.txt")).unwrap(),
                b"same same"
            );
        }
        let cancel = CancellationToken::new();
        cancel.cancel();
        assert!(
            engine
                .write(
                    WriteRequest::new(path("file.txt"), "new".into()).unwrap(),
                    cancel
                )
                .await
                .is_err()
        );
        assert_eq!(
            fs::read(workspace.path().join("file.txt")).unwrap(),
            b"same same"
        );
    }
}
