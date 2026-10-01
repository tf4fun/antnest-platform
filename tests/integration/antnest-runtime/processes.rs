use super::ChildRegistry;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

#[cfg(target_os = "linux")]
struct TestGroup(i32);

#[cfg(target_os = "linux")]
impl Drop for TestGroup {
    fn drop(&mut self) {
        let _ = nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(-self.0),
            nix::sys::signal::Signal::SIGKILL,
        );
    }
}

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
    assert!(!registry.0.lock().unwrap().owned.contains(&pid));
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn writer_scan_distinguishes_owned_and_unowned_live_children() {
    let registry = ChildRegistry::default();
    let unowned = child("exec sleep 60");
    let mut command = tokio::process::Command::new("/bin/sleep");
    command.arg("60").kill_on_drop(true);
    let mut owned = registry.spawn(&mut command).expect("owned child");
    let owned_pid = owned.child.id().unwrap();
    let live = registry.unknown_live_children().expect("live child scan");
    assert!(live.contains(&unowned.0.id()));
    assert!(!live.contains(&owned_pid));
    owned.child.kill().await.expect("stop owned child");
    owned.child.wait().await.expect("reap owned child");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn bash_background_group_remains_identified_after_shell_exits() {
    let registry = ChildRegistry::default();
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args(["-c", "sleep 60 &"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let mut owned = registry.spawn_bash(&mut command).expect("bash child");
    let group = owned.child.id().expect("bash pid");
    let _cleanup = TestGroup(i32::try_from(group).unwrap());
    assert!(owned.child.wait().await.expect("bash exit").success());
    drop(owned);
    assert_eq!(registry.live_background_groups().unwrap(), vec![group]);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn managed_server_idle_process_is_not_a_writer_but_its_child_is() {
    let registry = ChildRegistry::default();
    let mut command = tokio::process::Command::new("/bin/sh");
    command
        .args(["-c", "sleep 60 & wait"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    let mut owned = registry
        .spawn_managed(&mut command, "server-a")
        .expect("managed child");
    let group = owned.child.id().expect("managed pid");
    let _cleanup = TestGroup(i32::try_from(group).unwrap());
    let deadline = Instant::now() + Duration::from_secs(5);
    while registry.live_managed_work().unwrap().is_empty() {
        assert!(Instant::now() < deadline, "managed child never appeared");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(registry.live_managed_work().unwrap(), vec!["server-a"]);
    let stopped = registry.spawn_managed(
        tokio::process::Command::new("/bin/sleep")
            .arg("60")
            .process_group(0),
        "server-b",
    );
    let mut idle = stopped.expect("idle managed child");
    let idle_group = idle.child.id().expect("idle pid");
    let _idle_cleanup = TestGroup(i32::try_from(idle_group).unwrap());
    assert_eq!(registry.live_managed_work().unwrap(), vec!["server-a"]);
    owned.child.kill().await.expect("stop managed leader");
    owned.child.wait().await.expect("reap managed leader");
    idle.child.kill().await.expect("stop idle leader");
    idle.child.wait().await.expect("reap idle leader");
}
