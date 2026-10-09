use std::os::unix::process::ExitStatusExt as _;
use std::path::PathBuf;
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
use tokio::task::JoinHandle;
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
        let mut io = ExecutorIo {
            input,
            output,
            diagnostics,
        };

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
                    self.stop_executor(child, process_group, &mut io).await?;
                    return Err(self
                        .unobserved_error(format!("wait for executor process: {error}"))
                        .with_source(error));
                }
            },
            Exit::Canceled => {
                tracing::Span::current().record("executor.exit.classification", "canceled");
                self.stop_executor(child, process_group, &mut io).await?;
                return Err(
                    self.interrupted_error(ToolErrorCode::Canceled, "executor request canceled")
                );
            }
            Exit::Shutdown => {
                tracing::Span::current().record("executor.exit.classification", "shutdown");
                self.gate.close();
                self.stop_executor(child, process_group, &mut io).await?;
                return Err(
                    self.interrupted_error(ToolErrorCode::Canceled, "Runtime is shutting down")
                );
            }
            Exit::TimedOut => {
                tracing::Span::current().record("executor.exit.classification", "timeout");
                self.stop_executor(child, process_group, &mut io).await?;
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
                .map_err(|error| self.unobserved_error(&error).with_source(error))?;
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
                    ToolErrorCode::Timeout | ToolErrorCode::Canceled | ToolErrorCode::WaitFailed
                ) {
                    // The non-root shell already reported interruption. Retire
                    // only this invocation's group, never prior background jobs.
                    self.stop_executor(child, process_group, &mut io).await?;
                }
                Err(error.into_tool_error())
            }
        }
    }

    fn temporary_containment_failure(&self, error: impl std::fmt::Display) -> ToolError {
        self.gate.poison();
        let _ = self.fatal.send(ExecutionFatal);
        ToolError::unknown(ToolErrorCode::ChildProcessContainmentUnproven, error)
    }

    async fn stop_executor(
        &self,
        child: &mut Child,
        group: Option<Pid>,
        io: &mut ExecutorIo,
    ) -> Result<(), ToolError> {
        let result = terminate_executor(child, group).await;
        io.abort();
        if let Err(error) = result {
            self.gate.poison();
            let _ = self.fatal.send(ExecutionFatal);
            return Err(
                ToolError::unknown(ToolErrorCode::ChildProcessContainmentUnproven, &error)
                    .with_source(error),
            );
        }
        Ok(())
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

async fn terminate_executor(child: &mut Child, process_group: Option<Pid>) -> std::io::Result<()> {
    let group =
        process_group.ok_or_else(|| std::io::Error::other("executor process group unavailable"))?;
    match kill(Pid::from_raw(-group.as_raw()), Signal::SIGKILL) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
        Err(error) => return Err(std::io::Error::from_raw_os_error(error as i32)),
    }
    tokio::time::timeout(PROCESS_STOP_TIMEOUT, child.wait())
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

struct ExecutorIo {
    input: JoinHandle<std::io::Result<()>>,
    output: OutputReader,
    diagnostics: OutputReader,
}

impl ExecutorIo {
    async fn finish(&mut self) -> std::io::Result<(Vec<u8>, bool, Vec<u8>, bool)> {
        let (input, output, diagnostics) =
            tokio::join!(&mut self.input, &mut self.output, &mut self.diagnostics);
        input.map_err(std::io::Error::other)??;
        let (output, truncated) = output.map_err(std::io::Error::other)??;
        let (diagnostics, diagnostics_truncated) = diagnostics.map_err(std::io::Error::other)??;
        Ok((output, truncated, diagnostics, diagnostics_truncated))
    }

    fn abort(&self) {
        self.input.abort();
        self.output.abort();
        self.diagnostics.abort();
    }
}

impl Drop for ExecutorIo {
    fn drop(&mut self) {
        self.abort();
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
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

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
}
