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
    use super::ChildRegistry;
    use std::process::{Child, Command, Stdio};
    use std::time::{Duration, Instant};

    struct TestChild(Child, bool);

    impl Drop for TestChild {
        fn drop(&mut self) {
            if self.1 {
                return;
            }
            // A failing assertion must not leave the test's background process.
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn child(script: &str) -> TestChild {
        TestChild(
            Command::new("/bin/sh")
                .args(["-c", script])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("test child"),
            false,
        )
    }

    #[test]
    fn orphan_collection_does_not_signal_live_background_processes() {
        let registry = ChildRegistry::default();
        let mut job = child("exec sleep 60");
        assert_eq!(registry.reap_exited([job.0.id()]).unwrap(), 0);
        assert!(job.0.try_wait().unwrap().is_none());
    }

    #[test]
    fn orphan_collection_reaps_exited_processes() {
        let registry = ChildRegistry::default();
        let mut job = child("exit 0");
        let deadline = Instant::now() + Duration::from_secs(5);
        while registry.reap_exited([job.0.id()]).unwrap() == 0 {
            assert!(Instant::now() < deadline, "child never exited");
            std::thread::sleep(Duration::from_millis(10));
        }
        job.1 = true;
        assert_eq!(registry.reap_exited([job.0.id()]).unwrap(), 0);
    }

    #[tokio::test]
    async fn orphan_collection_does_not_steal_owned_exit_status() {
        let registry = ChildRegistry::default();
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", "exit 23"]).kill_on_drop(true);
        let mut owned = registry.spawn(&mut command).unwrap();
        let pid = owned.child.id().unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert_eq!(registry.reap_exited([pid]).unwrap(), 0);
        assert_eq!(owned.child.wait().await.unwrap().code(), Some(23));
        drop(owned);
        assert!(!registry.0.lock().unwrap().contains(&pid));
    }
}
