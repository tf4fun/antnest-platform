use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use nix::errno::Errno;
use nix::sys::signal::{Signal, kill};
use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
use nix::unistd::Pid;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{Notify, mpsc};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;

use crate::command::ToolCommand;
use crate::execution::{
    BashRequest, BashResult, EditRequest, EditResult, EnvironmentVariable, ReadRequest, ReadResult,
    RootName, RootPath, WriteRequest, WriteResult,
};
use crate::executor_protocol::{
    ExecutorFailure, MAX_EXECUTOR_DIAGNOSTIC_BYTES, MAX_EXECUTOR_MESSAGE_BYTES, Outcome,
    decode_bash_reply, decode_edit_reply, decode_read_reply, decode_write_reply,
    encode_bash_request, encode_edit_request, encode_read_request, encode_write_request,
};
use crate::spec::RuntimeIdentity;
use crate::telemetry::RuntimeMetrics;
use crate::tool_error::{ToolError, ToolErrorCode};

const FILE_TOOL_TIMEOUT: Duration = Duration::from_secs(30);
const EXECUTOR_GRACE: Duration = Duration::from_secs(1);
const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(2);
const EXECUTOR_PROBE_COMMAND: &str = "test -w . && test -x . && \
    test -r \"$ANTNEST_PROBE_SYSTEM_SKILLS\" && \
    test -x \"$ANTNEST_PROBE_SYSTEM_SKILLS\"";

type ReplyDecoder<O> = fn(&[u8]) -> Result<Result<O, ExecutorFailure>, serde_json::Error>;

#[derive(Clone, Debug)]
pub(crate) struct ExecutionActor {
    gate: SingleFlight,
    identity: RuntimeIdentity,
    workspace: PathBuf,
    system_skills: PathBuf,
    metrics: RuntimeMetrics,
    shutdown: CancellationToken,
    fatal: mpsc::UnboundedSender<ExecutionFatal>,
}

impl ExecutionActor {
    pub(crate) fn new(
        identity: RuntimeIdentity,
        workspace: PathBuf,
        system_skills: PathBuf,
        metrics: RuntimeMetrics,
        shutdown: CancellationToken,
    ) -> (Self, mpsc::UnboundedReceiver<ExecutionFatal>) {
        let (fatal, failures) = mpsc::unbounded_channel();
        (
            Self {
                gate: SingleFlight::new(),
                identity,
                workspace,
                system_skills,
                metrics,
                shutdown,
                fatal,
            },
            failures,
        )
    }

    pub(crate) async fn probe(&self) -> Result<(), ToolError> {
        let working_dir =
            RootPath::new(RootName::Workspace, ".".into()).map_err(ToolError::invalid_params)?;
        let request = BashRequest::new(
            EXECUTOR_PROBE_COMMAND.into(),
            working_dir,
            vec![EnvironmentVariable::new(
                "ANTNEST_PROBE_SYSTEM_SKILLS".into(),
                self.system_skills.to_string_lossy().into_owned(),
            )],
            5_000,
        )
        .map_err(ToolError::invalid_params)?;
        let result = self.bash(request, CancellationToken::new()).await?;
        validate_probe_result(result)
    }

    pub(crate) async fn bash(
        &self,
        request: BashRequest,
        cancel: CancellationToken,
    ) -> Result<BashResult, ToolError> {
        let timeout = request.timeout().saturating_add(EXECUTOR_GRACE);
        let encoded = encode_bash_request(request).map_err(executor_request_error)?;
        self.execute(
            ToolCommand::Bash,
            encoded,
            decode_bash_reply,
            cancel,
            timeout,
        )
        .await
    }

    pub(crate) async fn read(
        &self,
        request: ReadRequest,
        cancel: CancellationToken,
    ) -> Result<ReadResult, ToolError> {
        let encoded = encode_read_request(request).map_err(executor_request_error)?;
        self.execute(
            ToolCommand::Read,
            encoded,
            decode_read_reply,
            cancel,
            FILE_TOOL_TIMEOUT,
        )
        .await
    }

    pub(crate) async fn write(
        &self,
        request: WriteRequest,
        cancel: CancellationToken,
    ) -> Result<WriteResult, ToolError> {
        let encoded = encode_write_request(request).map_err(executor_request_error)?;
        self.execute(
            ToolCommand::Write,
            encoded,
            decode_write_reply,
            cancel,
            FILE_TOOL_TIMEOUT,
        )
        .await
    }

    pub(crate) async fn edit(
        &self,
        request: EditRequest,
        cancel: CancellationToken,
    ) -> Result<EditResult, ToolError> {
        let encoded = encode_edit_request(request).map_err(executor_request_error)?;
        self.execute(
            ToolCommand::Edit,
            encoded,
            decode_edit_reply,
            cancel,
            FILE_TOOL_TIMEOUT,
        )
        .await
    }

    pub(crate) fn close(&self) {
        self.gate.close();
    }

    pub(crate) async fn drain(&self) -> Result<(), ExecutionFatal> {
        self.gate.close_and_drain().await
    }

    async fn execute<O>(
        &self,
        tool: ToolCommand,
        request: Vec<u8>,
        decode_reply: ReplyDecoder<O>,
        cancel: CancellationToken,
        timeout: Duration,
    ) -> Result<O, ToolError>
    where
        O: Send + 'static,
    {
        if self.shutdown.is_cancelled() {
            self.gate.close();
        }
        let lease = self
            .gate
            .try_acquire()
            .map_err(|error| ToolError::new(error.code(), error))?;
        if self.shutdown.is_cancelled() {
            self.gate.close();
            return Err(ToolError::new(
                ToolErrorCode::RuntimeUnavailable,
                "Runtime is shutting down",
            ));
        }
        if request.len() > MAX_EXECUTOR_MESSAGE_BYTES {
            return Err(ToolError::new(
                ToolErrorCode::InvalidParams,
                "encoded executor request exceeds the supported limit",
            ));
        }
        let call = ExecutorCall {
            tool,
            request,
            workspace: self.workspace.clone(),
            system_skills: self.system_skills.clone(),
            cancel,
            shutdown: self.shutdown.clone(),
            timeout,
            fatal: self.fatal.clone(),
            gate: self.gate.clone(),
            _lease: lease,
        };
        let span = tracing::info_span!(
            "runtime.executor",
            "service.name" = crate::telemetry::SERVICE_NAME,
            "antnest.agent.id" = self.identity.agent_id(),
            "antnest.runtime.generation" = %self.identity.generation(),
            "executor.tool.name" = tool.as_str(),
            "executor.child.pid" = tracing::field::Empty,
            "executor.exit.classification" = tracing::field::Empty,
            "executor.outcome" = tracing::field::Empty,
            "executor.duration_ms" = tracing::field::Empty,
            otel.status_code = tracing::field::Empty,
            "error.type" = tracing::field::Empty,
            trace_id = tracing::field::Empty,
            span_id = tracing::field::Empty,
        );
        crate::telemetry::record_span_identity(&span);
        let identity = self.identity.clone();
        let metrics = self.metrics.clone();
        tokio::spawn(async move {
            let started = tokio::time::Instant::now();
            let result = call.run(decode_reply).instrument(span.clone()).await;
            record_executor_result(&span, &identity, tool, &metrics, &result, started.elapsed());
            result
        })
        .await
        .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?
    }
}

fn executor_request_error(error: serde_json::Error) -> ToolError {
    ToolError::new(ToolErrorCode::RuntimeFailed, error)
}

fn validate_probe_result(result: BashResult) -> Result<(), ToolError> {
    if result.exit_code == 0 {
        Ok(())
    } else {
        Err(ToolError::new(
            ToolErrorCode::RuntimeFailed,
            "executor cannot write the workspace or read the system Skill root",
        ))
    }
}

#[derive(Clone, Debug)]
pub(crate) struct SingleFlight {
    state: Arc<AdmissionState>,
}

#[derive(Debug)]
struct AdmissionState {
    accepting: AtomicBool,
    active: AtomicBool,
    poisoned: AtomicBool,
    idle: Notify,
}

impl SingleFlight {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(AdmissionState {
                accepting: AtomicBool::new(true),
                active: AtomicBool::new(false),
                poisoned: AtomicBool::new(false),
                idle: Notify::new(),
            }),
        }
    }

    pub(crate) fn try_acquire(&self) -> Result<ExecutionLease, AdmissionError> {
        if !self.state.accepting.load(Ordering::Acquire)
            || self.state.poisoned.load(Ordering::Acquire)
        {
            return Err(AdmissionError::Unavailable);
        }
        if self
            .state
            .active
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Err(AdmissionError::Busy);
        }
        if !self.state.accepting.load(Ordering::Acquire)
            || self.state.poisoned.load(Ordering::Acquire)
        {
            self.release();
            return Err(AdmissionError::Unavailable);
        }
        Ok(ExecutionLease {
            state: self.state.clone(),
        })
    }

    pub(crate) fn close(&self) {
        self.state.accepting.store(false, Ordering::Release);
    }

    pub(crate) fn poison(&self) {
        self.state.accepting.store(false, Ordering::Release);
        self.state.poisoned.store(true, Ordering::Release);
    }

    pub(crate) async fn close_and_drain(&self) -> Result<(), ExecutionFatal> {
        self.close();
        loop {
            let idle = self.state.idle.notified();
            if !self.state.active.load(Ordering::Acquire) {
                return if self.state.poisoned.load(Ordering::Acquire) {
                    Err(ExecutionFatal)
                } else {
                    Ok(())
                };
            }
            idle.await;
        }
    }

    fn release(&self) {
        self.state.active.store(false, Ordering::Release);
        self.state.idle.notify_waiters();
    }
}

#[derive(Debug)]
pub(crate) struct ExecutionLease {
    state: Arc<AdmissionState>,
}

impl Drop for ExecutionLease {
    fn drop(&mut self) {
        self.state.active.store(false, Ordering::Release);
        self.state.idle.notify_waiters();
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub(crate) enum AdmissionError {
    #[error("Runtime is already executing another tool call")]
    Busy,
    #[error("Runtime is not accepting new tool calls")]
    Unavailable,
}

impl AdmissionError {
    pub(crate) const fn code(self) -> ToolErrorCode {
        match self {
            Self::Busy => ToolErrorCode::RuntimeBusy,
            Self::Unavailable => ToolErrorCode::RuntimeUnavailable,
        }
    }
}

#[derive(Clone, Debug, Error)]
#[error("Executor process containment could not be proven")]
pub(crate) struct ExecutionFatal;

struct ExecutorCall {
    tool: ToolCommand,
    request: Vec<u8>,
    workspace: PathBuf,
    system_skills: PathBuf,
    cancel: CancellationToken,
    shutdown: CancellationToken,
    timeout: Duration,
    fatal: mpsc::UnboundedSender<ExecutionFatal>,
    gate: SingleFlight,
    _lease: ExecutionLease,
}

impl ExecutorCall {
    async fn run<O>(mut self, decode_reply: ReplyDecoder<O>) -> Result<O, ToolError> {
        let mut command = Command::new("/proc/self/exe");
        command
            .arg(self.tool.as_str())
            .env_clear()
            .env("HOME", &self.workspace)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("ANTNEST_RUNTIME_WORKSPACE", &self.workspace)
            .env("ANTNEST_RUNTIME_SYSTEM_SKILLS", &self.system_skills)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .process_group(0);
        let mut child = command
            .spawn()
            .map_err(|error| ToolError::new(ToolErrorCode::SpawnFailed, error))?;
        if let Some(pid) = child.id() {
            tracing::Span::current().record("executor.child.pid", u64::from(pid));
        }
        let process_group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .map(Pid::from_raw);
        let mut stdin = child.stdin.take().ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::RuntimeFailed,
                "executor stdin is unavailable",
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::RuntimeFailed,
                "executor stdout is unavailable",
            )
        })?;
        let stderr = child.stderr.take().ok_or_else(|| {
            ToolError::new(
                ToolErrorCode::RuntimeFailed,
                "executor stderr is unavailable",
            )
        })?;

        let request = std::mem::take(&mut self.request);
        let input = tokio::spawn(async move {
            stdin.write_all(&request).await?;
            stdin.shutdown().await
        });
        let output = tokio::spawn(read_bounded(stdout, MAX_EXECUTOR_MESSAGE_BYTES));
        let diagnostics = tokio::spawn(read_bounded(stderr, MAX_EXECUTOR_DIAGNOSTIC_BYTES));

        enum Exit {
            Completed(std::io::Result<std::process::ExitStatus>),
            Canceled,
            Shutdown,
            TimedOut,
        }
        let exit = tokio::select! {
            status = child.wait() => Exit::Completed(status),
            _ = self.cancel.cancelled() => Exit::Canceled,
            _ = self.shutdown.cancelled() => Exit::Shutdown,
            _ = tokio::time::sleep(self.timeout) => Exit::TimedOut,
        };

        let status = match exit {
            Exit::Completed(status) => match status {
                Ok(status) => status,
                Err(error) => {
                    tracing::Span::current().record("executor.exit.classification", "wait_error");
                    terminate_executor(&mut child, process_group).await;
                    self.finish_cleanup().await?;
                    return Err(
                        self.unobserved_error(format!("wait for executor process: {error}"))
                    );
                }
            },
            Exit::Canceled => {
                tracing::Span::current().record("executor.exit.classification", "canceled");
                terminate_executor(&mut child, process_group).await;
                self.finish_cleanup().await?;
                return Err(
                    self.interrupted_error(ToolErrorCode::Canceled, "executor request canceled")
                );
            }
            Exit::Shutdown => {
                tracing::Span::current().record("executor.exit.classification", "shutdown");
                self.gate.close();
                terminate_executor(&mut child, process_group).await;
                self.finish_cleanup().await?;
                return Err(
                    self.interrupted_error(ToolErrorCode::Canceled, "Runtime is shutting down")
                );
            }
            Exit::TimedOut => {
                tracing::Span::current().record("executor.exit.classification", "timeout");
                terminate_executor(&mut child, process_group).await;
                self.finish_cleanup().await?;
                return Err(
                    self.interrupted_error(ToolErrorCode::Timeout, "executor request timed out")
                );
            }
        };
        tracing::Span::current().record(
            "executor.exit.classification",
            if status.success() {
                "success"
            } else {
                "nonzero"
            },
        );

        let input = input
            .await
            .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?;
        self.finish_cleanup().await?;
        let (output, output_truncated) = output
            .await
            .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?
            .map_err(|error| ToolError::new(ToolErrorCode::OutputCaptureFailed, error))?;
        let (diagnostics, diagnostics_truncated) = diagnostics
            .await
            .map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?
            .map_err(|error| ToolError::new(ToolErrorCode::OutputCaptureFailed, error))?;

        input.map_err(|error| ToolError::new(ToolErrorCode::RuntimeFailed, error))?;
        if output_truncated {
            return Err(self.unobserved_error("executor response exceeded the encoded limit"));
        }
        if !status.success() {
            let reason = diagnostic_summary(&diagnostics, diagnostics_truncated);
            return Err(self.unobserved_error(reason));
        }
        match decode_reply(&output)
            .map_err(|error| self.unobserved_error(format!("decode executor response: {error}")))?
        {
            Ok(result) => Ok(result),
            Err(error) => Err(ToolError::new(error.code, error.message)),
        }
    }

    async fn finish_cleanup(&self) -> Result<(), ToolError> {
        if contain_runtime_descendants().await {
            Ok(())
        } else {
            self.gate.poison();
            let _ = self.fatal.send(ExecutionFatal);
            Err(ToolError::new(
                ToolErrorCode::ChildProcessContainmentUnproven,
                "Runtime PID 1 could not contain every Executor descendant",
            ))
        }
    }

    fn interrupted_error(&self, code: ToolErrorCode, message: &'static str) -> ToolError {
        if self.tool.may_have_side_effects() {
            ToolError::new(ToolErrorCode::OutcomeUnknown, message)
        } else {
            ToolError::new(code, message)
        }
    }

    fn unobserved_error(&self, message: impl std::fmt::Display) -> ToolError {
        let failure = if self.tool.may_have_side_effects() {
            ExecutorFailure::unknown(ToolErrorCode::OutcomeUnknown, message.to_string())
        } else {
            ExecutorFailure::known(ToolErrorCode::RuntimeFailed, message.to_string())
        };
        debug_assert_eq!(
            failure.outcome,
            if self.tool.may_have_side_effects() {
                Outcome::Unknown
            } else {
                Outcome::Known
            }
        );
        ToolError::new(failure.code, failure.message)
    }
}

fn record_executor_result(
    span: &tracing::Span,
    identity: &RuntimeIdentity,
    tool: ToolCommand,
    metrics: &RuntimeMetrics,
    result: &Result<impl Sized, ToolError>,
    duration: Duration,
) {
    let duration_ms = u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
    let (trace_id, span_id) = crate::telemetry::span_identity(span);
    span.record("executor.duration_ms", duration_ms);
    match result {
        Ok(_) => {
            metrics.executor(tool.as_str(), "success", "", duration);
            span.record("executor.outcome", "success");
            span.record("otel.status_code", "OK");
            span.in_scope(|| {
                tracing::info!(
                    "service.name" = crate::telemetry::SERVICE_NAME,
                    "antnest.agent.id" = identity.agent_id(),
                    "antnest.runtime.generation" = %identity.generation(),
                    trace_id = %trace_id,
                    span_id = %span_id,
                    outcome = "success",
                    error.type = "",
                    "Runtime Executor completed"
                );
            });
        }
        Err(error) => {
            metrics.executor(tool.as_str(), "error", error.code.as_str(), duration);
            span.record("executor.outcome", "error");
            span.record("otel.status_code", "ERROR");
            span.record("error.type", error.code.as_str());
            span.in_scope(|| {
                tracing::warn!(
                    "service.name" = crate::telemetry::SERVICE_NAME,
                    "antnest.agent.id" = identity.agent_id(),
                    "antnest.runtime.generation" = %identity.generation(),
                    trace_id = %trace_id,
                    span_id = %span_id,
                    outcome = "error",
                    error.type = %error.code,
                    "Runtime Executor completed"
                );
            });
        }
    }
}

async fn terminate_executor(child: &mut Child, process_group: Option<Pid>) {
    signal_process_group(process_group, Signal::SIGTERM);
    if tokio::time::timeout(PROCESS_STOP_TIMEOUT, child.wait())
        .await
        .is_ok_and(|result| result.is_ok())
    {
        return;
    }
    signal_process_group(process_group, Signal::SIGKILL);
    let _ = tokio::time::timeout(PROCESS_STOP_TIMEOUT, child.wait()).await;
}

fn signal_process_group(process_group: Option<Pid>, signal: Signal) {
    if let Some(process_group) = process_group {
        let _ = kill(Pid::from_raw(-process_group.as_raw()), signal);
    }
}

async fn contain_runtime_descendants() -> bool {
    if std::process::id() != 1 {
        return true;
    }
    signal_all_descendants(Signal::SIGTERM);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let deadline = tokio::time::Instant::now() + PROCESS_STOP_TIMEOUT;
    loop {
        if reap_all_descendants() {
            return true;
        }
        signal_all_descendants(Signal::SIGKILL);
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

fn signal_all_descendants(signal: Signal) {
    let _ = kill(Pid::from_raw(-1), signal);
}

fn reap_all_descendants() -> bool {
    loop {
        match waitpid(Pid::from_raw(-1), Some(WaitPidFlag::WNOHANG)) {
            Ok(WaitStatus::StillAlive) => return false,
            Ok(_) | Err(Errno::EINTR) => {}
            Err(Errno::ECHILD) => return true,
            Err(_) => return false,
        }
    }
}

async fn read_bounded<R: AsyncRead + Unpin>(
    mut reader: R,
    limit: usize,
) -> std::io::Result<(Vec<u8>, bool)> {
    let mut output = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let read = reader.read(&mut chunk).await?;
        if read == 0 {
            return Ok((output, truncated));
        }
        let remaining = limit.saturating_sub(output.len());
        let kept = read.min(remaining);
        output.extend_from_slice(&chunk[..kept]);
        truncated |= kept < read;
    }
}

fn diagnostic_summary(bytes: &[u8], truncated: bool) -> String {
    let text = String::from_utf8_lossy(bytes);
    if text.trim().is_empty() {
        "executor exited without a response".into()
    } else if truncated {
        format!("{} [truncated]", text.trim())
    } else {
        text.trim().to_owned()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tracing_subscriber::layer::{Context, Layer, SubscriberExt as _};

    use super::{record_executor_result, validate_probe_result};
    use crate::command::ToolCommand;
    use crate::execution::BashResult;
    use crate::spec::RuntimeIdentity;
    use crate::telemetry::RuntimeMetrics;
    use crate::tool_error::{ToolError, ToolErrorCode};

    #[derive(Clone)]
    struct EventCounter(Arc<AtomicUsize>);

    impl<S> Layer<S> for EventCounter
    where
        S: tracing::Subscriber,
    {
        fn on_event(&self, _event: &tracing::Event<'_>, _context: Context<'_, S>) {
            self.0.fetch_add(1, Ordering::Relaxed);
        }
    }

    #[test]
    fn executor_results_emit_one_completion_event_each() {
        let events = Arc::new(AtomicUsize::new(0));
        let subscriber = tracing_subscriber::Registry::default().with(EventCounter(events.clone()));
        let metrics = RuntimeMetrics::default();

        tracing::subscriber::with_default(subscriber, || {
            let identity = RuntimeIdentity::new("agent-test", 1).unwrap();
            let success = tracing::info_span!("executor-success");
            record_executor_result(
                &success,
                &identity,
                ToolCommand::Read,
                &metrics,
                &Ok::<(), ToolError>(()),
                std::time::Duration::from_millis(3),
            );

            let failure = tracing::info_span!("executor-failure");
            record_executor_result(
                &failure,
                &identity,
                ToolCommand::Write,
                &metrics,
                &Err::<(), ToolError>(ToolError::new(ToolErrorCode::RuntimeFailed, "failed")),
                std::time::Duration::from_millis(5),
            );
        });

        assert_eq!(events.load(Ordering::Relaxed), 2);
    }

    #[test]
    fn readiness_rejects_executor_root_permission_failures() {
        let result = BashResult {
            exit_code: 1,
            stdout: String::new(),
            stderr: String::new(),
            truncated: false,
        };
        assert_eq!(
            validate_probe_result(result)
                .expect_err("failed access probe must reject readiness")
                .code,
            ToolErrorCode::RuntimeFailed
        );
    }
}
