use super::{entry::CHILD_CONFIG_ENV, spec::ServerSpec};
use crate::processes::{ChildRegistry, OwnedChild};
use nix::{
    errno::Errno,
    sys::signal::{Signal, kill},
    unistd::Pid,
};
use std::{io, path::Path, process::Stdio, time::Duration};
use tokio::{process::Command, task::JoinHandle};

pub(super) struct ManagedProcess {
    pub(super) owned: OwnedChild,
    group: Option<Pid>,
    diagnostics: JoinHandle<io::Result<u64>>,
}

impl ManagedProcess {
    pub(super) fn spawn(
        registry: &ChildRegistry,
        spec: &ServerSpec,
        workspace: &Path,
    ) -> Result<Self, &'static str> {
        let encoded = serde_json::to_string(spec.input())
            .map_err(|_| "managed MCP configuration encoding failed")?;
        let mut command = Command::new("/proc/self/exe");
        command
            .arg("mcp-stdio")
            .env_clear()
            .env("HOME", workspace)
            .env("PATH", "/usr/local/bin:/usr/bin:/bin")
            .env("ANTNEST_RUNTIME_WORKSPACE", workspace)
            .env(CHILD_CONFIG_ENV, encoded)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0)
            .kill_on_drop(true);
        let mut owned = registry
            .spawn(&mut command)
            .map_err(|_| "managed MCP process could not be spawned")?;
        let group = owned
            .child
            .id()
            .and_then(|pid| i32::try_from(pid).ok())
            .map(Pid::from_raw);
        let mut stderr = owned
            .child
            .stderr
            .take()
            .ok_or("managed MCP stderr unavailable")?;
        let diagnostics =
            tokio::spawn(async move { tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await });
        Ok(Self {
            owned,
            group,
            diagnostics,
        })
    }

    pub(super) async fn stop(mut self) -> Result<(), &'static str> {
        self.signal()?;
        tokio::time::timeout(Duration::from_secs(2), self.owned.child.wait())
            .await
            .map_err(|_| "managed MCP process shutdown timed out")?
            .map_err(|_| "managed MCP process wait failed")?;
        self.group = None;
        self.diagnostics.abort();
        // Stderr is intentionally discarded; cancellation and closed-pipe errors
        // during shutdown carry no protocol or process outcome information.
        let _ = (&mut self.diagnostics).await;
        Ok(())
    }

    fn signal(&self) -> Result<(), &'static str> {
        if let Some(group) = self.group {
            match kill(Pid::from_raw(-group.as_raw()), Signal::SIGKILL) {
                Ok(()) | Err(Errno::ESRCH) => {}
                Err(_) => return Err("managed MCP process termination failed"),
            }
        }
        Ok(())
    }
}

impl Drop for ManagedProcess {
    fn drop(&mut self) {
        if self.signal().is_err() {
            tracing::error!(error.type = "managed_mcp_stop_failed", "Managed MCP fallback termination failed");
        }
        self.diagnostics.abort();
    }
}
