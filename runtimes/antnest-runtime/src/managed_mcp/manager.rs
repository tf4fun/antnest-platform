use super::{catalog::Catalog, process::ManagedProcess, session, spec::ServerSpec};
use crate::{lifecycle_error::RuntimeErrorCode, processes::ChildRegistry};
use rmcp::{RoleClient, service::RunningService};
use std::{path::Path, time::Duration};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

pub(crate) const START_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
#[error("managed MCP {server_id}: {reason}")]
pub(crate) struct ManagedError {
    pub(crate) code: RuntimeErrorCode,
    server_id: String,
    reason: &'static str,
}

impl ManagedError {
    fn new(code: RuntimeErrorCode, id: &str, reason: &'static str) -> Self {
        Self {
            code,
            server_id: id.into(),
            reason,
        }
    }
}

#[derive(Default)]
pub(crate) struct ManagedMcp {
    catalog: Catalog,
    tasks: JoinSet<Result<(), ManagedError>>,
    stop: CancellationToken,
}

impl ManagedMcp {
    pub(crate) async fn initialize(
        &mut self,
        servers: &[ServerSpec],
        registry: &ChildRegistry,
        workspace: &Path,
    ) -> Result<(), ManagedError> {
        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        for server in servers {
            self.start_one(server, registry, workspace, deadline)
                .await?;
        }
        if !self.catalog.healthy() {
            return Err(ManagedError::new(
                RuntimeErrorCode::ManagedMcpStartFailed,
                "catalog",
                "required service exited during startup",
            ));
        }
        Ok(())
    }

    async fn start_one(
        &mut self,
        spec: &ServerSpec,
        registry: &ChildRegistry,
        workspace: &Path,
        deadline: tokio::time::Instant,
    ) -> Result<(), ManagedError> {
        let start_error =
            |reason| ManagedError::new(RuntimeErrorCode::ManagedMcpStartFailed, spec.id(), reason);
        let mut process = ManagedProcess::spawn(registry, spec, workspace).map_err(start_error)?;
        let stdout = process
            .owned
            .child
            .stdout
            .take()
            .ok_or_else(|| start_error("stdout unavailable"))?;
        let stdin = process
            .owned
            .child
            .stdin
            .take()
            .ok_or_else(|| start_error("stdin unavailable"))?;
        let cancel = self.stop.child_token();
        let progress = super::progress::ProgressSource::default();
        let initialization = tokio::time::timeout_at(
            deadline,
            session::connect(stdout, stdin, cancel.clone(), progress.clone()),
        )
        .await;
        let service = match initialization {
            Ok(Ok(service)) => service,
            result => {
                cancel.cancel();
                process.stop().await.map_err(start_error)?;
                return Err(start_error(if result.is_err() {
                    "initialization deadline exceeded"
                } else {
                    "initialization failed"
                }));
            }
        };
        let peer = service.peer().clone();
        let id = spec.id().to_owned();
        let unavailable = self.catalog.unavailable();
        self.tasks.spawn(supervise(
            id,
            process,
            service,
            cancel,
            self.stop.clone(),
            unavailable,
        ));
        tokio::time::timeout_at(deadline, self.catalog.add_server(spec.id(), peer, progress))
            .await
            .map_err(|_| start_error("tool discovery deadline exceeded"))?
            .map_err(start_error)?;
        tracing::info!(
            lifecycle.event = "managed_mcp_started",
            mcp.server.id = spec.id(),
            "Managed MCP initialized"
        );
        Ok(())
    }

    pub(crate) fn catalog(&self) -> Catalog {
        self.catalog.clone()
    }

    pub(crate) async fn wait_failure(&mut self) -> ManagedError {
        match self.tasks.join_next().await {
            Some(Ok(Err(error))) => error,
            Some(_) => ManagedError::new(
                RuntimeErrorCode::ManagedMcpServiceFailed,
                "supervisor",
                "managed service stopped unexpectedly",
            ),
            None => std::future::pending().await,
        }
    }

    pub(crate) async fn shutdown(&mut self) -> Result<(), ManagedError> {
        self.stop.cancel();
        self.catalog.unavailable().cancel();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
        let mut failure = None;
        loop {
            match tokio::time::timeout_at(deadline, self.tasks.join_next()).await {
                Ok(None) => return failure.map_or(Ok(()), Err),
                Ok(Some(Ok(Ok(())))) => {}
                Ok(Some(Ok(Err(error)))) => {
                    failure.get_or_insert(error);
                }
                Ok(Some(Err(_))) => {
                    failure.get_or_insert_with(|| {
                        ManagedError::new(
                            RuntimeErrorCode::ManagedMcpStopFailed,
                            "supervisor",
                            "managed task failed",
                        )
                    });
                }
                Err(_) => {
                    self.tasks.shutdown().await;
                    return Err(ManagedError::new(
                        RuntimeErrorCode::ManagedMcpStopFailed,
                        "supervisor",
                        "shutdown deadline exceeded",
                    ));
                }
            }
        }
    }
}

impl Drop for ManagedMcp {
    fn drop(&mut self) {
        self.stop.cancel();
        self.catalog.unavailable().cancel();
    }
}

async fn supervise(
    id: String,
    mut process: ManagedProcess,
    service: RunningService<RoleClient, ()>,
    cancel: CancellationToken,
    stop: CancellationToken,
    unavailable: CancellationToken,
) -> Result<(), ManagedError> {
    let mut service_done = Box::pin(service.waiting());
    let transport_exited = tokio::select! {
        _ = &mut service_done => true,
        _ = process.owned.child.wait() => false,
        _ = stop.cancelled() => false,
    };
    unavailable.cancel();
    let expected = stop.is_cancelled();
    cancel.cancel();
    let process_result = process.stop().await;
    if !transport_exited
        && tokio::time::timeout(Duration::from_secs(1), &mut service_done)
            .await
            .is_err()
    {
        return Err(ManagedError::new(
            RuntimeErrorCode::ManagedMcpStopFailed,
            &id,
            "SDK shutdown deadline exceeded",
        ));
    }
    process_result
        .map_err(|reason| ManagedError::new(RuntimeErrorCode::ManagedMcpStopFailed, &id, reason))?;
    tracing::info!(
        lifecycle.event = "managed_mcp_stopped",
        mcp.server.id = id,
        expected,
        "Managed MCP stopped"
    );
    if expected {
        Ok(())
    } else {
        Err(ManagedError::new(
            RuntimeErrorCode::ManagedMcpServiceFailed,
            &id,
            "required service exited",
        ))
    }
}
