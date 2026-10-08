use std::env;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;

use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::command::ToolCommand;
use crate::executor_protocol::{
    MAX_EXECUTOR_MESSAGE_BYTES, decode_bash_request, decode_edit_request, decode_info_request,
    decode_read_request, decode_skill_cancel_request, decode_skill_check_request,
    decode_skill_commit_request, decode_skill_observe_request, decode_skill_prepare_request,
    decode_skill_release_request, decode_temporary_install_request,
    decode_temporary_release_request, decode_write_request, encode_bash_reply, encode_edit_reply,
    encode_info_reply, encode_read_reply, encode_skill_cancel_reply, encode_skill_check_reply,
    encode_skill_commit_reply, encode_skill_observe_reply, encode_skill_prepare_reply,
    encode_skill_release_reply, encode_temporary_install_reply, encode_temporary_released_reply,
    encode_write_reply,
};
use crate::executor_protocol::{
    decode_skill_digest_request, decode_skill_install_request, encode_skill_digest_reply,
    encode_skill_install_cleaned_reply, encode_skill_install_reply,
};
use crate::information::RuntimeContext;
use crate::roots::NamedRoots;
use crate::tools::ToolEngine;

#[derive(Debug, Error)]
pub(crate) enum ExecutorEntryError {
    #[error("executor privilege transition failed: {0}")]
    Privilege(#[from] crate::privilege::PrivilegeError),
    #[error("executor filesystem roots are invalid: {0}")]
    Roots(#[from] crate::roots::RootError),
    #[error("executor runtime initialization failed: {0}")]
    Runtime(#[from] io::Error),
    #[error("executor protocol failed: {0}")]
    Protocol(String),
}

pub(crate) fn run(command: ToolCommand) -> Result<(), ExecutorEntryError> {
    crate::privilege::enter_executor_state()?;
    crate::privilege::close_untrusted_fds()?;

    let workspace = env_path("ANTNEST_RUNTIME_WORKSPACE", "/workspace");
    let system_skills = env_path("ANTNEST_RUNTIME_SYSTEM_SKILLS", "/skills");
    let roots = Arc::new(NamedRoots::open(&workspace, &system_skills)?);
    let engine = ToolEngine::new(roots.clone());
    let input = read_message()?;
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let cancel = CancellationToken::new();

    match command {
        ToolCommand::Info => {
            let result = decode_info_request(&input).and_then(|()| RuntimeContext::collect(&roots));
            write_reply(encode_info_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::Bash => {
            let progress = crate::progress::ProgressSink::new(|update| {
                let sent = serde_json::to_vec(&serde_json::json!({"progress": update}))
                    .map_err(protocol_error)
                    .and_then(write_reply);
                if sent.is_err() {
                    // Losing the parent pipe is fatal to this executor, never a retry.
                    std::process::exit(74);
                }
            });
            let result = decode_bash_request(&input).and_then(|request| {
                runtime.block_on(engine.bash_with_progress(request, cancel, progress))
            });
            write_reply(encode_bash_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::Read => {
            let result = decode_read_request(&input)
                .and_then(|request| runtime.block_on(engine.read(request, cancel)));
            write_reply(encode_read_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::Write => {
            let result = decode_write_request(&input)
                .and_then(|request| runtime.block_on(engine.write(request, cancel)));
            write_reply(encode_write_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::Edit => {
            let result = decode_edit_request(&input)
                .and_then(|request| runtime.block_on(engine.edit(request, cancel)));
            write_reply(encode_edit_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillPrepare => {
            let result = decode_skill_prepare_request(&input)
                .and_then(|request| crate::skill_candidate::prepare_candidate(&roots, request));
            write_reply(encode_skill_prepare_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillCheck => {
            let result = decode_skill_check_request(&input)
                .and_then(|request| crate::skill_candidate::check_candidate(&roots, request));
            write_reply(encode_skill_check_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillCommit => {
            let result = decode_skill_commit_request(&input)
                .and_then(|request| crate::skill_candidate::commit_candidate(&roots, request));
            write_reply(encode_skill_commit_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillObserve => {
            let result = decode_skill_observe_request(&input)
                .and_then(|request| crate::skill_candidate::observe_candidate(&roots, request));
            write_reply(encode_skill_observe_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillCancel => {
            let result = decode_skill_cancel_request(&input)
                .and_then(|request| crate::skill_candidate::cancel_generation(&roots, request));
            write_reply(encode_skill_cancel_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillRelease => {
            let result = decode_skill_release_request(&input)
                .and_then(|request| crate::skill_candidate::release_candidate(&roots, request));
            write_reply(encode_skill_release_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillInstall => {
            let result = decode_skill_install_request(&input)
                .and_then(|request| crate::skill_install::install_skill(&roots, request));
            write_reply(encode_skill_install_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillDigest => {
            let result = decode_skill_digest_request(&input)
                .and_then(|request| crate::skill_install::skill_digest(&roots, request));
            write_reply(encode_skill_digest_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillInstallClean => {
            let result = decode_info_request(&input).and_then(|()| {
                crate::skill_install::clean_install_staging(&roots)
                    .map(|()| crate::skill_install::SkillInstallStagingCleaned {})
            });
            write_reply(encode_skill_install_cleaned_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillTemporaryInstall => {
            let result = decode_temporary_install_request(&input)
                .and_then(|request| crate::skill_temporary::install_temporary(&roots, request));
            write_reply(encode_temporary_install_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillTemporaryRelease => {
            let result = decode_temporary_release_request(&input)
                .and_then(|request| crate::skill_temporary::release_temporary(&roots, request));
            write_reply(encode_temporary_released_reply(result).map_err(protocol_error)?)
        }
        ToolCommand::SkillTemporaryClean => {
            let result = decode_info_request(&input)
                .and_then(|()| crate::skill_temporary::clean_temporary(&roots));
            write_reply(encode_temporary_released_reply(result).map_err(protocol_error)?)
        }
    }
}

fn protocol_error(error: impl std::fmt::Display) -> ExecutorEntryError {
    ExecutorEntryError::Protocol(error.to_string())
}

fn env_path(name: &str, default: &str) -> PathBuf {
    env::var_os(name)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(default))
}

fn read_message() -> Result<Vec<u8>, ExecutorEntryError> {
    let mut input = Vec::new();
    io::stdin()
        .take((MAX_EXECUTOR_MESSAGE_BYTES + 1) as u64)
        .read_to_end(&mut input)
        .map_err(|error| ExecutorEntryError::Protocol(error.to_string()))?;
    if input.len() > MAX_EXECUTOR_MESSAGE_BYTES {
        return Err(ExecutorEntryError::Protocol(
            "executor request exceeds the encoded limit".into(),
        ));
    }
    Ok(input)
}

fn write_reply(encoded: Vec<u8>) -> Result<(), ExecutorEntryError> {
    if encoded.len() > MAX_EXECUTOR_MESSAGE_BYTES {
        return Err(ExecutorEntryError::Protocol(
            "executor response exceeds the encoded limit".into(),
        ));
    }
    let mut stdout = io::stdout().lock();
    stdout
        .write_all(&encoded)
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush())
        .map_err(|error| ExecutorEntryError::Protocol(error.to_string()))
}
