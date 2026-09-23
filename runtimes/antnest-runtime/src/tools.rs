use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

use crate::execution::{
    BashRequest, BashResult, EditRequest, EditResult, MAX_FILE_CONTENT_BYTES, ReadRequest,
    ReadResult, RootName, WriteRequest, WriteResult,
};
use crate::progress::{ProgressSink, ProgressUpdate, Utf8Preview};
use crate::roots::{NamedRoot, NamedRoots, RootError};
use crate::tool_error::{ToolError, ToolErrorCode};

const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(2);

type CapturedOutput = (Vec<u8>, bool, Option<String>);
type OutputTask = Option<OutputCapture>;

struct OutputCapture {
    task: tokio::task::JoinHandle<CapturedOutput>,
    stop: CancellationToken,
}

impl OutputCapture {
    fn start(
        reader: impl AsyncRead + Unpin + Send + 'static,
        progress: BashProgress,
        stream: &'static str,
    ) -> Self {
        let stop = CancellationToken::new();
        Self {
            task: tokio::spawn(read_output(reader, stop.clone(), progress, stream)),
            stop,
        }
    }
}

#[derive(Clone, Default)]
struct BashProgress {
    sink: ProgressSink,
    bytes: Arc<std::sync::Mutex<usize>>,
}

impl BashProgress {
    fn emit(&self, stream: &str, text: String) {
        if text.is_empty() {
            return;
        }
        let mut bytes = self
            .bytes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *bytes += text.len();
        self.sink.emit(ProgressUpdate::message(
            *bytes as f64,
            format!("{stream}: {text}"),
        ));
    }
}

#[derive(Clone)]
pub(crate) struct ToolEngine {
    roots: Arc<NamedRoots>,
    home: PathBuf,
}

impl ToolEngine {
    pub(crate) fn new(roots: Arc<NamedRoots>) -> Self {
        let home = roots.workspace_root().to_owned();
        Self { roots, home }
    }

    #[cfg(test)]
    pub(crate) fn information(
        &self,
        cancel: &CancellationToken,
    ) -> Result<crate::information::RuntimeContext, ToolError> {
        reject_canceled(cancel)?;
        crate::information::RuntimeContext::collect(&self.roots)
    }

    #[cfg(test)]
    pub(crate) async fn bash(
        &self,
        input: BashRequest,
        cancel: CancellationToken,
    ) -> Result<BashResult, ToolError> {
        self.bash_with_progress(input, cancel, ProgressSink::default())
            .await
    }

    pub(crate) async fn bash_with_progress(
        &self,
        input: BashRequest,
        cancel: CancellationToken,
        progress: ProgressSink,
    ) -> Result<BashResult, ToolError> {
        reject_canceled(&cancel)?;
        self.run_bash(input, cancel, progress).await
    }

    async fn run_bash(
        &self,
        input: BashRequest,
        cancel: CancellationToken,
        progress: ProgressSink,
    ) -> Result<BashResult, ToolError> {
        let working_dir = self
            .roots
            .workspace_path(input.working_dir().path())
            .map_err(|error| ToolError::new(ToolErrorCode::InvalidPath, error))?;
        let mut command = Command::new("/bin/bash");
        command
            .args(["-lc", input.command()])
            .current_dir(working_dir)
            .env_clear()
            .env("HOME", &self.home)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .envs(
                input
                    .environment()
                    .iter()
                    .map(|value| (value.name(), value.value())),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = command
            .spawn()
            .map_err(|error| ToolError::new(ToolErrorCode::SpawnFailed, error))?;
        let progress = BashProgress {
            sink: progress,
            ..Default::default()
        };
        let stdout = child
            .stdout
            .take()
            .map(|reader| OutputCapture::start(reader, progress.clone(), "stdout"));
        let stderr = child
            .stderr
            .take()
            .map(|reader| OutputCapture::start(reader, progress, "stderr"));

        enum Exit {
            Wait(std::io::Result<std::process::ExitStatus>),
            Canceled,
            TimedOut,
        }
        let exit = tokio::select! {
            _ = cancel.cancelled() => Exit::Canceled,
            result = child.wait() => Exit::Wait(result),
            _ = tokio::time::sleep(input.timeout()) => Exit::TimedOut,
        };
        let status = match exit {
            Exit::Wait(Ok(status)) => status,
            Exit::Wait(Err(error)) => {
                terminate_and_reap(&mut child).await;
                drain_outputs(stdout, stderr).await;
                return Err(ToolError::unknown(ToolErrorCode::WaitFailed, error));
            }
            Exit::Canceled => {
                terminate_and_reap(&mut child).await;
                drain_outputs(stdout, stderr).await;
                return Err(ToolError::unknown(
                    ToolErrorCode::Canceled,
                    "request canceled after bash dispatch",
                ));
            }
            Exit::TimedOut => {
                terminate_and_reap(&mut child).await;
                drain_outputs(stdout, stderr).await;
                return Err(ToolError::unknown(
                    ToolErrorCode::Timeout,
                    "bash command timed out",
                ));
            }
        };
        let ((stdout, stdout_truncated, stdout_error), (stderr, stderr_truncated, stderr_error)) =
            tokio::join!(join_output(stdout), join_output(stderr));
        if let Some(error) = output_error(stdout_error, stderr_error) {
            return Err(ToolError::unknown(
                ToolErrorCode::OutputCaptureFailed,
                error,
            ));
        }
        Ok(BashResult {
            exit_code: status.code().unwrap_or(128),
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            truncated: stdout_truncated || stderr_truncated,
        })
    }

    pub(crate) async fn read(
        &self,
        input: ReadRequest,
        cancel: CancellationToken,
    ) -> Result<ReadResult, ToolError> {
        reject_canceled(&cancel)?;
        let roots = self.roots.clone();
        let root = storage_root(input.path().root());
        let path = input.path().path().to_owned();
        let file = observe_file(&roots, root, &path, None);
        let result = tokio::task::spawn_blocking(move || roots.read(root, &path))
            .await
            .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?
            .map_err(|error| ToolError::new(ToolErrorCode::ReadFailed, error))?;
        reject_canceled(&cancel)?;
        let offset = input.offset().min(result.data.len());
        let limit = input.limit();
        let end = offset.saturating_add(limit).min(result.data.len());
        let content = std::str::from_utf8(&result.data[offset..end])
            .map_err(|error| ToolError::new(ToolErrorCode::ContentNotUtf8, error))?
            .to_owned();
        Ok(ReadResult {
            content,
            truncated: end < result.data.len(),
            file,
        })
    }

    pub(crate) async fn write(
        &self,
        input: WriteRequest,
        cancel: CancellationToken,
    ) -> Result<WriteResult, ToolError> {
        reject_canceled(&cancel)?;
        let roots = self.roots.clone();
        let (path, content) = input.into_parts();
        let path = path.path().to_owned();
        let content = content.into_bytes();
        tokio::task::spawn_blocking(move || {
            let change = observe_replacement(&roots, &path, &content);
            let file = observe_file(&roots, NamedRoot::Workspace, &path, Some(change));
            let bytes_written = roots.write(NamedRoot::Workspace, &path, &content, false)?;
            Ok(WriteResult {
                bytes_written,
                file,
            })
        })
        .await
        .map_err(ToolError::outcome_unknown)?
        .map_err(|error| write_error(ToolErrorCode::WriteFailed, error))
    }

    pub(crate) async fn edit(
        &self,
        input: EditRequest,
        cancel: CancellationToken,
    ) -> Result<EditResult, ToolError> {
        reject_canceled(&cancel)?;
        let (path, old_string, new_string) = input.into_parts();
        let roots = self.roots.clone();
        let read_path = path.path().to_owned();
        let existing =
            tokio::task::spawn_blocking(move || roots.read(NamedRoot::Workspace, &read_path))
                .await
                .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?
                .map_err(|error| ToolError::new(ToolErrorCode::EditReadFailed, error))?
                .data;
        reject_canceled(&cancel)?;

        let old = old_string.as_bytes();
        let matches = existing
            .windows(old.len())
            .enumerate()
            .filter_map(|(index, value)| (value == old).then_some(index))
            .take(2)
            .collect::<Vec<_>>();
        let [index] = matches.as_slice() else {
            let code = if matches.is_empty() {
                ToolErrorCode::OldStringNotFound
            } else {
                ToolErrorCode::OldStringNotUnique
            };
            return Err(ToolError::new(code, "the file was not changed"));
        };
        let final_size = existing
            .len()
            .checked_sub(old.len())
            .and_then(|size| size.checked_add(new_string.len()));
        let Some(final_size) = final_size.filter(|size| *size <= MAX_FILE_CONTENT_BYTES) else {
            return Err(ToolError::new(
                ToolErrorCode::ResultTooLarge,
                "the edited file would exceed 8 MiB",
            ));
        };
        let mut updated = Vec::with_capacity(final_size);
        updated.extend_from_slice(&existing[..*index]);
        updated.extend_from_slice(new_string.as_bytes());
        updated.extend_from_slice(&existing[*index + old.len()..]);
        reject_canceled(&cancel)?;

        let roots = self.roots.clone();
        let path = path.path().to_owned();
        let change = crate::file_observation::FileChange::text(Some(&existing), &updated);
        tokio::task::spawn_blocking(move || {
            let file = observe_file(&roots, NamedRoot::Workspace, &path, Some(change));
            let bytes_written = roots.write(NamedRoot::Workspace, &path, &updated, false)?;
            Ok(EditResult {
                bytes_written,
                file,
            })
        })
        .await
        .map_err(ToolError::outcome_unknown)?
        .map_err(|error| write_error(ToolErrorCode::EditFailed, error))
    }
}

fn observe_file(
    roots: &NamedRoots,
    root: NamedRoot,
    path: &str,
    change: Option<crate::file_observation::FileChange>,
) -> Option<crate::file_observation::FileObservation> {
    let target = roots.target_path(root, path).ok()?;
    Some(crate::file_observation::FileObservation {
        path: target.to_str()?.to_owned(),
        change,
    })
}

fn observe_replacement(
    roots: &NamedRoots,
    path: &str,
    content: &[u8],
) -> crate::file_observation::FileChange {
    use crate::file_observation::{FileChange, MAX_CHANGE_BYTES};

    match roots.read_preview(NamedRoot::Workspace, path, MAX_CHANGE_BYTES) {
        Ok(before) if before.truncated => FileChange::TooLarge,
        Ok(before) => FileChange::text(Some(&before.data), content),
        Err(error) if error.is_not_found() => FileChange::text(None, content),
        Err(_) => FileChange::Unavailable,
    }
}

fn reject_canceled(cancel: &CancellationToken) -> Result<(), ToolError> {
    if cancel.is_cancelled() {
        Err(canceled())
    } else {
        Ok(())
    }
}

fn canceled() -> ToolError {
    ToolError::new(ToolErrorCode::Canceled, "request canceled")
}

fn write_error(code: ToolErrorCode, error: RootError) -> ToolError {
    if error.outcome_unknown() {
        ToolError::outcome_unknown(error)
    } else {
        ToolError::new(code, error)
    }
}

fn storage_root(root: RootName) -> NamedRoot {
    match root {
        RootName::Workspace => NamedRoot::Workspace,
        RootName::SystemSkills => NamedRoot::SystemSkills,
    }
}

fn output_error(stdout: Option<String>, stderr: Option<String>) -> Option<String> {
    let errors = [
        stdout.map(|error| format!("stdout: {error}")),
        stderr.map(|error| format!("stderr: {error}")),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>();
    (!errors.is_empty()).then(|| errors.join("; "))
}

async fn drain_outputs(stdout: OutputTask, stderr: OutputTask) {
    let _ = tokio::join!(join_output(stdout), join_output(stderr));
}

async fn terminate_and_reap(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id().and_then(|value| i32::try_from(value).ok()) {
        let _ = kill(Pid::from_raw(pid), Signal::SIGTERM);
    }
    let reaped = tokio::time::timeout(PROCESS_STOP_TIMEOUT, child.wait())
        .await
        .is_ok_and(|result| result.is_ok());
    if !reaped {
        let _ = child.start_kill();
        let _ = tokio::time::timeout(PROCESS_STOP_TIMEOUT, child.wait()).await;
    }
}

async fn read_output<R: AsyncRead + Unpin>(
    mut reader: R,
    stop: CancellationToken,
    progress: BashProgress,
    stream: &'static str,
) -> CapturedOutput {
    let mut output = Vec::new();
    let mut chunk = [0_u8; 2048];
    let mut preview = Utf8Preview::default();
    let mut truncated = false;
    loop {
        let read = tokio::select! {
            biased;
            _ = stop.cancelled() => {
                progress.emit(stream, preview.push(&[], true));
                return (output, true, None);
            },
            read = reader.read(&mut chunk) => read,
        };
        match read {
            Ok(0) => {
                progress.emit(stream, preview.push(&[], true));
                return (output, truncated, None);
            }
            Err(error) => return (output, true, Some(error.to_string())),
            Ok(size) => {
                let remaining = MAX_OUTPUT_BYTES.saturating_sub(output.len());
                let kept = size.min(remaining);
                output.extend_from_slice(&chunk[..kept]);
                progress.emit(stream, preview.push(&chunk[..kept], false));
                truncated |= kept < size;
            }
        }
    }
}

async fn join_output(task: OutputTask) -> CapturedOutput {
    let Some(mut capture) = task else {
        return (Vec::new(), false, None);
    };
    let result = match tokio::time::timeout(OUTPUT_DRAIN_TIMEOUT, &mut capture.task).await {
        Ok(result) => result,
        Err(_) => {
            // A successful shell may have left a background writer. Stop reading
            // without terminating that process or discarding the captured prefix.
            capture.stop.cancel();
            capture.task.await
        }
    };
    match result {
        Ok(output) => output,
        Err(error) => (Vec::new(), true, Some(error.to_string())),
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn inherited_output_pipe_returns_captured_prefix_without_failing_the_call() {
        use tokio::io::AsyncWriteExt as _;

        let (mut writer, reader) = tokio::io::duplex(64);
        writer.write_all(b"server started").await.unwrap();
        let task = Some(super::OutputCapture::start(
            reader,
            super::BashProgress::default(),
            "stdout",
        ));
        let (bytes, truncated, error) = super::join_output(task).await;
        drop(writer);

        assert_eq!(bytes, b"server started");
        assert!(truncated, "the background writer still held the pipe open");
        assert!(
            error.is_none(),
            "an open background pipe is not a tool error"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn post_commit_filesystem_failure_is_an_unknown_tool_outcome() {
        use super::write_error;
        use crate::roots::RootError;
        use crate::tool_error::{ToolEffectState, ToolErrorCode};

        let error = write_error(
            ToolErrorCode::WriteFailed,
            RootError::OutcomeUnknown {
                operation: "verify committed file",
                detail: "readback failed".into(),
            },
        );

        assert_eq!(error.code, ToolErrorCode::OutcomeUnknown);
        assert_eq!(error.effect_state, ToolEffectState::Unknown);
    }

    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/integration/antnest-runtime/tools_bash.rs"
    ));
}
