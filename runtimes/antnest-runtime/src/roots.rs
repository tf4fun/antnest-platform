#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NamedRoot {
    Workspace,
    SystemSkills,
}

pub struct FilePreview {
    pub data: Vec<u8>,
    pub truncated: bool,
}

pub struct DirectoryListing {
    pub names: Vec<String>,
    pub truncated: bool,
}

pub(crate) struct TreeFile<'a> {
    pub(crate) path: &'a str,
    pub(crate) contents: &'a [u8],
    pub(crate) executable: bool,
}

pub(crate) struct TreeEntry {
    pub(crate) path: String,
    pub(crate) contents: Option<Vec<u8>>,
    pub(crate) executable: bool,
}

#[allow(dead_code)] // The non-Linux stub and Linux test builds use different variants.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TreeInstallMode {
    Create,
    Replace,
}

#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::CString;
    use std::fs::{self, File};
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::os::unix::fs::PermissionsExt as _;
    use std::path::{Component, Path, PathBuf};

    use thiserror::Error;
    use uuid::Uuid;

    use super::{DirectoryListing, FilePreview, NamedRoot, TreeEntry, TreeFile, TreeInstallMode};

    const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
    const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
    const RESOLVE_NO_SYMLINKS: u64 = 0x04;
    const RESOLVE_BENEATH: u64 = 0x08;

    #[repr(C)]
    struct OpenHow {
        flags: u64,
        mode: u64,
        resolve: u64,
    }

    #[derive(Debug, Error)]
    pub enum RootError {
        #[error("System Skill root is read-only")]
        ReadOnly,
        #[error("path is invalid: {0}")]
        InvalidPath(String),
        #[error("file exceeds the {MAX_FILE_BYTES}-byte Runtime limit")]
        TooLarge,
        #[error("atomic write may have committed during {operation}: {detail}")]
        OutcomeUnknown {
            operation: &'static str,
            detail: String,
        },
        #[allow(dead_code)] // L1 commit maps this outcome to the private API.
        #[error("atomic Skill directory replacement is unsupported: {0}")]
        AtomicSkillReplaceUnsupported(io::Error),
        #[error("{operation}: {source}")]
        System {
            operation: &'static str,
            #[source]
            source: io::Error,
        },
    }

    impl RootError {
        pub fn is_not_found(&self) -> bool {
            matches!(self, Self::System { source, .. } if source.kind() == io::ErrorKind::NotFound)
        }

        pub fn outcome_unknown(&self) -> bool {
            matches!(self, Self::OutcomeUnknown { .. })
        }
    }

    pub struct ReadResult {
        pub data: Vec<u8>,
    }

    pub struct NamedRoots {
        workspace: OwnedFd,
        workspace_path: PathBuf,
        system_skills: PathBuf,
    }

    enum RootHandle {
        Borrowed(RawFd),
        Owned(OwnedFd),
    }

    impl RootHandle {
        fn as_raw_fd(&self) -> RawFd {
            match self {
                Self::Borrowed(fd) => *fd,
                Self::Owned(fd) => fd.as_raw_fd(),
            }
        }
    }

    impl NamedRoots {
        pub fn open(workspace: &Path, system_skills: &Path) -> Result<Self, RootError> {
            let _ = open_root(system_skills)?;
            Ok(Self {
                workspace: open_root(workspace)?,
                workspace_path: workspace.to_owned(),
                system_skills: system_skills.to_owned(),
            })
        }

        pub fn workspace_path(&self, path: &str) -> Result<PathBuf, RootError> {
            Ok(self.workspace_path.join(normalize_relative_path(path)?))
        }

        pub fn target_path(&self, root: NamedRoot, path: &str) -> Result<PathBuf, RootError> {
            let base = match root {
                NamedRoot::Workspace => &self.workspace_path,
                NamedRoot::SystemSkills => &self.system_skills,
            };
            Ok(base
                .join(normalize_relative_path(path)?)
                .components()
                .collect())
        }

        pub fn workspace_root(&self) -> &Path {
            &self.workspace_path
        }

        pub fn read_preview(
            &self,
            root: NamedRoot,
            path: &str,
            limit: usize,
        ) -> Result<FilePreview, RootError> {
            let root = self.root(root)?;
            let fd = open_relative(
                root.as_raw_fd(),
                path,
                (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK) as u64,
                0,
            )?;
            let file = File::from(fd);
            if !file
                .metadata()
                .map_err(|source| system("read preview metadata", source))?
                .is_file()
            {
                return Err(RootError::InvalidPath(
                    "preview requires a regular file".into(),
                ));
            }
            let mut data = Vec::new();
            file.take(limit as u64 + 1)
                .read_to_end(&mut data)
                .map_err(|source| system("read bounded preview", source))?;
            let truncated = data.len() > limit;
            data.truncate(limit);
            Ok(FilePreview { data, truncated })
        }

        pub fn list_directories(
            &self,
            root: NamedRoot,
            path: &str,
            limit: usize,
        ) -> Result<DirectoryListing, RootError> {
            let root = self.root(root)?;
            let fd = open_relative(
                root.as_raw_fd(),
                path,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            // The openat2-validated directory descriptor pins the directory during enumeration.
            let entries = std::fs::read_dir(format!("/proc/self/fd/{}", fd.as_raw_fd()))
                .map_err(|source| system("list named-root directory", source))?;
            let mut names = Vec::new();
            let mut truncated = false;
            for (index, entry) in entries.take(limit + 1).enumerate() {
                if index == limit {
                    truncated = true;
                    break;
                }
                let entry = entry.map_err(|source| system("read directory entry", source))?;
                if entry
                    .file_type()
                    .map_err(|source| system("read entry type", source))?
                    .is_dir()
                    && let Some(name) = entry.file_name().to_str()
                {
                    names.push(name.to_owned());
                }
            }
            names.sort();
            Ok(DirectoryListing { names, truncated })
        }

        pub fn read(&self, root: NamedRoot, path: &str) -> Result<ReadResult, RootError> {
            let root = self.root(root)?;
            let fd = open_relative(
                root.as_raw_fd(),
                path,
                (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
                0,
            )?;
            let file = File::from(fd);
            let metadata = file
                .metadata()
                .map_err(|source| system("read file metadata", source))?;
            if metadata.len() > MAX_FILE_BYTES {
                return Err(RootError::TooLarge);
            }
            let mut data = Vec::with_capacity(metadata.len() as usize);
            file.take(MAX_FILE_BYTES + 1)
                .read_to_end(&mut data)
                .map_err(|source| system("read named-root file", source))?;
            if data.len() as u64 > MAX_FILE_BYTES {
                return Err(RootError::TooLarge);
            }
            Ok(ReadResult { data })
        }

        pub fn write(
            &self,
            root: NamedRoot,
            path: &str,
            data: &[u8],
            append: bool,
        ) -> Result<u64, RootError> {
            if root == NamedRoot::SystemSkills {
                return Err(RootError::ReadOnly);
            }
            if data.len() as u64 > MAX_FILE_BYTES {
                return Err(RootError::TooLarge);
            }
            let root_handle = self.root(root)?;
            let root_fd = root_handle.as_raw_fd();
            create_parent_directories(root_fd, path)?;
            let mut committed = Vec::new();
            if append {
                match self.read(root, path) {
                    Ok(existing) => committed.extend_from_slice(&existing.data),
                    Err(RootError::System { source, .. })
                        if source.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
            }
            if committed.len().saturating_add(data.len()) as u64 > MAX_FILE_BYTES {
                return Err(RootError::TooLarge);
            }
            committed.extend_from_slice(data);
            atomic_replace(root_fd, path, &committed)?;
            let retained = self
                .read(root, path)
                .map_err(|error| RootError::OutcomeUnknown {
                    operation: "read back committed file",
                    detail: error.to_string(),
                })?;
            if retained.data != committed {
                return Err(RootError::OutcomeUnknown {
                    operation: "verify committed file",
                    detail: "readback did not match committed content".into(),
                });
            }
            u64::try_from(data.len()).map_err(|_| RootError::TooLarge)
        }

        pub fn publish_workspace_tree(
            &self,
            parent: &str,
            name: &str,
            files: &[TreeFile<'_>],
        ) -> Result<(), RootError> {
            let temporary_parent = parent
                .strip_prefix(".antnest/skill-temporary/v1/")
                .is_some_and(|scope| {
                    scope.len() == 64
                        && scope
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
                });
            if !(matches!(parent, ".antnest/skill-learning/candidates") || temporary_parent)
                || name.is_empty()
                || name.len() > 128
                || !name
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || files.is_empty()
                || files.len() > 257
            // Registry's 256 entries plus one private receipt.
            {
                return Err(RootError::InvalidPath(name.to_owned()));
            }
            create_parent_directories(
                self.workspace.as_raw_fd(),
                &format!("{parent}/placeholder"),
            )?;
            let parent_fd = open_relative(
                self.workspace.as_raw_fd(),
                parent,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let temporary = format!(".{name}.{}.tmp", Uuid::new_v4());
            let temporary_name = CString::new(temporary.as_bytes())
                .map_err(|_| RootError::InvalidPath(temporary.clone()))?;
            let target_name = CString::new(name.as_bytes())
                .map_err(|_| RootError::InvalidPath(name.to_owned()))?;
            if unsafe { libc::mkdirat(parent_fd.as_raw_fd(), temporary_name.as_ptr(), 0o700) } != 0
            {
                return Err(system(
                    "create Skill candidate stage",
                    io::Error::last_os_error(),
                ));
            }
            let mut published = false;
            let result = (|| {
                let stage_fd = open_relative(
                    parent_fd.as_raw_fd(),
                    &temporary,
                    (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                    0,
                )?;
                for file in files {
                    write_tree_file(stage_fd.as_raw_fd(), file)?;
                }
                if unsafe { libc::fsync(stage_fd.as_raw_fd()) } != 0 {
                    return Err(system(
                        "sync Skill candidate stage",
                        io::Error::last_os_error(),
                    ));
                }
                let renamed = unsafe {
                    libc::syscall(
                        libc::SYS_renameat2,
                        parent_fd.as_raw_fd(),
                        temporary_name.as_ptr(),
                        parent_fd.as_raw_fd(),
                        target_name.as_ptr(),
                        libc::RENAME_NOREPLACE,
                    )
                };
                if renamed != 0 {
                    return Err(system(
                        "publish Skill candidate tree",
                        io::Error::last_os_error(),
                    ));
                }
                published = true;
                if unsafe { libc::fsync(parent_fd.as_raw_fd()) } != 0 {
                    return Err(RootError::OutcomeUnknown {
                        operation: "sync published Skill candidate tree",
                        detail: io::Error::last_os_error().to_string(),
                    });
                }
                Ok(())
            })();
            if !published {
                let stage = format!("/proc/self/fd/{}/{temporary}", parent_fd.as_raw_fd());
                let _ = fs::remove_dir_all(stage);
            }
            result
        }

        pub fn snapshot_workspace_tree(&self, path: &str) -> Result<Vec<TreeEntry>, RootError> {
            let root = open_relative(
                self.workspace.as_raw_fd(),
                path,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let mut entries = Vec::new();
            let mut total = 0u64;
            snapshot_tree_directory(root.as_raw_fd(), "", &mut entries, &mut total)?;
            entries.sort_by(|left, right| left.path.as_bytes().cmp(right.path.as_bytes()));
            Ok(entries)
        }

        pub fn workspace_tree_exists(&self, path: &str) -> Result<bool, RootError> {
            match open_relative(
                self.workspace.as_raw_fd(),
                path,
                (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            ) {
                Ok(_) => Ok(true),
                Err(error) if error.is_not_found() => Ok(false),
                Err(error) => Err(error),
            }
        }

        pub fn remove_temporary_skill_tree(&self, scope: Option<&str>) -> Result<(), RootError> {
            let path = match scope {
                Some(scope)
                    if scope.len() == 64
                        && scope
                            .bytes()
                            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')) =>
                {
                    format!(".antnest/skill-temporary/v1/{scope}")
                }
                Some(_) => return Err(RootError::InvalidPath("invalid temporary scope".into())),
                None => ".antnest/skill-temporary/v1".into(),
            };
            let (parent, name) = path.rsplit_once('/').expect("private temporary parent");
            let parent = match open_relative(
                self.workspace.as_raw_fd(),
                parent,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            ) {
                Ok(fd) => fd,
                Err(error) if error.is_not_found() => return Ok(()),
                Err(error) => return Err(error),
            };
            match open_relative(
                parent.as_raw_fd(),
                name,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            ) {
                Ok(_) => {}
                Err(error) if error.is_not_found() => return Ok(()),
                Err(error) => return Err(error),
            }
            // A pinned, openat2-validated parent prevents traversal outside the
            // reserved namespace. remove_dir_all never follows contained links.
            fs::remove_dir_all(format!("/proc/self/fd/{}/{name}", parent.as_raw_fd())).map_err(
                |error| RootError::OutcomeUnknown {
                    operation: "remove temporary Skill scope",
                    detail: error.to_string(),
                },
            )?;
            if unsafe { libc::fsync(parent.as_raw_fd()) } != 0 {
                return Err(RootError::OutcomeUnknown {
                    operation: "sync temporary Skill cleanup",
                    detail: io::Error::last_os_error().to_string(),
                });
            }
            if self.workspace_tree_exists(&path)? {
                return Err(RootError::OutcomeUnknown {
                    operation: "verify temporary Skill cleanup",
                    detail: "temporary scope still exists".into(),
                });
            }
            Ok(())
        }

        pub fn hidden_skill_storage_bytes(&self, cutoff: u64) -> Result<u64, RootError> {
            let mut total = 0;
            let mut entries = 0;
            for class in ["candidates", "release-stage"] {
                let path = format!(".antnest/skill-learning/{class}");
                let directory = match open_relative(
                    self.workspace.as_raw_fd(),
                    &path,
                    (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                    0,
                ) {
                    Ok(directory) => directory,
                    Err(error) if error.is_not_found() => continue,
                    Err(error) => return Err(error),
                };
                count_hidden_skill_bytes(
                    directory.as_raw_fd(),
                    &mut total,
                    cutoff,
                    0,
                    &mut entries,
                )?;
                if total > cutoff {
                    break;
                }
            }
            Ok(total)
        }

        pub fn detach_skill_learning_tree(
            &self,
            source_parent: &str,
            storage_key: &str,
            release_key: &str,
        ) -> Result<(), RootError> {
            if !matches!(source_parent, ".antnest/skill-learning/candidates")
                || !valid_skill_storage_key(storage_key)
                || !valid_skill_storage_key(release_key)
            {
                return Err(RootError::InvalidPath(storage_key.to_owned()));
            }
            let stage_parent = ".antnest/skill-learning/release-stage";
            create_parent_directories(
                self.workspace.as_raw_fd(),
                &format!("{stage_parent}/placeholder"),
            )?;
            let source = open_relative(
                self.workspace.as_raw_fd(),
                source_parent,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let stage = open_relative(
                self.workspace.as_raw_fd(),
                stage_parent,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let _item = open_relative(
                source.as_raw_fd(),
                storage_key,
                (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let source_name = CString::new(storage_key)
                .map_err(|_| RootError::InvalidPath(storage_key.to_owned()))?;
            let stage_name = CString::new(release_key)
                .map_err(|_| RootError::InvalidPath(release_key.to_owned()))?;
            let renamed = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    source.as_raw_fd(),
                    source_name.as_ptr(),
                    stage.as_raw_fd(),
                    stage_name.as_ptr(),
                    libc::RENAME_NOREPLACE,
                )
            };
            if renamed != 0 {
                return Err(system(
                    "detach Skill storage tree",
                    io::Error::last_os_error(),
                ));
            }
            for fd in [source.as_raw_fd(), stage.as_raw_fd()] {
                if unsafe { libc::fsync(fd) } != 0 {
                    return Err(RootError::OutcomeUnknown {
                        operation: "sync detached Skill storage tree",
                        detail: io::Error::last_os_error().to_string(),
                    });
                }
            }
            Ok(())
        }

        pub fn remove_detached_skill_learning_tree(
            &self,
            release_key: &str,
        ) -> Result<(), RootError> {
            if !valid_skill_storage_key(release_key) {
                return Err(RootError::InvalidPath(release_key.to_owned()));
            }
            let stage = open_relative(
                self.workspace.as_raw_fd(),
                ".antnest/skill-learning/release-stage",
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let _item = open_relative(
                stage.as_raw_fd(),
                release_key,
                (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            fs::remove_dir_all(format!("/proc/self/fd/{}/{release_key}", stage.as_raw_fd()))
                .map_err(|error| system("remove detached Skill storage tree", error))?;
            if unsafe { libc::fsync(stage.as_raw_fd()) } != 0 {
                return Err(RootError::OutcomeUnknown {
                    operation: "sync removed Skill storage tree",
                    detail: io::Error::last_os_error().to_string(),
                });
            }
            Ok(())
        }

        #[allow(dead_code)] // Used by the private Skill maintenance executor.
        pub fn install_candidate_tree(
            &self,
            candidate_key: &str,
            skill_name: &str,
            mode: TreeInstallMode,
        ) -> Result<(), RootError> {
            if candidate_key.is_empty()
                || candidate_key.len() > 128
                || !candidate_key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                || skill_name.is_empty()
                || skill_name.len() > 64
                || !skill_name
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
            {
                return Err(RootError::InvalidPath(skill_name.to_owned()));
            }
            let source_parent = format!(".antnest/skill-learning/candidates/{candidate_key}");
            let target_parent = ".antnest/skills";
            create_parent_directories(self.workspace.as_raw_fd(), ".antnest/skills/placeholder")?;
            let source_fd = open_relative(
                self.workspace.as_raw_fd(),
                &source_parent,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let target_fd = open_relative(
                self.workspace.as_raw_fd(),
                target_parent,
                (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let _source = open_relative(
                source_fd.as_raw_fd(),
                "package",
                (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                0,
            )?;
            if mode == TreeInstallMode::Replace {
                let _target = open_relative(
                    target_fd.as_raw_fd(),
                    skill_name,
                    (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
                    0,
                )?;
            }
            let source_name = c"package";
            let target_name = CString::new(skill_name.as_bytes())
                .map_err(|_| RootError::InvalidPath(skill_name.to_owned()))?;
            let flags = match mode {
                TreeInstallMode::Create => libc::RENAME_NOREPLACE,
                TreeInstallMode::Replace => libc::RENAME_EXCHANGE,
            };
            let renamed = unsafe {
                libc::syscall(
                    libc::SYS_renameat2,
                    source_fd.as_raw_fd(),
                    source_name.as_ptr(),
                    target_fd.as_raw_fd(),
                    target_name.as_ptr(),
                    flags,
                )
            };
            if renamed != 0 {
                let source = io::Error::last_os_error();
                return if matches!(
                    source.raw_os_error(),
                    Some(libc::ENOSYS | libc::EINVAL | libc::EXDEV | libc::EOPNOTSUPP)
                ) {
                    Err(RootError::AtomicSkillReplaceUnsupported(source))
                } else {
                    Err(system("install Skill candidate tree", source))
                };
            }
            for fd in [source_fd.as_raw_fd(), target_fd.as_raw_fd()] {
                if unsafe { libc::fsync(fd) } != 0 {
                    return Err(RootError::OutcomeUnknown {
                        operation: "sync installed Skill directory",
                        detail: io::Error::last_os_error().to_string(),
                    });
                }
            }
            Ok(())
        }

        fn root(&self, root: NamedRoot) -> Result<RootHandle, RootError> {
            match root {
                NamedRoot::Workspace => Ok(RootHandle::Borrowed(self.workspace.as_raw_fd())),
                NamedRoot::SystemSkills => Ok(RootHandle::Owned(open_root(&self.system_skills)?)),
            }
        }
    }

    fn valid_skill_storage_key(value: &str) -> bool {
        value.len() == 64
            && value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    }

    fn count_hidden_skill_bytes(
        directory: RawFd,
        total: &mut u64,
        cutoff: u64,
        depth: usize,
        entries: &mut usize,
    ) -> Result<(), RootError> {
        if depth > 16 {
            return Err(RootError::TooLarge);
        }
        let items = fs::read_dir(format!("/proc/self/fd/{directory}"))
            .map_err(|source| system("read hidden Skill storage", source))?;
        for item in items {
            let item = item.map_err(|source| system("read hidden Skill entry", source))?;
            *entries += 1;
            if *entries > 65_536 {
                return Err(RootError::TooLarge);
            }
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| RootError::InvalidPath("non-UTF8 hidden Skill entry".into()))?;
            let opened = open_relative(
                directory,
                &name,
                (libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC) as u64,
                0,
            )?;
            let file = File::from(opened);
            let metadata = file
                .metadata()
                .map_err(|source| system("stat hidden Skill entry", source))?;
            if metadata.is_dir() {
                count_hidden_skill_bytes(file.as_raw_fd(), total, cutoff, depth + 1, entries)?;
            } else if metadata.is_file() {
                *total = total.saturating_add(metadata.len());
            } else {
                return Err(RootError::InvalidPath(name));
            }
            if *total > cutoff {
                return Ok(());
            }
        }
        Ok(())
    }

    fn open_root(path: &Path) -> Result<OwnedFd, RootError> {
        let value = CString::new(path.as_os_str().as_encoded_bytes())
            .map_err(|_| RootError::InvalidPath("root contains NUL".into()))?;
        let fd = unsafe {
            libc::open(
                value.as_ptr(),
                libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(system("open named root", io::Error::last_os_error()));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn open_relative(root: RawFd, path: &str, flags: u64, mode: u64) -> Result<OwnedFd, RootError> {
        let path = normalize_relative_path(path)?;
        open_normalized_relative(root, path, flags, mode)
    }

    fn open_normalized_relative(
        root: RawFd,
        path: &str,
        flags: u64,
        mode: u64,
    ) -> Result<OwnedFd, RootError> {
        let value =
            CString::new(path).map_err(|_| RootError::InvalidPath("path contains NUL".into()))?;
        let how = OpenHow {
            flags,
            mode,
            resolve: RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS,
        };
        let fd = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root,
                value.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            ) as libc::c_int
        };
        if fd < 0 {
            return Err(system("open named-root path", io::Error::last_os_error()));
        }
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    fn create_parent_directories(root: RawFd, path: &str) -> Result<(), RootError> {
        let path = normalize_relative_path(path)?;
        let Some(parent) = Path::new(path).parent() else {
            return Ok(());
        };
        let mut current = open_relative(
            root,
            ".",
            (libc::O_PATH | libc::O_DIRECTORY | libc::O_CLOEXEC) as u64,
            0,
        )?;
        for component in parent.components() {
            let Component::Normal(component) = component else {
                continue;
            };
            let value = CString::new(component.as_encoded_bytes())
                .map_err(|_| RootError::InvalidPath(path.to_owned()))?;
            let result = unsafe { libc::mkdirat(current.as_raw_fd(), value.as_ptr(), 0o770) };
            if result != 0 {
                let source = io::Error::last_os_error();
                if source.kind() != io::ErrorKind::AlreadyExists {
                    return Err(system("create named-root parent directory", source));
                }
            }
            // Each parent must itself be a directory, never a followed symlink.
            let fd = unsafe {
                libc::openat(
                    current.as_raw_fd(),
                    value.as_ptr(),
                    libc::O_PATH | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                return Err(system(
                    "open named-root parent directory",
                    io::Error::last_os_error(),
                ));
            }
            current = unsafe { OwnedFd::from_raw_fd(fd) };
        }
        Ok(())
    }

    fn write_tree_file(root: RawFd, file: &TreeFile<'_>) -> Result<(), RootError> {
        let path = file.path;
        if path.is_empty()
            || path.len() > 520 // `package/` plus a Registry v1 path of at most 512 bytes.
            || path.starts_with('/')
            || path.contains(['\\', '\0'])
            || path.split('/').count() > 17
            || path.split('/').any(|part| matches!(part, "" | "." | ".."))
            || file.contents.len() as u64 > MAX_FILE_BYTES
        {
            return Err(RootError::InvalidPath(path.to_owned()));
        }
        let duplicated = unsafe { libc::dup(root) };
        if duplicated < 0 {
            return Err(system(
                "duplicate Skill candidate stage",
                io::Error::last_os_error(),
            ));
        }
        let mut current = unsafe { OwnedFd::from_raw_fd(duplicated) };
        let mut parts = path.split('/').peekable();
        while let Some(part) = parts.next() {
            let name = CString::new(part.as_bytes())
                .map_err(|_| RootError::InvalidPath(path.to_owned()))?;
            if parts.peek().is_some() {
                let created = unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) };
                if created != 0 && io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists
                {
                    return Err(system(
                        "create Skill candidate subdirectory",
                        io::Error::last_os_error(),
                    ));
                }
                let next = unsafe {
                    libc::openat(
                        current.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if next < 0 {
                    return Err(system(
                        "open Skill candidate subdirectory",
                        io::Error::last_os_error(),
                    ));
                }
                if unsafe { libc::fsync(current.as_raw_fd()) } != 0 {
                    return Err(system(
                        "sync Skill candidate parent",
                        io::Error::last_os_error(),
                    ));
                }
                current = unsafe { OwnedFd::from_raw_fd(next) };
            } else {
                let mode = if file.executable { 0o700 } else { 0o600 };
                let fd = unsafe {
                    libc::openat(
                        current.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_WRONLY
                            | libc::O_CREAT
                            | libc::O_EXCL
                            | libc::O_NOFOLLOW
                            | libc::O_CLOEXEC,
                        mode,
                    )
                };
                if fd < 0 {
                    return Err(system(
                        "create Skill candidate file",
                        io::Error::last_os_error(),
                    ));
                }
                let mut output = unsafe { File::from_raw_fd(fd) };
                output
                    .write_all(file.contents)
                    .and_then(|_| output.sync_all())
                    .map_err(|source| system("write Skill candidate file", source))?;
                if unsafe { libc::fsync(current.as_raw_fd()) } != 0 {
                    return Err(system(
                        "sync Skill candidate directory",
                        io::Error::last_os_error(),
                    ));
                }
            }
        }
        Ok(())
    }

    fn snapshot_tree_directory(
        directory: RawFd,
        prefix: &str,
        entries: &mut Vec<TreeEntry>,
        total: &mut u64,
    ) -> Result<(), RootError> {
        let items = fs::read_dir(format!("/proc/self/fd/{directory}"))
            .map_err(|source| system("read Skill candidate directory", source))?;
        for item in items {
            let item = item.map_err(|source| system("read Skill candidate entry", source))?;
            let name = item
                .file_name()
                .into_string()
                .map_err(|_| RootError::InvalidPath("non-UTF8 candidate entry".into()))?;
            let path = if prefix.is_empty() {
                name
            } else {
                format!("{prefix}/{name}")
            };
            if entries.len() >= 512 || path.len() > 512 || path.split('/').count() > 16 {
                return Err(RootError::TooLarge);
            }
            let name = CString::new(item.file_name().as_encoded_bytes())
                .map_err(|_| RootError::InvalidPath(path.clone()))?;
            let kind = item
                .file_type()
                .map_err(|source| system("classify Skill candidate entry", source))?;
            if kind.is_dir() {
                let child = unsafe {
                    libc::openat(
                        directory,
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if child < 0 {
                    return Err(system(
                        "open Skill candidate directory",
                        io::Error::last_os_error(),
                    ));
                }
                let child = unsafe { OwnedFd::from_raw_fd(child) };
                entries.push(TreeEntry {
                    path: path.clone(),
                    contents: None,
                    executable: false,
                });
                snapshot_tree_directory(child.as_raw_fd(), &path, entries, total)?;
            } else if kind.is_file() {
                let fd = unsafe {
                    libc::openat(
                        directory,
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
                    )
                };
                if fd < 0 {
                    return Err(system(
                        "open Skill candidate file",
                        io::Error::last_os_error(),
                    ));
                }
                let file = File::from(unsafe { OwnedFd::from_raw_fd(fd) });
                let metadata = file
                    .metadata()
                    .map_err(|source| system("stat Skill candidate file", source))?;
                if !metadata.is_file()
                    || metadata.len() > MAX_FILE_BYTES
                    || total.saturating_add(metadata.len()) > 32 * 1024 * 1024
                {
                    return Err(RootError::TooLarge);
                }
                let executable = metadata.permissions().mode() & 0o111 != 0;
                let mut contents = Vec::with_capacity(metadata.len() as usize);
                file.take(MAX_FILE_BYTES + 1)
                    .read_to_end(&mut contents)
                    .map_err(|source| system("read Skill candidate file", source))?;
                if contents.len() as u64 != metadata.len() {
                    return Err(RootError::OutcomeUnknown {
                        operation: "read Skill candidate file",
                        detail: "file length changed while reading".into(),
                    });
                }
                *total += contents.len() as u64;
                entries.push(TreeEntry {
                    path,
                    contents: Some(contents),
                    executable,
                });
            } else {
                return Err(RootError::InvalidPath(path));
            }
        }
        Ok(())
    }

    fn atomic_replace(root: RawFd, path: &str, data: &[u8]) -> Result<(), RootError> {
        let normalized = normalize_relative_path(path)?;
        let target = Path::new(normalized);
        let file_name = target
            .file_name()
            .ok_or_else(|| RootError::InvalidPath(normalized.to_owned()))?;
        if file_name.as_encoded_bytes() == b"." {
            return Err(RootError::InvalidPath(normalized.to_owned()));
        }
        let parent = target
            .parent()
            .filter(|path| !path.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        let parent_path = parent
            .to_str()
            .ok_or_else(|| RootError::InvalidPath(normalized.to_owned()))?;
        // A component split from the normalized target must retain its whitespace.
        let parent_fd = open_normalized_relative(
            root,
            parent_path,
            (libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_DIRECTORY) as u64,
            0,
        )?;
        let target_name = CString::new(file_name.as_encoded_bytes())
            .map_err(|_| RootError::InvalidPath(normalized.to_owned()))?;
        let temp_name = CString::new(format!(".antnest-write-{}.tmp", Uuid::new_v4()))
            .map_err(|_| RootError::InvalidPath(normalized.to_owned()))?;

        let temp_raw = unsafe {
            libc::openat(
                parent_fd.as_raw_fd(),
                temp_name.as_ptr(),
                libc::O_WRONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_CREAT | libc::O_EXCL,
                0o660,
            )
        };
        if temp_raw < 0 {
            return Err(system(
                "create atomic write temporary file",
                io::Error::last_os_error(),
            ));
        }
        let temp_fd = unsafe { OwnedFd::from_raw_fd(temp_raw) };
        let result = (|| {
            let mut file = File::from(temp_fd);
            file.write_all(data)
                .and_then(|_| file.sync_all())
                .map_err(|source| system("sync atomic write temporary file", source))?;
            let renamed = unsafe {
                libc::renameat(
                    parent_fd.as_raw_fd(),
                    temp_name.as_ptr(),
                    parent_fd.as_raw_fd(),
                    target_name.as_ptr(),
                )
            };
            if renamed != 0 {
                return Err(system(
                    "commit atomic named-root file",
                    io::Error::last_os_error(),
                ));
            }
            let synced = unsafe { libc::fsync(parent_fd.as_raw_fd()) };
            if synced != 0 {
                return Err(RootError::OutcomeUnknown {
                    operation: "sync atomic named-root parent directory",
                    detail: io::Error::last_os_error().to_string(),
                });
            }
            Ok(())
        })();
        if result.is_err() {
            unsafe {
                libc::unlinkat(parent_fd.as_raw_fd(), temp_name.as_ptr(), 0);
            }
        }
        result
    }

    fn normalize_relative_path(path: &str) -> Result<&str, RootError> {
        let path = path.trim();
        if path.is_empty() {
            return Ok(".");
        }
        if path.starts_with('/')
            || path.as_bytes().contains(&0)
            || Path::new(path).components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(RootError::InvalidPath(path.to_owned()));
        }
        Ok(path)
    }

    fn system(operation: &'static str, source: io::Error) -> RootError {
        RootError::System { operation, source }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::os::unix::fs::symlink;
        use tempfile::tempdir;

        #[test]
        fn write_replaces_and_appends_atomically() {
            let workspace = tempdir().expect("workspace");
            let skills = tempdir().expect("skills");
            let roots = NamedRoots::open(workspace.path(), skills.path()).expect("open roots");

            roots
                .write(NamedRoot::Workspace, "nested/file.txt", b"first", false)
                .expect("initial write");
            roots
                .write(NamedRoot::Workspace, "nested/file.txt", b"-second", true)
                .expect("append");

            let result = roots
                .read(NamedRoot::Workspace, "nested/file.txt")
                .expect("read committed file");
            assert_eq!(result.data, b"first-second");
            let entries = fs::read_dir(workspace.path().join("nested"))
                .expect("read parent")
                .collect::<Result<Vec<_>, _>>()
                .expect("collect entries");
            assert_eq!(entries.len(), 1);
        }

        #[test]
        fn system_skill_reads_follow_the_current_collection() {
            let workspace = tempdir().expect("workspace");
            let storage = tempdir().expect("Skill storage");
            let current = storage.path().join("current");
            let next = storage.path().join("next");
            fs::create_dir(&current).expect("current Skill set");
            fs::create_dir(&next).expect("next Skill set");
            fs::write(current.join("version.txt"), b"v1").expect("write current Skill");
            fs::write(next.join("version.txt"), b"v2").expect("write next Skill");
            let public = storage.path().join("public-skills");
            symlink(&current, &public).expect("public Skill root");
            let roots = NamedRoots::open(workspace.path(), &public).expect("open roots");

            let before = roots
                .read(NamedRoot::SystemSkills, "version.txt")
                .expect("read initial Skill set");
            assert_eq!(before.data, b"v1");

            let retired = storage.path().join("retired");
            fs::rename(&current, &retired).expect("retire current Skill set");
            fs::rename(&next, &current).expect("activate next Skill set");
            let after = roots
                .read(NamedRoot::SystemSkills, "version.txt")
                .expect("read activated Skill set");
            assert_eq!(after.data, b"v2");
        }

        #[test]
        fn rejected_oversized_append_preserves_previous_file() {
            let workspace = tempdir().expect("workspace");
            let skills = tempdir().expect("skills");
            let roots = NamedRoots::open(workspace.path(), skills.path()).expect("open roots");
            roots
                .write(NamedRoot::Workspace, "file.txt", b"stable", false)
                .expect("initial write");

            let oversized = vec![b'x'; MAX_FILE_BYTES as usize];
            assert!(matches!(
                roots.write(NamedRoot::Workspace, "file.txt", &oversized, true),
                Err(RootError::TooLarge)
            ));
            let result = roots
                .read(NamedRoot::Workspace, "file.txt")
                .expect("read preserved file");
            assert_eq!(result.data, b"stable");
        }

        #[test]
        fn hidden_skill_storage_count_includes_detached_bytes_and_rejects_symlinks() {
            let workspace = tempdir().expect("workspace");
            let skills = tempdir().expect("skills");
            let roots = NamedRoots::open(workspace.path(), skills.path()).expect("open roots");
            assert_eq!(roots.hidden_skill_storage_bytes(256).unwrap(), 0);
            for (parent, name, bytes) in [
                ("candidates", "a", b"one".as_slice()),
                ("release-stage", "d", b"eight".as_slice()),
            ] {
                roots
                    .write(
                        NamedRoot::Workspace,
                        &format!(".antnest/skill-learning/{parent}/{name}/SKILL.md"),
                        bytes,
                        false,
                    )
                    .unwrap();
            }
            assert_eq!(roots.hidden_skill_storage_bytes(256).unwrap(), 3 + 5);
            assert!(roots.hidden_skill_storage_bytes(7).unwrap() > 7);
            let bad = workspace
                .path()
                .join(".antnest/skill-learning/candidates/a/escape");
            symlink(skills.path(), bad).unwrap();
            assert!(roots.hidden_skill_storage_bytes(256).is_err());
        }

        #[test]
        fn candidate_tree_publish_is_complete_noreplace_and_nofollow() {
            let workspace = tempdir().expect("workspace");
            let skills = tempdir().expect("skills");
            let outside = tempdir().expect("outside");
            let roots = NamedRoots::open(workspace.path(), skills.path()).expect("open roots");
            let files = [
                TreeFile {
                    path: "package/SKILL.md",
                    contents: b"ready",
                    executable: false,
                },
                TreeFile {
                    path: "package/scripts/run.sh",
                    contents: b"#!/bin/sh\n",
                    executable: true,
                },
                TreeFile {
                    path: "receipt.json",
                    contents: b"{}",
                    executable: false,
                },
            ];
            roots
                .publish_workspace_tree(".antnest/skill-learning/candidates", "candidate-1", &files)
                .expect("publish candidate");
            let root = workspace
                .path()
                .join(".antnest/skill-learning/candidates/candidate-1");
            assert_eq!(fs::read(root.join("package/SKILL.md")).unwrap(), b"ready");
            use std::os::unix::fs::PermissionsExt as _;
            assert_ne!(
                fs::metadata(root.join("package/scripts/run.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
            assert!(
                roots
                    .publish_workspace_tree(
                        ".antnest/skill-learning/candidates",
                        "candidate-1",
                        &files
                    )
                    .is_err()
            );
            assert_eq!(fs::read(root.join("package/SKILL.md")).unwrap(), b"ready");

            let outside_link = workspace.path().join(".antnest/skill-learning/escape");
            symlink(outside.path(), &outside_link).unwrap();
            assert!(
                roots
                    .publish_workspace_tree(".antnest/skill-learning/escape", "candidate-2", &files)
                    .is_err()
            );
            assert!(!outside.path().join("candidate-2").exists());
            assert!(
                roots
                    .publish_workspace_tree(
                        ".antnest/skill-learning/candidates",
                        "candidate-3",
                        &[TreeFile {
                            path: "../escape",
                            contents: b"x",
                            executable: false
                        }]
                    )
                    .is_err()
            );
            assert!(
                !workspace
                    .path()
                    .join(".antnest/skill-learning/escape")
                    .join("candidate-3")
                    .exists()
            );
        }

        #[test]
        fn candidate_tree_install_uses_atomic_create_and_exchange() {
            let workspace = tempdir().expect("workspace");
            let skills = tempdir().expect("system Skills");
            let roots = NamedRoots::open(workspace.path(), skills.path()).expect("roots");
            for (key, contents) in [
                ("first", b"first".as_slice()),
                ("second", b"second".as_slice()),
            ] {
                roots
                    .publish_workspace_tree(
                        ".antnest/skill-learning/candidates",
                        key,
                        &[TreeFile {
                            path: "package/SKILL.md",
                            contents,
                            executable: false,
                        }],
                    )
                    .expect("candidate");
            }
            let active = workspace
                .path()
                .join(".antnest/skills/retry-timeouts/SKILL.md");
            let first = workspace
                .path()
                .join(".antnest/skill-learning/candidates/first/package");
            let second = workspace
                .path()
                .join(".antnest/skill-learning/candidates/second/package/SKILL.md");
            roots
                .install_candidate_tree("first", "retry-timeouts", TreeInstallMode::Create)
                .expect("atomic new Skill");
            assert_eq!(fs::read(&active).unwrap(), b"first");
            assert!(!first.exists());
            assert!(
                roots
                    .install_candidate_tree("second", "retry-timeouts", TreeInstallMode::Create)
                    .is_err()
            );
            assert_eq!(fs::read(&active).unwrap(), b"first");
            assert_eq!(fs::read(&second).unwrap(), b"second");
            roots
                .install_candidate_tree("second", "retry-timeouts", TreeInstallMode::Replace)
                .expect("atomic replacement");
            assert_eq!(fs::read(&active).unwrap(), b"second");
            assert_eq!(fs::read(&second).unwrap(), b"first");
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::path::Path;

    use thiserror::Error;

    use super::{DirectoryListing, FilePreview, NamedRoot, TreeEntry, TreeFile, TreeInstallMode};

    #[derive(Debug, Error)]
    #[error("named-root file access requires Linux openat2")]
    pub struct RootError;

    pub struct ReadResult {
        pub data: Vec<u8>,
    }

    pub struct NamedRoots;

    impl RootError {
        pub fn is_not_found(&self) -> bool {
            false
        }
        pub fn outcome_unknown(&self) -> bool {
            false
        }
    }

    impl NamedRoots {
        pub fn open(_workspace: &Path, _system_skills: &Path) -> Result<Self, RootError> {
            Err(RootError)
        }
        pub fn read(&self, _root: NamedRoot, _path: &str) -> Result<ReadResult, RootError> {
            Err(RootError)
        }
        pub fn target_path(
            &self,
            _root: NamedRoot,
            _path: &str,
        ) -> Result<std::path::PathBuf, RootError> {
            Err(RootError)
        }
        pub fn read_preview(
            &self,
            _root: NamedRoot,
            _path: &str,
            _limit: usize,
        ) -> Result<FilePreview, RootError> {
            Err(RootError)
        }
        pub fn list_directories(
            &self,
            _root: NamedRoot,
            _path: &str,
            _limit: usize,
        ) -> Result<DirectoryListing, RootError> {
            Err(RootError)
        }
        pub fn write(
            &self,
            _root: NamedRoot,
            _path: &str,
            _data: &[u8],
            _append: bool,
        ) -> Result<u64, RootError> {
            Err(RootError)
        }
        pub fn publish_workspace_tree(
            &self,
            _parent: &str,
            _name: &str,
            _files: &[TreeFile<'_>],
        ) -> Result<(), RootError> {
            Err(RootError)
        }
        pub fn snapshot_workspace_tree(&self, _path: &str) -> Result<Vec<TreeEntry>, RootError> {
            Err(RootError)
        }
        pub fn workspace_tree_exists(&self, _path: &str) -> Result<bool, RootError> {
            Err(RootError)
        }
        pub fn remove_temporary_skill_tree(&self, _scope: Option<&str>) -> Result<(), RootError> {
            Err(RootError)
        }
        pub fn hidden_skill_storage_bytes(&self, _cutoff: u64) -> Result<u64, RootError> {
            Err(RootError)
        }
        pub fn detach_skill_learning_tree(
            &self,
            _source_parent: &str,
            _storage_key: &str,
            _release_key: &str,
        ) -> Result<(), RootError> {
            Err(RootError)
        }
        pub fn remove_detached_skill_learning_tree(
            &self,
            _release_key: &str,
        ) -> Result<(), RootError> {
            Err(RootError)
        }
        pub fn install_candidate_tree(
            &self,
            _candidate_key: &str,
            _skill_name: &str,
            _mode: TreeInstallMode,
        ) -> Result<(), RootError> {
            Err(RootError)
        }
        pub fn retire_active_tree(
            &self,
            _skill_name: &str,
            _effect_key: &str,
        ) -> Result<(), RootError> {
            Err(RootError)
        }
        pub fn workspace_path(&self, _path: &str) -> Result<std::path::PathBuf, RootError> {
            Err(RootError)
        }
        pub fn workspace_root(&self) -> &Path {
            Path::new("/workspace")
        }
    }
}

pub use platform::*;
