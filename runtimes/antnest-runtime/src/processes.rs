use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::sync::{Arc, Mutex};

use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Default)]
struct ChildState {
    owned: BTreeSet<u32>,
    bash_groups: BTreeSet<u32>,
    managed: BTreeMap<u32, String>,
}

#[derive(Clone, Debug, Default)]
pub(crate) struct ChildRegistry(Arc<Mutex<ChildState>>);

pub(crate) struct OwnedChild {
    pub(crate) child: Child,
    _owner: ChildOwner,
}

struct ChildOwner {
    pid: u32,
    registry: ChildRegistry,
}

impl Drop for ChildOwner {
    fn drop(&mut self) {
        let mut state = self.registry.0.lock().expect("child registry");
        state.owned.remove(&self.pid);
        state.managed.remove(&self.pid);
    }
}

impl ChildRegistry {
    pub(crate) fn spawn(&self, command: &mut Command) -> io::Result<OwnedChild> {
        self.spawn_with_kind(command, false, None)
    }

    pub(crate) fn spawn_bash(&self, command: &mut Command) -> io::Result<OwnedChild> {
        self.spawn_with_kind(command, true, None)
    }

    pub(crate) fn spawn_managed(
        &self,
        command: &mut Command,
        server_id: &str,
    ) -> io::Result<OwnedChild> {
        self.spawn_with_kind(command, false, Some(server_id))
    }

    fn spawn_with_kind(
        &self,
        command: &mut Command,
        background_group: bool,
        managed_server: Option<&str>,
    ) -> io::Result<OwnedChild> {
        // Registration and orphan collection share this lock so a short-lived
        // owned child cannot have its exit status stolen before registration.
        let mut owned = self.0.lock().expect("child registry");
        let child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned child has no PID"))?;
        owned.owned.insert(pid);
        if background_group {
            owned.bash_groups.insert(pid);
        }
        if let Some(server_id) = managed_server {
            owned.managed.insert(pid, server_id.to_owned());
        }
        Ok(OwnedChild {
            child,
            _owner: ChildOwner {
                pid,
                registry: self.clone(),
            },
        })
    }

    pub(crate) async fn reap_orphans(&self, shutdown: CancellationToken) -> io::Result<()> {
        #[cfg(target_os = "linux")]
        if std::process::id() == 1 {
            let mut signals =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::child())?;
            loop {
                self.reap_exited_orphans()?;
                tokio::select! {
                    _ = shutdown.cancelled() => return Ok(()),
                    _ = signals.recv() => {},
                    _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {},
                }
            }
        }
        shutdown.cancelled().await;
        Ok(())
    }

    #[cfg(target_os = "linux")]
    #[allow(dead_code)] // L1 commit admission consumes this observation.
    pub(crate) fn unknown_live_children(&self) -> io::Result<Vec<u32>> {
        // Hold the registry lock while reading procfs so a just-spawned owned
        // executor cannot be misclassified before its PID is registered.
        let owned = self.0.lock().expect("child registry");
        let mut children = BTreeSet::new();
        for task in std::fs::read_dir("/proc/self/task")? {
            let path = task?.path().join("children");
            let Some(contents) = procfs_entry(std::fs::read_to_string(path))? else {
                continue;
            };
            for value in contents.split_whitespace() {
                let pid = value.parse::<u32>().map_err(io::Error::other)?;
                if !owned.owned.contains(&pid) && process_is_live(pid)? {
                    children.insert(pid);
                }
            }
        }
        Ok(children.into_iter().collect())
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn live_background_groups(&self) -> io::Result<Vec<u32>> {
        let mut state = self.0.lock().expect("child registry");
        if state.bash_groups.is_empty() {
            return Ok(Vec::new());
        }
        let mut live_groups = BTreeSet::new();
        for process in std::fs::read_dir("/proc")? {
            let process = process?;
            let Some(pid) = process
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if let Some(process) = live_process_info(pid)?
                && state.bash_groups.contains(&process.group)
            {
                live_groups.insert(process.group);
            }
        }
        state
            .bash_groups
            .retain(|group| live_groups.contains(group));
        Ok(live_groups.into_iter().collect())
    }

    #[cfg(target_os = "linux")]
    pub(crate) fn live_managed_work(&self) -> io::Result<Vec<String>> {
        let state = self.0.lock().expect("child registry");
        if state.managed.is_empty() {
            return Ok(Vec::new());
        }
        let mut processes = BTreeMap::new();
        for entry in std::fs::read_dir("/proc")? {
            let entry = entry?;
            let Some(pid) = entry
                .file_name()
                .to_str()
                .and_then(|name| name.parse::<u32>().ok())
            else {
                continue;
            };
            if let Some(process) = live_process_info(pid)? {
                processes.insert(pid, process);
            }
        }
        let mut busy = BTreeSet::new();
        for (&pid, process) in &processes {
            for (&leader, server_id) in &state.managed {
                if pid == leader {
                    continue;
                }
                if process.group == leader || has_ancestor(&processes, process.parent, leader) {
                    busy.insert(server_id.clone());
                }
            }
        }
        Ok(busy.into_iter().collect())
    }

    #[cfg(target_os = "linux")]
    fn reap_exited_orphans(&self) -> io::Result<()> {
        let mut candidates = BTreeSet::new();
        for task in std::fs::read_dir("/proc/self/task")? {
            let path = task?.path().join("children");
            let Some(children) = procfs_entry(std::fs::read_to_string(path))? else {
                continue;
            };
            candidates.extend(
                children
                    .split_whitespace()
                    .filter_map(|value| value.parse::<u32>().ok()),
            );
        }
        self.reap_exited(candidates)?;
        Ok(())
    }

    #[cfg(any(test, target_os = "linux"))]
    fn reap_exited(&self, candidates: impl IntoIterator<Item = u32>) -> io::Result<usize> {
        use nix::errno::Errno;
        use nix::sys::wait::{WaitPidFlag, WaitStatus, waitpid};
        use nix::unistd::Pid;

        let owned = self.0.lock().expect("child registry");
        let mut reaped = 0;
        for pid in candidates {
            if owned.owned.contains(&pid) {
                continue;
            }
            let pid = i32::try_from(pid).map_err(io::Error::other)?;
            match waitpid(Pid::from_raw(pid), Some(WaitPidFlag::WNOHANG)) {
                Ok(WaitStatus::Exited(..) | WaitStatus::Signaled(..)) => reaped += 1,
                Ok(_) | Err(Errno::ECHILD | Errno::EINTR | Errno::ESRCH) => {}
                Err(error) => return Err(io::Error::from_raw_os_error(error as i32)),
            }
        }
        Ok(reaped)
    }
}

/// A process or thread that exits after its /proc directory was listed reads
/// as ENOENT, or as ESRCH once the open file outlives the task.
#[cfg(any(test, target_os = "linux"))]
fn procfs_entry(read: io::Result<String>) -> io::Result<Option<String>> {
    match read {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if error.kind() == io::ErrorKind::NotFound
                || error.raw_os_error() == Some(libc::ESRCH) =>
        {
            Ok(None)
        }
        Err(error) => Err(error),
    }
}

#[cfg(target_os = "linux")]
fn process_is_live(pid: u32) -> io::Result<bool> {
    let Some(status) = procfs_entry(std::fs::read_to_string(format!("/proc/{pid}/status")))? else {
        return Ok(false);
    };
    let state = status.lines().find_map(|line| line.strip_prefix("State:"));
    // Unknown or unreadable states are blockers; only a confirmed terminal
    // zombie/dead state is safe to ignore while the orphan reaper catches up.
    Ok(!state.is_some_and(|value| matches!(value.trim().as_bytes().first(), Some(b'Z' | b'X'))))
}

#[cfg(target_os = "linux")]
#[derive(Clone, Copy)]
struct ProcessInfo {
    parent: u32,
    group: u32,
}

#[cfg(target_os = "linux")]
fn has_ancestor(processes: &BTreeMap<u32, ProcessInfo>, mut parent: u32, ancestor: u32) -> bool {
    for _ in 0..processes.len() {
        if parent == ancestor {
            return true;
        }
        let Some(process) = processes.get(&parent) else {
            return false;
        };
        parent = process.parent;
    }
    false
}

#[cfg(target_os = "linux")]
fn live_process_info(pid: u32) -> io::Result<Option<ProcessInfo>> {
    let Some(stat) = procfs_entry(std::fs::read_to_string(format!("/proc/{pid}/stat")))? else {
        return Ok(None);
    };
    // The command name in parentheses may contain spaces or closing parentheses.
    let suffix = stat
        .rsplit_once(") ")
        .ok_or_else(|| io::Error::other("invalid process stat"))?
        .1;
    let mut fields = suffix.split_whitespace();
    let state = fields
        .next()
        .ok_or_else(|| io::Error::other("missing process state"))?;
    let parent = fields
        .next()
        .ok_or_else(|| io::Error::other("missing process parent"))?
        .parse::<u32>()
        .map_err(|error| io::Error::other(format!("process {pid} parent field: {error}")))?;
    let group = fields
        .next()
        .ok_or_else(|| io::Error::other("missing process group"))?
        .parse::<u32>()
        .map_err(|error| io::Error::other(format!("process {pid} group field: {error}")))?;
    if matches!(state, "Z" | "X") {
        Ok(None)
    } else {
        Ok(Some(ProcessInfo { parent, group }))
    }
}

#[cfg(test)]
mod tests {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/integration/antnest-runtime/processes.rs"
    ));
}
