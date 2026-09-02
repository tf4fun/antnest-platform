#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NamedRoot {
    Workspace,
    SystemSkills,
}

#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::CString;
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::path::{Component, Path, PathBuf};

    use thiserror::Error;
    use uuid::Uuid;

    #[cfg(test)]
    use std::fs;

    use super::NamedRoot;

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
        #[error("{operation}: {source}")]
        System {
            operation: &'static str,
            #[source]
            source: io::Error,
        },
    }

    impl RootError {
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

        pub fn workspace_root(&self) -> &Path {
            &self.workspace_path
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

        fn root(&self, root: NamedRoot) -> Result<RootHandle, RootError> {
            match root {
                NamedRoot::Workspace => Ok(RootHandle::Borrowed(self.workspace.as_raw_fd())),
                NamedRoot::SystemSkills => Ok(RootHandle::Owned(open_root(&self.system_skills)?)),
            }
        }
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
        let mut current = PathBuf::new();
        for component in parent.components() {
            let Component::Normal(component) = component else {
                continue;
            };
            current.push(component);
            let value = CString::new(current.as_os_str().as_encoded_bytes())
                .map_err(|_| RootError::InvalidPath(path.to_owned()))?;
            let result = unsafe { libc::mkdirat(root, value.as_ptr(), 0o700) };
            if result == 0 {
                continue;
            }
            let source = io::Error::last_os_error();
            if source.kind() != io::ErrorKind::AlreadyExists {
                return Err(system("create named-root parent directory", source));
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
        let parent = target.parent().unwrap_or_else(|| Path::new("."));
        let parent_path = parent
            .to_str()
            .ok_or_else(|| RootError::InvalidPath(normalized.to_owned()))?;
        let parent_fd = open_relative(
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
                0o600,
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
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::path::Path;

    use thiserror::Error;

    use super::NamedRoot;

    #[derive(Debug, Error)]
    #[error("named-root file access requires Linux openat2")]
    pub struct RootError;

    pub struct ReadResult {
        pub data: Vec<u8>,
    }

    pub struct NamedRoots;

    impl RootError {
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
        pub fn write(
            &self,
            _root: NamedRoot,
            _path: &str,
            _data: &[u8],
            _append: bool,
        ) -> Result<u64, RootError> {
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
