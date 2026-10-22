use std::future::Future;
use std::os::unix::process::ExitStatusExt as _;
use std::path::PathBuf;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nix::sys::signal::{Signal, kill};
use nix::unistd::Pid;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{Notify, mpsc};
use tokio::task::{AbortHandle, JoinError, JoinHandle};
use tokio_util::sync::CancellationToken;
use tracing::Instrument as _;
use tracing_opentelemetry::OpenTelemetrySpanExt as _;

use crate::command::ToolCommand;
use crate::execution::{
    BashRequest, BashResult, EditRequest, EditResult, EnvironmentVariable, ReadRequest, ReadResult,
    RootName, RootPath, WriteRequest, WriteResult,
};
use crate::executor_protocol::{
    ExecutorFailure, MAX_EXECUTOR_DIAGNOSTIC_BYTES, MAX_EXECUTOR_MESSAGE_BYTES, Outcome,
    decode_bash_reply, decode_edit_reply, decode_info_reply, decode_read_reply,
    decode_skill_digest_reply, decode_skill_install_cleaned_reply, decode_skill_install_reply,
    decode_temporary_install_reply, decode_temporary_released_reply, decode_write_reply,
    encode_bash_request, encode_edit_request, encode_read_request, encode_skill_digest_request,
    encode_skill_install_request, encode_temporary_install_request,
    encode_temporary_release_request, encode_write_request,
};
use crate::information::RuntimeContext;
use crate::progress::ProgressSink;
use crate::skill_install::{
    SkillDigestObserved, SkillDigestRequest, SkillInstallRequest, SkillInstalled,
};
use crate::skill_temporary::{
    TemporaryInstallRequest, TemporaryInstalled, TemporaryReleaseRequest, TemporaryReleased,
};
use crate::skill_temporary_state::{TemporaryAdmissionError, TemporaryScopes};
use crate::spec::RuntimeIdentity;
use crate::telemetry::RuntimeMetrics;
use crate::tool_error::{ToolError, ToolErrorCode};

const FILE_TOOL_TIMEOUT: Duration = Duration::from_secs(30);
// Bash may finish while background jobs retain its output pipes. Allow the
// bounded two-second output drain before the Supervisor's outer deadline.
const EXECUTOR_GRACE: Duration = Duration::from_secs(3);
const PROCESS_STOP_TIMEOUT: Duration = Duration::from_secs(2);
/// How long foreground admission waits for a preempted learning call.
pub(crate) const FOREGROUND_PREEMPTION_BOUND: Duration = Duration::from_secs(2);
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
    children: crate::processes::ChildRegistry,
    temporary: TemporaryScopes,
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
                children: crate::processes::ChildRegistry::default(),
                temporary: TemporaryScopes::default(),
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
        self.bash_with_progress(request, cancel, ProgressSink::default())
            .await
    }

    pub(crate) async fn bash_with_progress(
        &self,
        request: BashRequest,
        cancel: CancellationToken,
        progress: ProgressSink,
    ) -> Result<BashResult, ToolError> {
        let timeout = request.timeout().saturating_add(EXECUTOR_GRACE);
        let encoded = encode_bash_request(request).map_err(executor_request_error)?;
        self.execute(
            ToolCommand::Bash,
            encoded,
            decode_bash_reply,
            cancel,
            timeout,
            progress,
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
            ProgressSink::default(),
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
            ProgressSink::default(),
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
            ProgressSink::default(),
        )
        .await
    }

    pub(crate) async fn info(
        &self,
        cancel: CancellationToken,
    ) -> Result<RuntimeContext, ToolError> {
        self.execute(
            ToolCommand::Info,
            b"{}".to_vec(),
            decode_info_reply,
            cancel,
            FILE_TOOL_TIMEOUT,
            ProgressSink::default(),
        )
        .await
    }

    pub(crate) async fn install_skill(
        &self,
        request: SkillInstallRequest,
    ) -> Result<SkillInstalled, MaintenanceCallError> {
        let encoded = encode_skill_install_request(&request)
            .map_err(|error| MaintenanceCallError::Tool(executor_request_error(error)))?;
        self.execute_preemptible(
            ToolCommand::SkillInstall,
            encoded,
            decode_skill_install_reply,
            Duration::from_secs(60),
        )
        .await
    }

    pub(crate) async fn skill_digest(
        &self,
        request: SkillDigestRequest,
    ) -> Result<SkillDigestObserved, MaintenanceCallError> {
        let encoded = encode_skill_digest_request(&request)
            .map_err(|error| MaintenanceCallError::Tool(executor_request_error(error)))?;
        self.execute_preemptible(
            ToolCommand::SkillDigest,
            encoded,
            decode_skill_digest_reply,
            FILE_TOOL_TIMEOUT,
        )
        .await
    }

    pub(crate) async fn clean_install_staging_before_ready(&self) -> Result<(), ToolError> {
        self.execute(
            ToolCommand::SkillInstallClean,
            b"{}".to_vec(),
            decode_skill_install_cleaned_reply,
            CancellationToken::new(),
            Duration::from_secs(30),
            ProgressSink::default(),
        )
        .await
        .map(|_| ())
    }

    /// Learning holds the slot only while nothing else wants it: it never
    /// waits for a busy slot, and foreground admission or drain cancels it.
    async fn execute_preemptible<O>(
        &self,
        tool: ToolCommand,
        request: Vec<u8>,
        decode_reply: ReplyDecoder<O>,
        timeout: Duration,
    ) -> Result<O, MaintenanceCallError>
    where
        O: Send + 'static,
    {
        if self.shutdown.is_cancelled() {
            self.gate.close();
        }
        let preempt = CancellationToken::new();
        let lease = match self.gate.try_acquire_preemptible(preempt.clone()) {
            Ok(lease) => lease,
            Err(AdmissionError::Busy) => return Err(MaintenanceCallError::ForegroundRunning),
            Err(error) => {
                return Err(MaintenanceCallError::Tool(ToolError::new(
                    error.code(),
                    error,
                )));
            }
        };
        let result = self
            .execute_admitted(
                tool,
                request,
                decode_reply,
                preempt.clone(),
                timeout,
                ProgressSink::default(),
                lease,
            )
            .await;
        match result {
            Ok(value) => Ok(value),
            Err(_) if preempt.is_cancelled() || self.shutdown.is_cancelled() => {
                Err(MaintenanceCallError::Preempted)
            }
            Err(error) => Err(MaintenanceCallError::Tool(error)),
        }
    }

    pub(crate) fn children(&self) -> crate::processes::ChildRegistry {
        self.children.clone()
    }

    pub(crate) async fn install_temporary_skill(
        &self,
        request: TemporaryInstallRequest,
    ) -> Result<TemporaryInstalled, ToolError> {
        let encoded = encode_temporary_install_request(&request).map_err(executor_request_error)?;
        let lease = self.admit().await?;
        self.temporary
            .begin(
                &request.job_id,
                &request.request_id,
                &request.content_digest,
                &request.artifact_digest,
                std::time::Instant::now(),
            )
            .map_err(|error| {
                ToolError::new(
                    match error {
                        TemporaryAdmissionError::RunClosed => ToolErrorCode::TemporaryRunClosed,
                        TemporaryAdmissionError::ScopeBusy => ToolErrorCode::TemporaryScopeBusy,
                        TemporaryAdmissionError::RequestConflict => ToolErrorCode::InvalidParams,
                        TemporaryAdmissionError::LimitExceeded => ToolErrorCode::SkillStorageFull,
                    },
                    "Temporary Skill scope was not admitted",
                )
            })?;
        self.execute_admitted(
            ToolCommand::SkillTemporaryInstall,
            encoded,
            decode_temporary_install_reply,
            CancellationToken::new(),
            Duration::from_secs(60),
            ProgressSink::default(),
            lease,
        )
        .await
    }

    pub(crate) async fn release_temporary_skill(
        &self,
        request: TemporaryReleaseRequest,
    ) -> Result<TemporaryReleased, ToolError> {
        let encoded = encode_temporary_release_request(&request).map_err(executor_request_error)?;
        let lease = self.admit().await?;
        self.temporary
            .close(&request.job_id, std::time::Instant::now());
        let run = request.job_id;
        let result = self
            .execute_admitted(
                ToolCommand::SkillTemporaryRelease,
                encoded,
                decode_temporary_released_reply,
                CancellationToken::new(),
                Duration::from_secs(30),
                ProgressSink::default(),
                lease,
            )
            .await;
        if result.is_ok() {
            self.temporary.released(&run);
        }
        result
    }

    pub(crate) async fn clean_temporary_before_ready(
        &self,
    ) -> Result<TemporaryReleased, ToolError> {
        self.execute(
            ToolCommand::SkillTemporaryClean,
            b"{}".to_vec(),
            decode_temporary_released_reply,
            CancellationToken::new(),
            Duration::from_secs(30),
            ProgressSink::default(),
        )
        .await
    }

    pub(crate) async fn clean_temporary_after_drain(&self) -> Result<TemporaryReleased, ToolError> {
        if self.gate.state.active.load(Ordering::Acquire)
            || self.gate.state.poisoned.load(Ordering::Acquire)
            || self.gate.state.accepting.load(Ordering::Acquire)
        {
            return Err(ToolError::outcome_unknown(
                "Temporary cleanup requires closed and proven idle execution",
            ));
        }
        // Public admission stays permanently closed. Only this bounded private
        // cleanup actor ignores the already-requested service shutdown.
        let cleanup = Self {
            gate: SingleFlight::new(),
            shutdown: CancellationToken::new(),
            ..self.clone()
        };
        cleanup
            .execute(
                ToolCommand::SkillTemporaryClean,
                b"{}".to_vec(),
                decode_temporary_released_reply,
                CancellationToken::new(),
                Duration::from_secs(5),
                ProgressSink::default(),
            )
            .await
    }

    pub(crate) async fn admit(&self) -> Result<ExecutionLease, ToolError> {
        if self.shutdown.is_cancelled() {
            self.gate.close();
        }
        self.gate
            .acquire_preempting(FOREGROUND_PREEMPTION_BOUND)
            .await
            .map_err(|error| ToolError::new(error.code(), error))
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
        progress: ProgressSink,
    ) -> Result<O, ToolError>
    where
        O: Send + 'static,
    {
        let lease = self.admit().await?;
        self.execute_admitted(
            tool,
            request,
            decode_reply,
            cancel,
            timeout,
            progress,
            lease,
        )
        .await
    }

    #[expect(
        clippy::too_many_arguments,
        reason = "private scope admission and executor ownership must share the same lease"
    )]
    async fn execute_admitted<O>(
        &self,
        tool: ToolCommand,
        request: Vec<u8>,
        decode_reply: ReplyDecoder<O>,
        cancel: CancellationToken,
        timeout: Duration,
        progress: ProgressSink,
        lease: ExecutionLease,
    ) -> Result<O, ToolError>
    where
        O: Send + 'static,
    {
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
        if tool == ToolCommand::SkillInstall {
            #[cfg(target_os = "linux")]
            {
                if std::process::id() != 1 {
                    return Err(ToolError::new(
                        ToolErrorCode::SkillWritersUnknown,
                        "Skill activation requires Runtime PID 1 for background task ownership",
                    ));
                }
                let background = self
                    .children
                    .live_background_groups()
                    .map_err(|error| ToolError::new(ToolErrorCode::SkillWritersUnknown, error))?;
                if let Some(group) = background.first() {
                    return Err(ToolError::new(
                        ToolErrorCode::SkillBackgroundTaskRunning,
                        "Bash background task is still running",
                    )
                    .with_blocked_subject(format!("bash:{group}")));
                }
                let managed = self
                    .children
                    .live_managed_work()
                    .map_err(|error| ToolError::new(ToolErrorCode::SkillWritersUnknown, error))?;
                if let Some(server_id) = managed.first() {
                    return Err(ToolError::new(
                        ToolErrorCode::SkillManagedCallInFlight,
                        "managed MCP child is still running",
                    )
                    .with_blocked_subject(format!("managed:{server_id}")));
                }
                let unknown = self
                    .children
                    .unknown_live_children()
                    .map_err(|error| ToolError::new(ToolErrorCode::SkillWritersUnknown, error))?;
                if !unknown.is_empty() {
                    return Err(ToolError::new(
                        ToolErrorCode::SkillWritersUnknown,
                        format!("background task or unknown writer is active: {unknown:?}"),
                    )
                    .with_blocked_subject(format!("unknown:{}", unknown[0])));
                }
            }
        }
        let call = ExecutorCall {
            progress,
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
            children: self.children.clone(),
            contain_bash_descendants: tool == ToolCommand::Bash && self.temporary.active(),
        };
        let span = tracing::info_span!(
            "runtime.executor",
            "service.name" = crate::telemetry::SERVICE_NAME,
            "antnest.agent.id" = self.identity.agent_id(),
            "antnest.runtime.generation" = %self.identity.generation(),
            "executor.tool.name" = tool.as_str(),
            "executor.program.path" = "/proc/self/exe",
            "antnest.execution.timeout_ms" = u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX),
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
        let started = tokio::time::Instant::now();
        let task = tokio::spawn(call.run(decode_reply).instrument(span.clone()));
        let result = self.join_executor(task).await;
        record_executor_result(&span, &identity, tool, &metrics, &result, started.elapsed());
        result
    }

    async fn join_executor<O>(
        &self,
        task: JoinHandle<Result<O, ToolError>>,
    ) -> Result<O, ToolError> {
        match task.await {
            Ok(result) => result,
            Err(error) => {
                self.gate.poison();
                let _ = self.fatal.send(ExecutionFatal);
                Err(ToolError::new(
                    ToolErrorCode::ChildProcessContainmentUnproven,
                    format!("Executor coordination task failed: {error}"),
                )
                .with_source(error))
            }
        }
    }
}

fn executor_request_error(error: serde_json::Error) -> ToolError {
    ToolError::new(ToolErrorCode::RuntimeFailed, &error).with_source(error)
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
    // Set, under this lock, together with `active` by a preemptible holder.
    preemptible: Mutex<Option<CancellationToken>>,
}

impl SingleFlight {
    pub(crate) fn new() -> Self {
        Self {
            state: Arc::new(AdmissionState {
                accepting: AtomicBool::new(true),
                active: AtomicBool::new(false),
                poisoned: AtomicBool::new(false),
                idle: Notify::new(),
                preemptible: Mutex::new(None),
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

    pub(crate) fn try_acquire_preemptible(
        &self,
        preempt: CancellationToken,
    ) -> Result<ExecutionLease, AdmissionError> {
        let mut holder = self.state.preemptible.lock().expect("admission holder");
        let lease = self.try_acquire()?;
        *holder = Some(preempt);
        Ok(lease)
    }

    /// Foreground admission: a preemptible holder is cancelled and the slot
    /// is taken once it is released, within `bound`. Any other holder still
    /// makes the call fail at once with `Busy`.
    pub(crate) async fn acquire_preempting(
        &self,
        bound: Duration,
    ) -> Result<ExecutionLease, AdmissionError> {
        let deadline = tokio::time::Instant::now() + bound;
        loop {
            let idle = self.state.idle.notified();
            tokio::pin!(idle);
            idle.as_mut().enable();
            match self.try_acquire() {
                Err(AdmissionError::Busy) => {}
                admitted => return admitted,
            }
            {
                let holder = self.state.preemptible.lock().expect("admission holder");
                match self.try_acquire() {
                    Err(AdmissionError::Busy) => {}
                    admitted => return admitted,
                }
                match holder.as_ref() {
                    Some(preempt) => preempt.cancel(),
                    None => return Err(AdmissionError::Busy),
                }
            }
            if tokio::time::timeout_at(deadline, idle).await.is_err() {
                return self.try_acquire();
            }
        }
    }

    pub(crate) fn close(&self) {
        self.state.accepting.store(false, Ordering::Release);
    }

    fn preempt_holder(&self) {
        if let Some(preempt) = self
            .state
            .preemptible
            .lock()
            .expect("admission holder")
            .as_ref()
        {
            preempt.cancel();
        }
    }

    pub(crate) fn poison(&self) {
        self.state.accepting.store(false, Ordering::Release);
        self.state.poisoned.store(true, Ordering::Release);
    }

    pub(crate) async fn close_and_drain(&self) -> Result<(), ExecutionFatal> {
        self.close();
        self.preempt_holder();
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
        let mut holder = self
            .state
            .preemptible
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *holder = None;
        self.state.active.store(false, Ordering::Release);
        drop(holder);
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

#[derive(Debug)]
pub(crate) enum MaintenanceCallError {
    /// The slot was taken; learning never waits for it.
    ForegroundRunning,
    /// Foreground admission, drain or shutdown took the slot mid-call.
    Preempted,
    Tool(ToolError),
}

struct ExecutorCall {
    progress: ProgressSink,
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
    children: crate::processes::ChildRegistry,
    contain_bash_descendants: bool,
}

impl ExecutorCall {
    async fn run<O>(mut self, decode_reply: ReplyDecoder<O>) -> Result<O, ToolError> {
        if self.cancel.is_cancelled() || self.shutdown.is_cancelled() {
            return Err(ToolError::new(
                ToolErrorCode::Canceled,
                "executor canceled before dispatch",
            ));
        }
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
        let spawned = if self.tool == ToolCommand::Bash {
            self.children.spawn_bash(&mut command)
        } else {
            self.children.spawn(&mut command)
        };
        let mut owned = spawned.map_err(|error| {
            ToolError::new(ToolErrorCode::SpawnFailed, &error).with_source(error)
        })?;
        let child = &mut owned.child;
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
        let output = tokio::spawn(crate::executor_protocol::read_executor_output(
            stdout,
            self.progress.clone(),
        ));
        let diagnostics = tokio::spawn(read_bounded(stderr, MAX_EXECUTOR_DIAGNOSTIC_BYTES));
        let mut io = ExecutorIo::new(input, output, diagnostics);

        // Keep all Result exits inside this scope so the invocation lease is
        // not released until the owned I/O has completed its bounded cleanup.
        let result = async {
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
                        tracing::Span::current()
                            .record("executor.exit.classification", "wait_error");
                        let primary = self
                            .unobserved_error(format!("wait for executor process: {error}"))
                            .with_source(error);
                        return self
                            .stop_after_error(child, process_group, &mut io, primary)
                            .await;
                    }
                },
                Exit::Canceled => {
                    tracing::Span::current().record("executor.exit.classification", "canceled");
                    let primary = self
                        .interrupted_error(ToolErrorCode::Canceled, "executor request canceled");
                    return self
                        .stop_after_error(child, process_group, &mut io, primary)
                        .await;
                }
                Exit::Shutdown => {
                    tracing::Span::current().record("executor.exit.classification", "shutdown");
                    self.gate.close();
                    let primary =
                        self.interrupted_error(ToolErrorCode::Canceled, "Runtime is shutting down");
                    return self
                        .stop_after_error(child, process_group, &mut io, primary)
                        .await;
                }
                Exit::TimedOut => {
                    tracing::Span::current().record("executor.exit.classification", "timeout");
                    let primary = self
                        .interrupted_error(ToolErrorCode::Timeout, "executor request timed out");
                    return self
                        .stop_after_error(child, process_group, &mut io, primary)
                        .await;
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
            if let Some(code) = status.code() {
                tracing::Span::current().set_attribute("process.exit.code", i64::from(code));
            }
            if let Some(signal) = status.signal() {
                tracing::Span::current().set_attribute("executor.exit.signal", i64::from(signal));
            }

            let had_background = if self.contain_bash_descendants {
                let group = process_group.ok_or_else(|| {
                    self.temporary_containment_failure("Bash process group is unavailable")
                })?;
                let live = match temporary_background_live(&self.children, group) {
                    Ok(live) => live,
                    Err(error) => {
                        // Observation failure cannot prove absence. Attempt to stop
                        // this invocation before closing admission.
                        let _ = stop_temporary_background(&self.children, group).await;
                        return Err(self.temporary_containment_failure(error));
                    }
                };
                if live && let Err(error) = stop_temporary_background(&self.children, group).await {
                    return Err(self.temporary_containment_failure(error));
                }
                live
            } else {
                false
            };
            let (output, output_truncated, diagnostics, diagnostics_truncated) =
                tokio::time::timeout(PROCESS_STOP_TIMEOUT, io.finish())
                    .await
                    .map_err(|error| {
                        self.unobserved_error("executor response drain timed out")
                            .with_source(error)
                    })?
                    .map_err(|error| self.io_failure(error))?;
            if output_truncated {
                return Err(self.unobserved_error("executor response exceeded the encoded limit"));
            }
            if !status.success() {
                let reason = diagnostic_summary(&diagnostics, diagnostics_truncated);
                return Err(self.unobserved_error(reason));
            }
            match decode_reply(&output).map_err(|error| {
                self.unobserved_error(format!("decode executor response: {error}"))
                    .with_source(error)
            })? {
                Ok(_) if had_background => Err(ToolError::settled(
                    ToolErrorCode::TemporaryBackgroundNotSupported,
                    "Background work was stopped because this Run uses temporary Skill files",
                )),
                Ok(result) => Ok(result),
                Err(error) => {
                    if matches!(
                        error.code,
                        ToolErrorCode::Timeout
                            | ToolErrorCode::Canceled
                            | ToolErrorCode::WaitFailed
                    ) {
                        // The non-root shell already reported interruption. Retire
                        // only this invocation's group, never prior background jobs.
                        return self
                            .stop_after_error(
                                child,
                                process_group,
                                &mut io,
                                error.into_tool_error(),
                            )
                            .await;
                    }
                    Err(error.into_tool_error())
                }
            }
        }
        .await;
        // A preceding stop attempt retains its absolute deadline, including
        // failures; this final exit must not grant another stop budget.
        let cleanup = io.abort_and_join().await;
        self.with_io_cleanup(result, cleanup)
    }

    fn temporary_containment_failure(&self, error: impl std::fmt::Display) -> ToolError {
        self.gate.poison();
        let _ = self.fatal.send(ExecutionFatal);
        ToolError::unknown(ToolErrorCode::ChildProcessContainmentUnproven, error)
    }

    async fn stop_after_error<O>(
        &self,
        child: &mut Child,
        group: Option<Pid>,
        io: &mut ExecutorIo,
        primary: ToolError,
    ) -> Result<O, ToolError> {
        let cleanup = self.stop_executor(child, group, io).await;
        self.with_executor_cleanup(Err(primary), cleanup)
    }

    async fn stop_executor(
        &self,
        child: &mut Child,
        group: Option<Pid>,
        io: &mut ExecutorIo,
    ) -> Result<(), ToolError> {
        let deadline = io.cleanup_deadline();
        let (stopped, joined) = tokio::join!(
            terminate_executor(child, group, deadline),
            io.abort_and_join(),
        );
        let stopped = stopped.map_err(|error| {
            self.temporary_containment_failure(&error)
                .with_source(error)
        });
        self.with_io_cleanup(stopped, joined)
    }

    fn io_failure(&self, error: ExecutorIoFailure) -> ToolError {
        let failure = if error.containment_unproven() {
            self.temporary_containment_failure(&error)
        } else {
            self.unobserved_error(&error)
        };
        failure.with_source(error)
    }

    fn with_io_cleanup<O>(
        &self,
        result: Result<O, ToolError>,
        cleanup: Result<(), ExecutorIoFailure>,
    ) -> Result<O, ToolError> {
        self.with_executor_cleanup(result, cleanup.map_err(|error| self.io_failure(error)))
    }

    fn with_executor_cleanup<O>(
        &self,
        result: Result<O, ToolError>,
        cleanup: Result<(), ToolError>,
    ) -> Result<O, ToolError> {
        let cleanup = match cleanup {
            Ok(()) => return result,
            Err(error) => error,
        };
        match result {
            Ok(_) => Err(cleanup),
            Err(primary) => {
                let unproven = cleanup.code == ToolErrorCode::ChildProcessContainmentUnproven;
                let mut combined = ToolError::new(
                    if unproven { cleanup.code } else { primary.code },
                    format!("{primary}; executor cleanup failed: {cleanup}"),
                );
                combined.effect_state = if unproven {
                    cleanup.effect_state
                } else {
                    primary.effect_state
                };
                combined.blocked_subject_id = primary.blocked_subject_id.clone();
                Err(combined.with_source(ExecutorCleanupFailure { primary, cleanup }))
            }
        }
    }

    fn interrupted_error(&self, code: ToolErrorCode, message: &'static str) -> ToolError {
        if self.tool.may_have_side_effects() {
            ToolError::outcome_unknown(message).with_source(ToolError::new(code, message))
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
        failure.into_tool_error()
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
            crate::diagnostics::record_tool_error(span, "executor", error);

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

async fn terminate_executor(
    child: &mut Child,
    process_group: Option<Pid>,
    deadline: tokio::time::Instant,
) -> std::io::Result<()> {
    let group =
        process_group.ok_or_else(|| std::io::Error::other("executor process group unavailable"))?;
    match kill(Pid::from_raw(-group.as_raw()), Signal::SIGKILL) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
        Err(error) => return Err(std::io::Error::from_raw_os_error(error as i32)),
    }
    tokio::time::timeout_at(deadline, child.wait())
        .await
        .map_err(|_| std::io::Error::other("executor did not exit after cancellation"))??;
    Ok(())
}

#[cfg(target_os = "linux")]
fn temporary_background_live(
    children: &crate::processes::ChildRegistry,
    group: Pid,
) -> std::io::Result<bool> {
    Ok(children
        .live_background_groups()?
        .contains(&(group.as_raw() as u32)))
}
#[cfg(not(target_os = "linux"))]
fn temporary_background_live(
    _children: &crate::processes::ChildRegistry,
    _group: Pid,
) -> std::io::Result<bool> {
    Err(std::io::Error::other(
        "temporary Bash containment requires Linux",
    ))
}

#[cfg(target_os = "linux")]
async fn stop_temporary_background(
    children: &crate::processes::ChildRegistry,
    group: Pid,
) -> std::io::Result<()> {
    for signal in [Signal::SIGTERM, Signal::SIGKILL] {
        match kill(Pid::from_raw(-group.as_raw()), signal) {
            Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
            Err(error) => return Err(std::io::Error::from_raw_os_error(error as i32)),
        }
        let deadline = tokio::time::Instant::now() + PROCESS_STOP_TIMEOUT;
        loop {
            if !children
                .live_background_groups()?
                .contains(&(group.as_raw() as u32))
            {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
    Err(std::io::Error::other(
        "temporary Bash background process did not stop",
    ))
}

#[cfg(not(target_os = "linux"))]
async fn stop_temporary_background(
    _children: &crate::processes::ChildRegistry,
    _group: Pid,
) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "temporary Bash containment requires Linux",
    ))
}

type OutputReader = JoinHandle<std::io::Result<(Vec<u8>, bool)>>;
type IoTaskResult<T> = Result<std::io::Result<T>, JoinError>;
type IoResults = (
    IoTaskResult<()>,
    IoTaskResult<(Vec<u8>, bool)>,
    IoTaskResult<(Vec<u8>, bool)>,
);
type IoJoin = Pin<Box<dyn Future<Output = IoResults> + Send>>;

#[derive(Debug, Error)]
#[error("{primary}; executor cleanup failed: {cleanup}")]
struct ExecutorCleanupFailure {
    #[source]
    primary: ToolError,
    cleanup: ToolError,
}

#[derive(Debug, Error)]
enum ExecutorIoIssue {
    #[error("executor {stream} I/O failed: {source}")]
    Io {
        stream: &'static str,
        #[source]
        source: std::io::Error,
    },
    #[error("executor {stream} task failed: {source}")]
    Join {
        stream: &'static str,
        #[source]
        source: JoinError,
    },
    #[error("executor I/O cleanup exceeded the stop budget")]
    TimedOut(#[source] tokio::time::error::Elapsed),
    #[error("executor I/O response was already consumed")]
    AlreadyConsumed,
}

#[derive(Debug)]
struct ExecutorIoFailure {
    issues: Vec<ExecutorIoIssue>,
}

impl ExecutorIoFailure {
    fn containment_unproven(&self) -> bool {
        self.issues.iter().any(|issue| match issue {
            ExecutorIoIssue::TimedOut(_) => true,
            ExecutorIoIssue::Join { source, .. } => source.is_panic(),
            ExecutorIoIssue::Io { .. } | ExecutorIoIssue::AlreadyConsumed => false,
        })
    }
}

impl std::fmt::Display for ExecutorIoFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        for (index, issue) in self.issues.iter().enumerate() {
            if index != 0 {
                formatter.write_str("; ")?;
            }
            write!(formatter, "{issue}")?;
        }
        Ok(())
    }
}

impl std::error::Error for ExecutorIoFailure {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        self.issues
            .first()
            .map(|issue| issue as &(dyn std::error::Error + 'static))
    }
}

struct ExecutorIo {
    joining: Option<IoJoin>,
    aborts: [AbortHandle; 3],
    cleanup_deadline: Option<tokio::time::Instant>,
}

impl ExecutorIo {
    fn new(
        input: JoinHandle<std::io::Result<()>>,
        output: OutputReader,
        diagnostics: OutputReader,
    ) -> Self {
        let aborts = [
            input.abort_handle(),
            output.abort_handle(),
            diagnostics.abort_handle(),
        ];
        Self {
            // The join's partial results belong to the owner, not to a
            // finish() borrow that a timeout is allowed to discard.
            joining: Some(Box::pin(
                async move { tokio::join!(input, output, diagnostics) },
            )),
            aborts,
            cleanup_deadline: None,
        }
    }

    async fn join(&mut self) -> Option<IoResults> {
        let results = self.joining.as_mut()?.await;
        // None also records that all three handles have already been joined.
        self.joining = None;
        Some(results)
    }

    async fn finish(&mut self) -> Result<(Vec<u8>, bool, Vec<u8>, bool), ExecutorIoFailure> {
        let (input, output, diagnostics) = self.join().await.ok_or_else(|| ExecutorIoFailure {
            issues: vec![ExecutorIoIssue::AlreadyConsumed],
        })?;
        let mut issues = Vec::new();
        let input = collect_io_result("stdin", input, false, &mut issues);
        let output = collect_io_result("stdout", output, false, &mut issues);
        let diagnostics = collect_io_result("stderr", diagnostics, false, &mut issues);
        if !issues.is_empty() {
            return Err(ExecutorIoFailure { issues });
        }
        input.expect("joined stdin has no unreported failure");
        let (output, truncated) = output.expect("joined stdout has no unreported failure");
        let (diagnostics, diagnostics_truncated) =
            diagnostics.expect("joined stderr has no unreported failure");
        Ok((output, truncated, diagnostics, diagnostics_truncated))
    }

    fn cleanup_deadline(&mut self) -> tokio::time::Instant {
        *self
            .cleanup_deadline
            .get_or_insert_with(|| tokio::time::Instant::now() + PROCESS_STOP_TIMEOUT)
    }

    async fn abort_and_join(&mut self) -> Result<(), ExecutorIoFailure> {
        self.abort();
        if self.joining.is_none() {
            return Ok(());
        }
        let deadline = self.cleanup_deadline();
        let joined = tokio::time::timeout_at(deadline, self.join())
            .await
            .map_err(|error| ExecutorIoFailure {
                issues: vec![ExecutorIoIssue::TimedOut(error)],
            })?;
        let Some((input, output, diagnostics)) = joined else {
            return Ok(());
        };
        let mut issues = Vec::new();
        let _ = collect_io_result("stdin", input, true, &mut issues);
        let _ = collect_io_result("stdout", output, true, &mut issues);
        let _ = collect_io_result("stderr", diagnostics, true, &mut issues);
        if issues.is_empty() {
            Ok(())
        } else {
            Err(ExecutorIoFailure { issues })
        }
    }

    fn abort(&self) {
        for abort in &self.aborts {
            abort.abort();
        }
    }
}

impl Drop for ExecutorIo {
    fn drop(&mut self) {
        // Synchronous backstop only; normal exits await abort_and_join first.
        self.abort();
    }
}

fn collect_io_result<T>(
    stream: &'static str,
    result: IoTaskResult<T>,
    allow_cancelled: bool,
    issues: &mut Vec<ExecutorIoIssue>,
) -> Option<T> {
    match result {
        Ok(Ok(value)) => Some(value),
        Ok(Err(source)) => {
            issues.push(ExecutorIoIssue::Io { stream, source });
            None
        }
        Err(source) if allow_cancelled && source.is_cancelled() => None,
        Err(source) => {
            issues.push(ExecutorIoIssue::Join { stream, source });
            None
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
    use std::panic::AssertUnwindSafe;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use futures_util::FutureExt as _;
    use tokio_util::sync::CancellationToken;
    use tracing_subscriber::layer::{Context, Layer, SubscriberExt as _};

    use super::{
        AdmissionError, ExecutionActor, FOREGROUND_PREEMPTION_BOUND, SingleFlight,
        record_executor_result, validate_probe_result,
    };
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

        crate::test_tracing::stabilize_callsite_registry();
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

    #[tokio::test]
    async fn executor_coordination_panic_poison_admission_and_notifies_supervisor() {
        let identity = RuntimeIdentity::new("agent-test", 1).unwrap();
        let (actor, mut failures) = ExecutionActor::new(
            identity,
            PathBuf::from("/workspace"),
            PathBuf::from("/skills"),
            RuntimeMetrics::default(),
            CancellationToken::new(),
        );
        let task = tokio::spawn(async {
            panic!("injected executor coordination panic");
            #[allow(unreachable_code)]
            Ok::<(), ToolError>(())
        });

        let error = actor
            .join_executor(task)
            .await
            .expect_err("coordination panic must fail closed");

        assert_eq!(error.code, ToolErrorCode::ChildProcessContainmentUnproven);
        assert!(matches!(
            actor.gate.try_acquire(),
            Err(AdmissionError::Unavailable)
        ));
        failures
            .recv()
            .await
            .expect("Supervisor must receive an execution fatal event");
    }

    #[tokio::test]
    async fn foreground_admission_preempts_maintenance_and_takes_the_slot() {
        let gate = SingleFlight::new();
        let preempt = CancellationToken::new();
        let maintenance = gate
            .try_acquire_preemptible(preempt.clone())
            .expect("idle slot admits maintenance");
        let observed = preempt.clone();
        let holder = tokio::spawn(async move {
            observed.cancelled().await;
            // Executor termination takes a moment before the lease drops.
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            drop(maintenance);
        });
        let started = std::time::Instant::now();
        let foreground = gate
            .acquire_preempting(FOREGROUND_PREEMPTION_BOUND)
            .await
            .expect("foreground takes the slot from maintenance");
        assert!(preempt.is_cancelled());
        assert!(started.elapsed() < FOREGROUND_PREEMPTION_BOUND);
        holder.await.unwrap();
        assert!(matches!(
            gate.try_acquire_preemptible(CancellationToken::new()),
            Err(AdmissionError::Busy)
        ));
        drop(foreground);
    }

    #[tokio::test]
    async fn foreground_contention_with_foreground_stays_immediately_busy() {
        let gate = SingleFlight::new();
        let first = gate.try_acquire().expect("first foreground call");
        let started = std::time::Instant::now();
        assert!(matches!(
            gate.acquire_preempting(FOREGROUND_PREEMPTION_BOUND).await,
            Err(AdmissionError::Busy)
        ));
        assert!(started.elapsed() < std::time::Duration::from_millis(200));
        drop(first);
    }

    #[tokio::test]
    async fn maintenance_that_does_not_yield_in_time_leaves_foreground_busy() {
        let gate = SingleFlight::new();
        let preempt = CancellationToken::new();
        let maintenance = gate
            .try_acquire_preemptible(preempt.clone())
            .expect("idle slot admits maintenance");
        let bound = std::time::Duration::from_millis(300);
        let started = std::time::Instant::now();
        assert!(matches!(
            gate.acquire_preempting(bound).await,
            Err(AdmissionError::Busy)
        ));
        assert!(preempt.is_cancelled());
        assert!(started.elapsed() >= bound);
        drop(maintenance);
        gate.acquire_preempting(bound)
            .await
            .expect("slot is free after maintenance yields");
    }

    #[tokio::test]
    async fn maintenance_never_waits_for_a_busy_slot() {
        let gate = SingleFlight::new();
        let foreground = gate.try_acquire().expect("foreground call");
        let preempt = CancellationToken::new();
        assert!(matches!(
            gate.try_acquire_preemptible(preempt.clone()),
            Err(AdmissionError::Busy)
        ));
        assert!(!preempt.is_cancelled());
        drop(foreground);
    }

    #[tokio::test]
    async fn drain_preempts_maintenance() {
        let gate = SingleFlight::new();
        let preempt = CancellationToken::new();
        let maintenance = gate
            .try_acquire_preemptible(preempt.clone())
            .expect("idle slot admits maintenance");
        let observed = preempt.clone();
        let holder = tokio::spawn(async move {
            observed.cancelled().await;
            drop(maintenance);
        });
        tokio::time::timeout(FOREGROUND_PREEMPTION_BOUND, gate.close_and_drain())
            .await
            .expect("drain must not wait for learning")
            .expect("drain settles");
        holder.await.unwrap();
    }

    struct IoSettlementReceipt {
        settled: Arc<AtomicUsize>,
        bit: usize,
    }

    impl Drop for IoSettlementReceipt {
        fn drop(&mut self) {
            self.settled.fetch_or(self.bit, Ordering::SeqCst);
        }
    }

    fn pending_executor_io_task<T: Send + 'static>(
        bit: usize,
        settled: Arc<AtomicUsize>,
        started: tokio::sync::mpsc::UnboundedSender<()>,
    ) -> tokio::task::JoinHandle<std::io::Result<T>> {
        tokio::spawn(async move {
            let _receipt = IoSettlementReceipt { settled, bit };
            let _ = started.send(());
            std::future::pending::<std::io::Result<T>>().await
        })
    }

    async fn observe_executor_stop_io_settlement(
        provide_group: bool,
    ) -> (Result<(), ToolError>, usize, bool, bool) {
        let (actor, mut failures) = ExecutionActor::new(
            RuntimeIdentity::new("agent-stop-io-test", 1).unwrap(),
            PathBuf::from("/workspace"),
            PathBuf::from("/skills"),
            RuntimeMetrics::default(),
            CancellationToken::new(),
        );
        let call = super::ExecutorCall {
            progress: crate::progress::ProgressSink::default(),
            tool: ToolCommand::Info,
            request: Vec::new(),
            workspace: actor.workspace.clone(),
            system_skills: actor.system_skills.clone(),
            cancel: CancellationToken::new(),
            shutdown: actor.shutdown.clone(),
            timeout: std::time::Duration::from_secs(5),
            fatal: actor.fatal.clone(),
            gate: actor.gate.clone(),
            _lease: actor.gate.try_acquire().expect("test invocation lease"),
            children: actor.children(),
            contain_bash_descendants: false,
        };
        let settled = Arc::new(AtomicUsize::new(0));
        let (started, mut starting) = tokio::sync::mpsc::unbounded_channel();
        let mut io = super::ExecutorIo::new(
            pending_executor_io_task(0b001, settled.clone(), started.clone()),
            pending_executor_io_task(0b010, settled.clone(), started.clone()),
            pending_executor_io_task(0b100, settled.clone(), started),
        );
        for _ in 0..3 {
            starting
                .recv()
                .await
                .expect("I/O task entered its pending read");
        }

        let spawned = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn();
        let mut child = match spawned {
            Ok(child) => child,
            Err(error) => {
                io.abort();
                let _ = io.finish().await;
                panic!("spawn stop/join fixture: {error}");
            }
        };
        let group = if provide_group {
            child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .map(nix::unistd::Pid::from_raw)
        } else {
            None
        };
        let result = call.stop_executor(&mut child, group, &mut io).await;
        let settled_at_return = settled.load(Ordering::SeqCst);
        let poisoned_at_return = actor.gate.state.poisoned.load(Ordering::Acquire);
        let fatal_at_return = failures.try_recv().is_ok();

        // Capture the regression before yielding, then retire every real
        // resource before any assertion. The missing-group case leaves the
        // child running; the successful case has already waited for it.
        let _ = child.start_kill();
        let reaped = child.wait().await;
        if settled_at_return != 0b111 {
            io.abort();
            let _ = io.finish().await;
        }
        reaped.expect("fixture child must be killed and reaped before assertions");
        assert_eq!(
            settled.load(Ordering::SeqCst),
            0b111,
            "fixture cleanup must retire all I/O tasks before assertions",
        );
        (
            result,
            settled_at_return,
            poisoned_at_return,
            fatal_at_return,
        )
    }

    #[tokio::test(flavor = "current_thread")]
    async fn successful_executor_stop_joins_all_io_tasks_before_returning() {
        let (result, settled_at_return, poisoned, fatal) =
            observe_executor_stop_io_settlement(true).await;
        result.expect("the actual fixture process must stop successfully");
        assert!(
            !poisoned,
            "successful process stop must not poison admission",
        );
        assert!(
            !fatal,
            "successful process stop must not report containment failure",
        );
        assert_eq!(
            settled_at_return, 0b111,
            "process exit and abort requests do not prove that owned I/O tasks settled",
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_executor_stop_still_joins_all_io_tasks_before_returning() {
        let (result, settled_at_return, poisoned, fatal) =
            observe_executor_stop_io_settlement(false).await;
        assert_eq!(
            result
                .expect_err("a missing process group must fail containment")
                .code,
            ToolErrorCode::ChildProcessContainmentUnproven,
        );
        assert!(poisoned, "failed process stop must keep admission closed");
        assert!(
            fatal,
            "failed process stop must notify the Runtime supervisor",
        );
        assert_eq!(
            settled_at_return, 0b111,
            "a process-stop error must not abandon any owned I/O task",
        );
    }

    fn completed_executor_io_task<T: Send + 'static>(
        value: T,
        bit: usize,
        settled: Arc<AtomicUsize>,
        started: tokio::sync::mpsc::UnboundedSender<()>,
    ) -> tokio::task::JoinHandle<std::io::Result<T>> {
        tokio::spawn(async move {
            let _receipt = IoSettlementReceipt { settled, bit };
            let _ = started.send(());
            Ok(value)
        })
    }

    async fn executor_io_receipts_settled(settled: &AtomicUsize) -> bool {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while settled.load(Ordering::SeqCst) != 0b111 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .is_ok()
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executor_io_finish_resumes_after_partial_completion_and_cancellation() {
        let settled = Arc::new(AtomicUsize::new(0));
        let (started, mut starting) = tokio::sync::mpsc::unbounded_channel();
        let input = completed_executor_io_task((), 0b001, settled.clone(), started.clone());
        let output = pending_executor_io_task(0b010, settled.clone(), started.clone());
        let diagnostics = pending_executor_io_task(0b100, settled.clone(), started);
        // Keep independent cancellation ownership for cleanup even if resuming
        // finish panics after consuming a previously completed JoinHandle.
        let aborts = [
            input.abort_handle(),
            output.abort_handle(),
            diagnostics.abort_handle(),
        ];
        let mut started_count = 0;
        for _ in 0..3 {
            if starting.recv().await.is_some() {
                started_count += 1;
            }
        }
        let input_completed_before_poll = input.is_finished();
        let mut io = super::ExecutorIo::new(input, output, diagnostics);
        let first_poll = AssertUnwindSafe(async {
            let mut finishing = Box::pin(io.finish());
            let pending = futures_util::poll!(finishing.as_mut()).is_pending();
            drop(finishing);
            pending
        })
        .catch_unwind()
        .await;
        io.abort();
        let resumed = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(io.finish()).catch_unwind(),
        )
        .await;
        let settled_at_resume_return = settled.load(Ordering::SeqCst);

        // A caught re-poll panic must not detach the two pending tasks. Abort
        // via the retained handles, drop the owner, then observe all actual
        // future destructors before asserting either the regression or cleanup.
        for abort in &aborts {
            abort.abort();
        }
        drop(io);
        let cleanup_settled = executor_io_receipts_settled(&settled).await;
        assert!(
            cleanup_settled,
            "all real I/O tasks must retire before assertions"
        );
        assert_eq!(
            started_count, 3,
            "each I/O task must have entered its future"
        );
        assert!(
            input_completed_before_poll,
            "input must be complete before polling finish"
        );
        assert!(
            matches!(first_poll, Ok(true)),
            "finish must really poll the ready input and remain pending on output",
        );
        let resumed = resumed.expect("resumed finish must settle within the test bound");
        assert!(
            resumed.is_ok(),
            "resuming a cancelled finish must not re-poll a completed JoinHandle",
        );
        let resumed = resumed.unwrap_or_else(|_| unreachable!());
        assert!(
            resumed.is_err(),
            "aborted output cannot fabricate a complete response"
        );
        assert_eq!(
            settled_at_resume_return, 0b111,
            "resumed finish must join all tasks before returning its cancellation error",
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executor_stop_after_complete_io_finish_is_idempotent_and_reaps_child() {
        let (actor, mut failures) = ExecutionActor::new(
            RuntimeIdentity::new("agent-finished-io-test", 1).unwrap(),
            PathBuf::from("/workspace"),
            PathBuf::from("/skills"),
            RuntimeMetrics::default(),
            CancellationToken::new(),
        );
        let call = super::ExecutorCall {
            progress: crate::progress::ProgressSink::default(),
            tool: ToolCommand::Info,
            request: Vec::new(),
            workspace: actor.workspace.clone(),
            system_skills: actor.system_skills.clone(),
            cancel: CancellationToken::new(),
            shutdown: actor.shutdown.clone(),
            timeout: std::time::Duration::from_secs(5),
            fatal: actor.fatal.clone(),
            gate: actor.gate.clone(),
            _lease: actor.gate.try_acquire().expect("test invocation lease"),
            children: actor.children(),
            contain_bash_descendants: false,
        };
        // Spawn before creating I/O tasks so even a spawn failure cannot leave
        // an unowned task behind.
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn completed-I/O stop fixture");
        let group = child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .map(nix::unistd::Pid::from_raw);
        let settled = Arc::new(AtomicUsize::new(0));
        let (started, mut starting) = tokio::sync::mpsc::unbounded_channel();
        let input = completed_executor_io_task((), 0b001, settled.clone(), started.clone());
        let output = completed_executor_io_task(
            (b"stdout".to_vec(), false),
            0b010,
            settled.clone(),
            started.clone(),
        );
        let diagnostics = completed_executor_io_task(
            (b"diagnostics".to_vec(), true),
            0b100,
            settled.clone(),
            started,
        );
        let aborts = [
            input.abort_handle(),
            output.abort_handle(),
            diagnostics.abort_handle(),
        ];
        let mut started_count = 0;
        for _ in 0..3 {
            if starting.recv().await.is_some() {
                started_count += 1;
            }
        }
        let mut io = super::ExecutorIo::new(input, output, diagnostics);
        let finished = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(io.finish()).catch_unwind(),
        )
        .await;
        let child_before_stop = child.try_wait();
        let stopped = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(call.stop_executor(&mut child, group, &mut io)).catch_unwind(),
        )
        .await;
        let child_at_stop_return = child.try_wait();
        let settled_at_stop_return = settled.load(Ordering::SeqCst);
        let poisoned_at_stop_return = actor.gate.state.poisoned.load(Ordering::Acquire);
        let fatal_at_stop_return = failures.try_recv().is_ok();

        // Preserve all observations, then kill/reap and retire every task even
        // when an attempted second join panicked. Assertions follow cleanup.
        for abort in &aborts {
            abort.abort();
        }
        let _ = child.start_kill();
        let reaped = child.wait().await;
        drop(io);
        let cleanup_settled = executor_io_receipts_settled(&settled).await;
        assert!(
            cleanup_settled,
            "all real I/O tasks must retire before assertions"
        );
        reaped.expect("fixture child must be reaped before assertions");
        assert_eq!(
            started_count, 3,
            "each I/O task must have entered its future"
        );
        assert!(
            child_before_stop
                .expect("observe live fixture child")
                .is_none(),
            "the completed I/O fixture must still have a real child to stop",
        );
        let finished = finished.expect("initial finish must settle within the test bound");
        let finished = finished.unwrap_or_else(|_| panic!("initial finish must not panic"));
        assert_eq!(
            finished.expect("initial finish must preserve successful I/O"),
            (b"stdout".to_vec(), false, b"diagnostics".to_vec(), true),
        );
        let stopped = stopped.expect("stop must settle within the test bound");
        let stopped =
            stopped.unwrap_or_else(|_| panic!("stop must not join completed handles again"));
        stopped.expect("completed I/O must not turn a successful process stop into failure");
        assert!(
            child_at_stop_return.expect("observe stop result").is_some(),
            "stop must have waited for the real child before returning",
        );
        assert_eq!(settled_at_stop_return, 0b111);
        assert!(
            !poisoned_at_stop_return,
            "successful stop must preserve admission"
        );
        assert!(
            !fatal_at_stop_return,
            "successful stop must not report containment failure"
        );
    }

    fn executor_io_failure_call() -> (
        ExecutionActor,
        super::ExecutorCall,
        tokio::sync::mpsc::UnboundedReceiver<super::ExecutionFatal>,
    ) {
        let (actor, failures) = ExecutionActor::new(
            RuntimeIdentity::new("agent-io-failure-test", 1).unwrap(),
            PathBuf::from("/workspace"),
            PathBuf::from("/skills"),
            RuntimeMetrics::default(),
            CancellationToken::new(),
        );
        let call = super::ExecutorCall {
            progress: crate::progress::ProgressSink::default(),
            tool: ToolCommand::Info,
            request: Vec::new(),
            workspace: actor.workspace.clone(),
            system_skills: actor.system_skills.clone(),
            cancel: CancellationToken::new(),
            shutdown: actor.shutdown.clone(),
            timeout: std::time::Duration::from_secs(5),
            fatal: actor.fatal.clone(),
            gate: actor.gate.clone(),
            _lease: actor.gate.try_acquire().expect("test invocation lease"),
            children: actor.children(),
            contain_bash_descendants: false,
        };
        (actor, call, failures)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executor_io_cleanup_preserves_all_failures_and_joins_pending_task() {
        let (actor, call, mut failures) = executor_io_failure_call();
        let settled = Arc::new(AtomicUsize::new(0));
        let (started, mut starting) = tokio::sync::mpsc::unbounded_channel();
        let input_settled = settled.clone();
        let input_started = started.clone();
        let input = tokio::spawn(async move {
            let _receipt = IoSettlementReceipt {
                settled: input_settled,
                bit: 0b001,
            };
            let _ = input_started.send(());
            Err(std::io::Error::other("controlled stdin I/O failure"))
        });
        let output_settled = settled.clone();
        let output_started = started.clone();
        let output: super::OutputReader = tokio::spawn(async move {
            let _receipt = IoSettlementReceipt {
                settled: output_settled,
                bit: 0b010,
            };
            let _ = output_started.send(());
            panic!("controlled stdout task panic");
        });
        let diagnostics = pending_executor_io_task(0b100, settled.clone(), started);
        let aborts = [
            input.abort_handle(),
            output.abort_handle(),
            diagnostics.abort_handle(),
        ];
        let mut io = super::ExecutorIo::new(input, output, diagnostics);
        let observed = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(async {
                let mut started_count = 0;
                for _ in 0..3 {
                    if starting.recv().await.is_some() {
                        started_count += 1;
                    }
                }
                let settled_before_cleanup = settled.load(Ordering::SeqCst);
                let cleanup = io.abort_and_join().await;
                let result = call.with_io_cleanup(
                    Err::<(), _>(ToolError::new(
                        ToolErrorCode::RuntimeFailed,
                        "controlled primary failure",
                    )),
                    cleanup,
                );
                (
                    result,
                    started_count,
                    settled_before_cleanup,
                    settled.load(Ordering::SeqCst),
                    io.joining.is_none(),
                    actor.gate.state.poisoned.load(Ordering::Acquire),
                    failures.try_recv().is_ok(),
                )
            })
            .catch_unwind(),
        )
        .await;

        // Even an unexpected short-circuit or coordination panic must leave no
        // pending real task behind before the regression is asserted.
        for abort in &aborts {
            abort.abort();
        }
        let final_join = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(io.join()).catch_unwind(),
        )
        .await;
        drop(io);
        let cleanup_settled = executor_io_receipts_settled(&settled).await;
        assert!(
            cleanup_settled,
            "all task futures must drop before assertions"
        );
        let _ = final_join
            .expect("fixture cleanup must finish")
            .unwrap_or_else(|_| panic!("fixture cleanup must not panic"));
        let (result, started_count, before, at_return, joined, poisoned, fatal) = observed
            .expect("failed-task cleanup must be bounded")
            .unwrap_or_else(|_| panic!("failed-task cleanup must not panic"));
        assert_eq!(started_count, 3);
        assert_eq!(
            before, 0b011,
            "I/O failure and task panic must precede cleanup"
        );
        assert_eq!(
            at_return, 0b111,
            "the pending stderr task must also be joined"
        );
        assert!(joined, "all three original handles must have been consumed");
        assert!(poisoned, "a task panic must poison admission");
        assert!(fatal, "a task panic must notify the Runtime supervisor");
        let error = result.expect_err("task panic must not be treated as successful cleanup");
        assert_eq!(error.code, ToolErrorCode::ChildProcessContainmentUnproven);
        let combined = std::error::Error::source(&error)
            .and_then(|source| source.downcast_ref::<super::ExecutorCleanupFailure>())
            .expect("both the primary failure and cleanup failure must survive");
        assert_eq!(combined.primary.code, ToolErrorCode::RuntimeFailed);
        assert_eq!(combined.primary.message, "controlled primary failure");
        let cleanup = std::error::Error::source(&combined.cleanup)
            .and_then(|source| source.downcast_ref::<super::ExecutorIoFailure>())
            .expect("cleanup must retain the individual task failures");
        assert_eq!(
            cleanup.issues.len(),
            2,
            "returning only the first error loses evidence"
        );
        assert!(cleanup.issues.iter().any(|issue| matches!(
            issue,
            super::ExecutorIoIssue::Io { stream: "stdin", source }
                if source.to_string() == "controlled stdin I/O failure"
        )));
        assert!(cleanup.issues.iter().any(|issue| matches!(
            issue,
            super::ExecutorIoIssue::Join { stream: "stdout", source } if source.is_panic()
        )));
        let message = error.to_string();
        assert!(message.contains("controlled primary failure"));
        assert!(message.contains("stdin I/O failed: controlled stdin I/O failure"));
        assert!(message.contains("stdout task failed:"));
        assert!(message.contains("controlled stdout task panic"));
        assert!(matches!(
            actor.gate.try_acquire(),
            Err(AdmissionError::Unavailable)
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executor_io_cleanup_timeout_reuses_deadline_and_joins_released_blocking_task() {
        let (actor, call, mut failures) = executor_io_failure_call();
        let settled = Arc::new(AtomicUsize::new(0));
        let (started, mut starting) = tokio::sync::mpsc::unbounded_channel();
        // Dropping this sender is also an emergency release: a fixture unwind
        // cannot leave the blocking pool waiting forever in recv().
        let (release, released) = std::sync::mpsc::channel::<()>();
        let input_settled = settled.clone();
        let input_started = started.clone();
        let input = tokio::task::spawn_blocking(move || {
            let _receipt = IoSettlementReceipt {
                settled: input_settled,
                bit: 0b001,
            };
            let _ = input_started.send(());
            let _ = released.recv();
            Ok(())
        });
        let output = pending_executor_io_task(0b010, settled.clone(), started.clone());
        let diagnostics = pending_executor_io_task(0b100, settled.clone(), started);
        let aborts = [
            input.abort_handle(),
            output.abort_handle(),
            diagnostics.abort_handle(),
        ];
        let mut io = super::ExecutorIo::new(input, output, diagnostics);
        let observed = tokio::time::timeout(
            std::time::Duration::from_secs(7),
            AssertUnwindSafe(async {
                let mut started_count = 0;
                for _ in 0..3 {
                    if starting.recv().await.is_some() {
                        started_count += 1;
                    }
                }
                let first_started = tokio::time::Instant::now();
                let deadline = io.cleanup_deadline();
                let first = io.abort_and_join().await;
                let first_elapsed = first_started.elapsed();
                let first = call.with_io_cleanup(Ok::<(), ToolError>(()), first);
                let at_first_return = settled.load(Ordering::SeqCst);
                let poisoned = actor.gate.state.poisoned.load(Ordering::Acquire);
                let fatal = failures.try_recv().is_ok();
                let repeated_started = tokio::time::Instant::now();
                let repeated = io.abort_and_join().await;
                let repeated_elapsed = repeated_started.elapsed();
                (
                    first,
                    repeated,
                    started_count,
                    deadline,
                    io.cleanup_deadline(),
                    first_elapsed,
                    repeated_elapsed,
                    at_first_return,
                    settled.load(Ordering::SeqCst),
                    io.joining.is_some(),
                    poisoned,
                    fatal,
                )
            })
            .catch_unwind(),
        )
        .await;

        // First record the unproven result while the blocking task is still
        // held. Then release it and join its original handle through the same
        // owner before any assertion, including when observation panicked.
        for abort in &aborts {
            abort.abort();
        }
        let released = release.send(());
        drop(release);
        let joined = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(io.join()).catch_unwind(),
        )
        .await;
        drop(io);
        let cleanup_settled = executor_io_receipts_settled(&settled).await;
        assert!(
            cleanup_settled,
            "the released blocking future must drop before assertions"
        );
        released.expect("fixture must explicitly release its running blocking task");
        let (input, output, diagnostics) = joined
            .expect("released tasks must join within the fixture bound")
            .unwrap_or_else(|_| panic!("joining released tasks must not panic"))
            .expect("deadline failure must retain the original join ownership");
        input
            .expect("running spawn_blocking must not be cancelled by abort")
            .expect("released blocking input must finish successfully");
        assert!(
            output
                .expect_err("pending stdout must be aborted")
                .is_cancelled()
        );
        assert!(
            diagnostics
                .expect_err("pending stderr must be aborted")
                .is_cancelled()
        );
        let (
            first,
            repeated,
            started_count,
            deadline,
            repeated_deadline,
            first_elapsed,
            repeated_elapsed,
            at_first,
            at_repeated,
            retained,
            poisoned,
            fatal,
        ) = observed
            .expect("both cleanup attempts must be bounded")
            .unwrap_or_else(|_| panic!("cleanup timeout must be an error, not a panic"));
        assert_eq!(
            started_count, 3,
            "spawn_blocking must really be running before abort"
        );
        assert_eq!(
            at_first, 0b110,
            "abort must not pretend the running blocking task ended"
        );
        assert_eq!(
            at_repeated, 0b110,
            "repeated cleanup must not fabricate a blocking-task join"
        );
        assert!(
            retained,
            "the unfinished join future must remain owned after timeout"
        );
        assert_eq!(
            deadline, repeated_deadline,
            "cleanup must reuse its original absolute deadline"
        );
        assert!(first_elapsed >= super::PROCESS_STOP_TIMEOUT);
        assert!(
            repeated_elapsed < super::PROCESS_STOP_TIMEOUT,
            "repeated cleanup must not wait for another two-second stop budget",
        );
        assert!(poisoned, "unproven cleanup must close admission");
        assert!(fatal, "unproven cleanup must notify the Runtime supervisor");
        let first = first.expect_err("a running blocking task must exhaust the stop deadline");
        assert_eq!(first.code, ToolErrorCode::ChildProcessContainmentUnproven);
        let first = std::error::Error::source(&first)
            .and_then(|source| source.downcast_ref::<super::ExecutorIoFailure>())
            .expect("the deadline failure must remain available as a cause");
        assert!(first.containment_unproven());
        assert!(
            first
                .issues
                .iter()
                .any(|issue| matches!(issue, super::ExecutorIoIssue::TimedOut(_)))
        );
        let repeated = repeated.expect_err("expired cleanup must fail again without a new budget");
        assert!(repeated.containment_unproven());
        assert!(
            repeated
                .issues
                .iter()
                .any(|issue| matches!(issue, super::ExecutorIoIssue::TimedOut(_)))
        );
        assert!(matches!(
            actor.gate.try_acquire(),
            Err(AdmissionError::Unavailable)
        ));
    }

    async fn observe_stop_after_error_failure(
        panic_stdout: bool,
        provide_group: bool,
        primary: ToolError,
    ) -> ToolError {
        let (actor, call, mut failures) = executor_io_failure_call();
        // Create the process before the tasks so a spawn failure cannot leave
        // any I/O future behind.
        let mut child = tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .process_group(0)
            .kill_on_drop(true)
            .spawn()
            .expect("spawn stop-after-error fixture");
        let group = if provide_group {
            child
                .id()
                .and_then(|pid| i32::try_from(pid).ok())
                .map(nix::unistd::Pid::from_raw)
        } else {
            None
        };
        let settled = Arc::new(AtomicUsize::new(0));
        let (started, mut starting) = tokio::sync::mpsc::unbounded_channel();
        let input = pending_executor_io_task(0b001, settled.clone(), started.clone());
        let output: super::OutputReader = if panic_stdout {
            let settled = settled.clone();
            let started = started.clone();
            tokio::spawn(async move {
                let _receipt = IoSettlementReceipt {
                    settled,
                    bit: 0b010,
                };
                let _ = started.send(());
                panic!("controlled stop-after-error stdout panic");
            })
        } else {
            pending_executor_io_task(0b010, settled.clone(), started.clone())
        };
        let diagnostics = pending_executor_io_task(0b100, settled.clone(), started);
        let aborts = [
            input.abort_handle(),
            output.abort_handle(),
            diagnostics.abort_handle(),
        ];
        let mut io = super::ExecutorIo::new(input, output, diagnostics);
        let observed = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(async {
                let mut started_count = 0;
                for _ in 0..3 {
                    if starting.recv().await.is_some() {
                        started_count += 1;
                    }
                }
                let before = settled.load(Ordering::SeqCst);
                let result = call
                    .stop_after_error::<()>(&mut child, group, &mut io, primary)
                    .await;
                (
                    result,
                    started_count,
                    before,
                    settled.load(Ordering::SeqCst),
                    io.joining.is_none(),
                    child.try_wait(),
                    actor.gate.state.poisoned.load(Ordering::Acquire),
                    failures.try_recv().is_ok(),
                )
            })
            .catch_unwind(),
        )
        .await;

        // Keep these owners outside the timed/panic-catching observation. Even
        // an early return must kill/reap the real child and join the same I/O
        // before any result, setup or regression assertion is evaluated.
        for abort in &aborts {
            abort.abort();
        }
        let _ = child.start_kill();
        let reaped = child.wait().await;
        let joined = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            AssertUnwindSafe(io.join()).catch_unwind(),
        )
        .await;
        drop(io);
        let cleanup_settled = executor_io_receipts_settled(&settled).await;
        reaped.expect("fixture child must be reaped before assertions");
        let _ = joined
            .expect("fixture I/O cleanup must be bounded")
            .unwrap_or_else(|_| panic!("fixture I/O cleanup must not panic"));
        assert!(cleanup_settled, "all I/O tasks must drop before assertions");
        let (result, started_count, before, at_return, joined, child_at_return, poisoned, fatal) =
            observed
                .expect("stop-after-error must be bounded")
                .unwrap_or_else(|_| panic!("stop-after-error must not panic"));
        assert_eq!(started_count, 3, "all real I/O tasks must have started");
        assert_eq!(
            before,
            if panic_stdout { 0b010 } else { 0 },
            "the controlled failure must precede the actual stop",
        );
        assert_eq!(at_return, 0b111, "stop must join every owned I/O task");
        assert!(joined, "stop must consume the original join ownership");
        assert_eq!(
            child_at_return
                .expect("observe actual child at stop return")
                .is_some(),
            provide_group,
            "a valid group must be reaped; a missing group must remain a stop error",
        );
        assert!(poisoned, "unproven containment must poison admission");
        assert!(fatal, "unproven containment must notify the Supervisor");
        assert!(matches!(
            actor.gate.try_acquire(),
            Err(AdmissionError::Unavailable)
        ));
        let error = result.expect_err("the original and stop failures must remain failures");
        assert_eq!(error.code, ToolErrorCode::ChildProcessContainmentUnproven);
        error
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executor_stop_after_error_preserves_primary_when_io_panics() {
        let primary = ToolError::new(
            ToolErrorCode::RuntimeFailed,
            "controlled original wait failure",
        )
        .with_source(std::io::Error::other("controlled original wait source"));
        let error = observe_stop_after_error_failure(true, true, primary).await;
        let combined = std::error::Error::source(&error)
            .and_then(|source| source.downcast_ref::<super::ExecutorCleanupFailure>())
            .expect("actual stop must preserve the original wait error alongside the I/O panic");
        assert_eq!(combined.primary.code, ToolErrorCode::RuntimeFailed);
        assert_eq!(combined.primary.message, "controlled original wait failure");
        let original = std::error::Error::source(&combined.primary)
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .expect("the original wait error source must survive cleanup");
        assert_eq!(original.to_string(), "controlled original wait source");
        let cleanup = std::error::Error::source(&combined.cleanup)
            .and_then(|source| source.downcast_ref::<super::ExecutorIoFailure>())
            .expect("actual stdout JoinError must remain available");
        assert!(cleanup.issues.iter().any(|issue| matches!(
            issue,
            super::ExecutorIoIssue::Join { stream: "stdout", source } if source.is_panic()
        )));
        assert!(
            error
                .to_string()
                .contains("controlled original wait failure")
        );
        assert!(
            error
                .to_string()
                .contains("controlled stop-after-error stdout panic")
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn executor_stop_after_error_preserves_primary_when_process_group_is_missing() {
        let primary = crate::executor_protocol::ExecutorFailure::known(
            ToolErrorCode::Timeout,
            "controlled original executor timeout",
        )
        .into_tool_error();
        let error = observe_stop_after_error_failure(false, false, primary).await;
        let combined = std::error::Error::source(&error)
            .and_then(|source| source.downcast_ref::<super::ExecutorCleanupFailure>())
            .expect(
                "actual stop must preserve the decoded failure alongside the process-stop error",
            );
        assert_eq!(combined.primary.code, ToolErrorCode::Timeout);
        assert_eq!(
            combined.primary.message,
            "controlled original executor timeout"
        );
        let cleanup = std::error::Error::source(&combined.cleanup)
            .and_then(|source| source.downcast_ref::<std::io::Error>())
            .expect("actual missing-group process-stop source must remain available");
        assert_eq!(cleanup.to_string(), "executor process group unavailable");
        assert!(
            error
                .to_string()
                .contains("controlled original executor timeout")
        );
        assert!(
            error
                .to_string()
                .contains("executor process group unavailable")
        );
    }
}
