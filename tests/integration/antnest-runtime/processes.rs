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
