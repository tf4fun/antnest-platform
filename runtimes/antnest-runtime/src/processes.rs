use std::collections::BTreeSet;
use std::io;
use std::sync::{Arc, Mutex};

use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Default)]
pub(crate) struct ChildRegistry(Arc<Mutex<BTreeSet<u32>>>);

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
        self.registry
            .0
            .lock()
            .expect("child registry")
            .remove(&self.pid);
    }
}

impl ChildRegistry {
    pub(crate) fn spawn(&self, command: &mut Command) -> io::Result<OwnedChild> {
        // Registration and orphan collection share this lock so a short-lived
        // owned child cannot have its exit status stolen before registration.
        let mut owned = self.0.lock().expect("child registry");
        let child = command.spawn()?;
        let pid = child
            .id()
            .ok_or_else(|| io::Error::other("spawned child has no PID"))?;
        owned.insert(pid);
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
    fn reap_exited_orphans(&self) -> io::Result<()> {
        let mut candidates = BTreeSet::new();
        for task in std::fs::read_dir("/proc/self/task")? {
            let path = task?.path().join("children");
            let children = match std::fs::read_to_string(path) {
                Ok(value) => value,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error),
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
            if owned.contains(&pid) {
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

#[cfg(test)]
mod tests {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/integration/antnest-runtime/processes.rs"
    ));
}
