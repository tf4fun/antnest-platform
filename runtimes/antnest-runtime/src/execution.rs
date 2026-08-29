use std::collections::HashSet;
use std::path::{Component, Path};
use std::time::Duration;

pub(crate) const MAX_FILE_CONTENT_BYTES: usize = 8 * 1024 * 1024;
pub(crate) const MAX_BASH_TIMEOUT_MS: u64 = 24 * 60 * 60 * 1000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RootName {
    Workspace,
    SystemSkills,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RootPath {
    root: RootName,
    path: String,
}

impl RootPath {
    pub(crate) fn new(root: RootName, path: String) -> Result<Self, &'static str> {
        if path.trim().is_empty() || path.as_bytes().contains(&0) {
            return Err("root-relative path is required");
        }
        if Path::new(&path).components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        }) {
            return Err("path must stay relative to its named root");
        }
        Ok(Self { root, path })
    }

    pub(crate) fn root(&self) -> RootName {
        self.root
    }

    pub(crate) fn path(&self) -> &str {
        &self.path
    }

    pub(crate) fn into_parts(self) -> (RootName, String) {
        (self.root, self.path)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EnvironmentVariable {
    name: String,
    value: String,
}

impl EnvironmentVariable {
    pub(crate) fn new(name: String, value: String) -> Self {
        Self { name, value }
    }

    pub(crate) fn name(&self) -> &str {
        &self.name
    }

    pub(crate) fn value(&self) -> &str {
        &self.value
    }

    pub(crate) fn into_parts(self) -> (String, String) {
        (self.name, self.value)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BashRequest {
    command: String,
    working_dir: RootPath,
    env: Vec<EnvironmentVariable>,
    timeout: Duration,
}

impl BashRequest {
    pub(crate) fn new(
        command: String,
        working_dir: RootPath,
        env: Vec<EnvironmentVariable>,
        timeout_ms: u64,
    ) -> Result<Self, &'static str> {
        if command.trim().is_empty() || command.as_bytes().contains(&0) {
            return Err("bash command is required and must not contain NUL");
        }
        if working_dir.root != RootName::Workspace {
            return Err("bash working directory must use the workspace root");
        }
        if timeout_ms == 0 || timeout_ms > MAX_BASH_TIMEOUT_MS {
            return Err("bash timeout is outside the supported range");
        }
        validate_environment(&env)?;
        Ok(Self {
            command,
            working_dir,
            env,
            timeout: Duration::from_millis(timeout_ms),
        })
    }

    pub(crate) fn timeout(&self) -> Duration {
        self.timeout
    }

    pub(crate) fn command(&self) -> &str {
        &self.command
    }

    pub(crate) fn working_dir(&self) -> &RootPath {
        &self.working_dir
    }

    pub(crate) fn environment(&self) -> &[EnvironmentVariable] {
        &self.env
    }

    pub(crate) fn into_parts(self) -> (String, RootPath, Vec<EnvironmentVariable>, Duration) {
        (self.command, self.working_dir, self.env, self.timeout)
    }
}

fn validate_environment(environment: &[EnvironmentVariable]) -> Result<(), &'static str> {
    let mut names = HashSet::with_capacity(environment.len());
    for variable in environment {
        let name = variable.name.trim();
        if name.is_empty() || name.as_bytes().contains(&b'=') || name.as_bytes().contains(&0) {
            return Err("environment variable name is invalid");
        }
        if matches!(name, "HOME" | "PATH") {
            return Err("HOME and PATH are managed by Runtime");
        }
        if !names.insert(name) {
            return Err("environment variable name is duplicated");
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct BashResult {
    pub(crate) exit_code: i32,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReadRequest {
    path: RootPath,
    offset: usize,
    limit: usize,
}

impl ReadRequest {
    pub(crate) fn new(path: RootPath, offset: i64, limit: i64) -> Result<Self, &'static str> {
        if offset < 0 || limit <= 0 || limit as u64 > MAX_FILE_CONTENT_BYTES as u64 {
            return Err("read offset and limit are invalid");
        }
        Ok(Self {
            path,
            offset: offset as usize,
            limit: limit as usize,
        })
    }

    pub(crate) fn path(&self) -> &RootPath {
        &self.path
    }

    pub(crate) fn offset(&self) -> usize {
        self.offset
    }

    pub(crate) fn limit(&self) -> usize {
        self.limit
    }

    pub(crate) fn into_parts(self) -> (RootPath, usize, usize) {
        (self.path, self.offset, self.limit)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ReadResult {
    pub(crate) content: String,
    pub(crate) truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WriteRequest {
    path: RootPath,
    content: String,
}

impl WriteRequest {
    pub(crate) fn new(path: RootPath, content: String) -> Result<Self, &'static str> {
        if path.root != RootName::Workspace {
            return Err("write path must use the workspace root");
        }
        if content.len() > MAX_FILE_CONTENT_BYTES {
            return Err("write content exceeds the supported limit");
        }
        Ok(Self { path, content })
    }

    pub(crate) fn into_parts(self) -> (RootPath, String) {
        (self.path, self.content)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WriteResult {
    pub(crate) bytes_written: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EditRequest {
    path: RootPath,
    old_string: String,
    new_string: String,
}

impl EditRequest {
    pub(crate) fn new(
        path: RootPath,
        old_string: String,
        new_string: String,
    ) -> Result<Self, &'static str> {
        if path.root != RootName::Workspace {
            return Err("edit path must use the workspace root");
        }
        if old_string.is_empty() {
            return Err("old_string is required");
        }
        if old_string.len() > MAX_FILE_CONTENT_BYTES || new_string.len() > MAX_FILE_CONTENT_BYTES {
            return Err("edit content exceeds the supported limit");
        }
        Ok(Self {
            path,
            old_string,
            new_string,
        })
    }

    pub(crate) fn into_parts(self) -> (RootPath, String, String) {
        (self.path, self.old_string, self.new_string)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EditResult {
    pub(crate) bytes_written: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_paths_reject_escape_components() {
        for path in ["/etc/passwd", "../outside", "a/../inside"] {
            assert!(RootPath::new(RootName::Workspace, path.into()).is_err());
        }
    }

    #[test]
    fn runtime_owned_environment_names_cannot_be_overridden() {
        for name in ["HOME", "PATH"] {
            let request = BashRequest::new(
                "true".into(),
                RootPath::new(RootName::Workspace, ".".into()).unwrap(),
                vec![EnvironmentVariable::new(
                    name.into(),
                    "/tmp/override".into(),
                )],
                1000,
            );
            assert!(request.is_err(), "{name} must remain Runtime-owned");
        }
    }
}
