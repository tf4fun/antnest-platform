#[cfg(target_os = "linux")]
mod platform {
    use std::fs;
    use std::io;
    use std::mem;

    use nix::unistd::{Gid, Uid, getgid, getgroups, getuid, setgroups, setresgid, setresuid};
    use thiserror::Error;

    use crate::evidence::ProcessSnapshot;

    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;
    const EXECUTOR_UID: u32 = 1000;
    const EXECUTOR_GID: u32 = 1000;
    const EMPTY_CAPABILITIES: &str = "0000000000000000";
    const REQUIRED_SUPERVISOR_CAPABILITIES: [(&str, u32); 7] = [
        ("CAP_CHOWN", 0),
        ("CAP_DAC_OVERRIDE", 1),
        ("CAP_KILL", 5),
        ("CAP_SETGID", 6),
        ("CAP_SETUID", 7),
        ("CAP_SETPCAP", 8),
        ("CAP_NET_ADMIN", 12),
    ];

    #[repr(C)]
    struct CapHeader {
        version: u32,
        pid: i32,
    }

    #[derive(Clone, Copy, Default)]
    #[repr(C)]
    struct CapData {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }

    #[derive(Debug, Error)]
    pub enum PrivilegeError {
        #[error("runtime must start as root, got uid={0}")]
        NotRoot(u32),
        #[error("runtime serve must be container PID 1, got pid={0}")]
        NotPidOne(u32),
        #[error("privilege transition must be single-threaded, got {0} threads")]
        ThreadCount(u32),
        #[error("{operation}: {source}")]
        System {
            operation: &'static str,
            #[source]
            source: io::Error,
        },
        #[error("{0}")]
        Verification(String),
    }

    pub fn harden_entry() -> Result<ProcessSnapshot, PrivilegeError> {
        require_root()?;
        if std::process::id() != 1 {
            return Err(PrivilegeError::NotPidOne(std::process::id()));
        }
        ensure_single_threaded()?;
        set_dumpable(false)?;
        let snapshot = snapshot()?;
        verify_supervisor(&snapshot)?;
        Ok(snapshot)
    }

    pub fn enter_executor_state() -> Result<ProcessSnapshot, PrivilegeError> {
        enter_unprivileged_state(EXECUTOR_UID)
    }

    pub fn enter_managed_state(uid: u32) -> Result<ProcessSnapshot, PrivilegeError> {
        if !(2000..=2007).contains(&uid) {
            return Err(PrivilegeError::Verification(
                "managed MCP UID outside reserved range".into(),
            ));
        }
        enter_unprivileged_state(uid)
    }

    fn enter_unprivileged_state(uid: u32) -> Result<ProcessSnapshot, PrivilegeError> {
        require_root()?;
        ensure_single_threaded()?;
        set_dumpable(false)?;
        setgroups(&[]).map_err(|error| system_nix("clear supplementary groups", error))?;
        clear_ambient_capabilities()?;
        drop_capability_bounding_set()?;
        setresgid(
            Gid::from_raw(EXECUTOR_GID),
            Gid::from_raw(EXECUTOR_GID),
            Gid::from_raw(EXECUTOR_GID),
        )
        .map_err(|error| system_nix("drop executor gid", error))?;
        setresuid(Uid::from_raw(uid), Uid::from_raw(uid), Uid::from_raw(uid))
            .map_err(|error| system_nix("drop executor uid", error))?;
        set_capabilities_raw(&[]).map_err(|source| PrivilegeError::System {
            operation: "clear executor capabilities",
            source,
        })?;
        prctl(
            libc::PR_SET_NO_NEW_PRIVS,
            1,
            0,
            0,
            0,
            "enable executor no-new-privileges",
        )?;
        set_dumpable(false)?;
        let final_state = snapshot()?;
        verify_unprivileged(&final_state, uid)?;
        unsafe {
            libc::umask(0o007);
        }
        Ok(final_state)
    }

    pub fn close_untrusted_fds() -> Result<(), PrivilegeError> {
        let result = unsafe { libc::syscall(libc::SYS_close_range, 3_u32, u32::MAX, 0_u32) };
        if result == 0 {
            return Ok(());
        }
        let source = io::Error::last_os_error();
        if source.raw_os_error() != Some(libc::ENOSYS) {
            return Err(PrivilegeError::System {
                operation: "close inherited executor descriptors",
                source,
            });
        }

        let descriptors = fs::read_dir("/proc/self/fd")
            .map_err(|source| PrivilegeError::System {
                operation: "enumerate inherited executor descriptors",
                source,
            })?
            .filter_map(Result::ok)
            .filter_map(|entry| entry.file_name().to_string_lossy().parse::<i32>().ok())
            .filter(|descriptor| *descriptor > libc::STDERR_FILENO)
            .collect::<Vec<_>>();
        for descriptor in descriptors {
            if unsafe { libc::close(descriptor) } != 0 {
                let source = io::Error::last_os_error();
                if source.raw_os_error() != Some(libc::EBADF) {
                    return Err(PrivilegeError::System {
                        operation: "close inherited executor descriptor",
                        source,
                    });
                }
            }
        }
        Ok(())
    }

    pub fn snapshot() -> Result<ProcessSnapshot, PrivilegeError> {
        let status =
            fs::read_to_string("/proc/self/status").map_err(|source| PrivilegeError::System {
                operation: "read /proc/self/status",
                source,
            })?;
        let groups = getgroups()
            .map_err(|error| system_nix("read supplementary groups", error))?
            .into_iter()
            .map(|group| group.as_raw())
            .collect();
        Ok(ProcessSnapshot {
            uid: getuid().as_raw(),
            gid: getgid().as_raw(),
            supplementary_groups: groups,
            effective_capabilities: status_value(&status, "CapEff:")?,
            permitted_capabilities: status_value(&status, "CapPrm:")?,
            inheritable_capabilities: status_value(&status, "CapInh:")?,
            ambient_capabilities: status_value(&status, "CapAmb:")?,
            bounding_capabilities: status_value(&status, "CapBnd:")?,
            secure_bits: prctl_get(libc::PR_GET_SECUREBITS, "read securebits")? as u64,
            dumpable: prctl_get(libc::PR_GET_DUMPABLE, "read dumpability")? != 0,
            no_new_privileges: prctl_get(libc::PR_GET_NO_NEW_PRIVS, "read no-new-privileges")? != 0,
            thread_count: thread_count()?,
        })
    }

    fn verify_unprivileged(snapshot: &ProcessSnapshot, uid: u32) -> Result<(), PrivilegeError> {
        if snapshot.uid != uid || snapshot.gid != EXECUTOR_GID {
            return Err(PrivilegeError::Verification(format!(
                "executor identity is {}:{}, expected {uid}:{EXECUTOR_GID}",
                snapshot.uid, snapshot.gid
            )));
        }
        if !snapshot.supplementary_groups.is_empty() {
            return Err(PrivilegeError::Verification(
                "executor supplementary groups are not empty".into(),
            ));
        }
        for (name, value) in [
            ("effective", &snapshot.effective_capabilities),
            ("permitted", &snapshot.permitted_capabilities),
            ("inheritable", &snapshot.inheritable_capabilities),
            ("ambient", &snapshot.ambient_capabilities),
            ("bounding", &snapshot.bounding_capabilities),
        ] {
            if value != EMPTY_CAPABILITIES {
                return Err(PrivilegeError::Verification(format!(
                    "executor {name} capabilities are {value}"
                )));
            }
        }
        if snapshot.dumpable || !snapshot.no_new_privileges || snapshot.thread_count != 1 {
            return Err(PrivilegeError::Verification(
                "executor dumpability, NNP, or thread count is invalid".into(),
            ));
        }
        Ok(())
    }

    fn verify_supervisor(snapshot: &ProcessSnapshot) -> Result<(), PrivilegeError> {
        let effective = parse_capabilities("effective", &snapshot.effective_capabilities)?;
        let permitted = parse_capabilities("permitted", &snapshot.permitted_capabilities)?;
        for (name, capability) in REQUIRED_SUPERVISOR_CAPABILITIES {
            let mask = 1_u64 << capability;
            if effective & mask == 0 || permitted & mask == 0 {
                return Err(PrivilegeError::Verification(format!(
                    "runtime Supervisor requires {name} in its effective and permitted sets"
                )));
            }
        }
        Ok(())
    }

    fn parse_capabilities(name: &str, value: &str) -> Result<u64, PrivilegeError> {
        u64::from_str_radix(value, 16).map_err(|error| {
            PrivilegeError::Verification(format!(
                "runtime Supervisor {name} capabilities are invalid: {error}"
            ))
        })
    }

    fn require_root() -> Result<(), PrivilegeError> {
        let uid = getuid().as_raw();
        if uid == 0 {
            Ok(())
        } else {
            Err(PrivilegeError::NotRoot(uid))
        }
    }

    fn clear_ambient_capabilities() -> Result<(), PrivilegeError> {
        prctl(
            libc::PR_CAP_AMBIENT,
            libc::PR_CAP_AMBIENT_CLEAR_ALL as libc::c_ulong,
            0,
            0,
            0,
            "clear ambient capabilities",
        )
    }

    fn drop_capability_bounding_set() -> Result<(), PrivilegeError> {
        let cap_last = fs::read_to_string("/proc/sys/kernel/cap_last_cap")
            .map_err(|source| PrivilegeError::System {
                operation: "read cap_last_cap",
                source,
            })?
            .trim()
            .parse::<u32>()
            .map_err(|error| {
                PrivilegeError::Verification(format!("parse cap_last_cap: {error}"))
            })?;
        for capability in 0..=cap_last {
            prctl(
                libc::PR_CAPBSET_DROP,
                capability as libc::c_ulong,
                0,
                0,
                0,
                "drop executor capability from bounding set",
            )?;
        }
        Ok(())
    }

    fn set_capabilities_raw(capabilities: &[u32]) -> io::Result<()> {
        let header = CapHeader {
            version: LINUX_CAPABILITY_VERSION_3,
            pid: 0,
        };
        let mut data = [CapData::default(), CapData::default()];
        for capability in capabilities {
            let index = (*capability / 32) as usize;
            let bit = 1_u32 << (*capability % 32);
            data[index].effective |= bit;
            data[index].permitted |= bit;
        }
        let result =
            unsafe { libc::syscall(libc::SYS_capset, &header as *const CapHeader, data.as_ptr()) };
        if result == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn ensure_single_threaded() -> Result<(), PrivilegeError> {
        let count = thread_count()?;
        if count == 1 {
            Ok(())
        } else {
            Err(PrivilegeError::ThreadCount(count))
        }
    }

    fn thread_count() -> Result<u32, PrivilegeError> {
        let count = fs::read_dir("/proc/self/task")
            .map_err(|source| PrivilegeError::System {
                operation: "read /proc/self/task",
                source,
            })?
            .count();
        u32::try_from(count)
            .map_err(|_| PrivilegeError::Verification("thread count overflow".into()))
    }

    fn status_value(status: &str, name: &'static str) -> Result<String, PrivilegeError> {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
            .map(str::to_owned)
            .ok_or_else(|| PrivilegeError::Verification(format!("/proc/self/status has no {name}")))
    }

    fn set_dumpable(enabled: bool) -> Result<(), PrivilegeError> {
        prctl(
            libc::PR_SET_DUMPABLE,
            enabled.into(),
            0,
            0,
            0,
            "set process dumpability",
        )
    }

    fn prctl(
        option: libc::c_int,
        arg2: libc::c_ulong,
        arg3: libc::c_ulong,
        arg4: libc::c_ulong,
        arg5: libc::c_ulong,
        operation: &'static str,
    ) -> Result<(), PrivilegeError> {
        if unsafe { libc::prctl(option, arg2, arg3, arg4, arg5) } == 0 {
            Ok(())
        } else {
            Err(PrivilegeError::System {
                operation,
                source: io::Error::last_os_error(),
            })
        }
    }

    fn prctl_get(
        option: libc::c_int,
        operation: &'static str,
    ) -> Result<libc::c_int, PrivilegeError> {
        let result = unsafe { libc::prctl(option, 0, 0, 0, 0) };
        if result >= 0 {
            Ok(result)
        } else {
            Err(PrivilegeError::System {
                operation,
                source: io::Error::last_os_error(),
            })
        }
    }

    fn system_nix(operation: &'static str, error: nix::errno::Errno) -> PrivilegeError {
        PrivilegeError::System {
            operation,
            source: io::Error::from_raw_os_error(error as i32),
        }
    }

    const _: () = assert!(mem::size_of::<CapData>() == 12);

    #[cfg(test)]
    mod tests {
        use super::{ProcessSnapshot, verify_supervisor};

        #[test]
        fn supervisor_requires_cross_uid_process_control() {
            let mut snapshot = supervisor_snapshot();
            verify_supervisor(&snapshot).expect("complete Supervisor capability set");

            let without_kill =
                u64::from_str_radix(&snapshot.effective_capabilities, 16).unwrap() & !(1_u64 << 5);
            snapshot.effective_capabilities = format!("{without_kill:016x}");
            assert!(
                verify_supervisor(&snapshot)
                    .expect_err("CAP_KILL must be required")
                    .to_string()
                    .contains("CAP_KILL")
            );
        }

        fn supervisor_snapshot() -> ProcessSnapshot {
            let capabilities = (1_u64 << 0)
                | (1_u64 << 1)
                | (1_u64 << 5)
                | (1_u64 << 6)
                | (1_u64 << 7)
                | (1_u64 << 8)
                | (1_u64 << 12);
            ProcessSnapshot {
                uid: 0,
                gid: 0,
                supplementary_groups: Vec::new(),
                effective_capabilities: format!("{capabilities:016x}"),
                permitted_capabilities: format!("{capabilities:016x}"),
                inheritable_capabilities: "0000000000000000".into(),
                ambient_capabilities: "0000000000000000".into(),
                bounding_capabilities: format!("{capabilities:016x}"),
                secure_bits: 0,
                dumpable: false,
                no_new_privileges: false,
                thread_count: 1,
            }
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use thiserror::Error;

    use crate::evidence::ProcessSnapshot;

    #[derive(Debug, Error)]
    #[error("antnest-runtime requires Linux")]
    pub struct PrivilegeError;

    pub fn harden_entry() -> Result<ProcessSnapshot, PrivilegeError> {
        Err(PrivilegeError)
    }

    pub fn enter_executor_state() -> Result<ProcessSnapshot, PrivilegeError> {
        Err(PrivilegeError)
    }

    pub fn enter_managed_state(_uid: u32) -> Result<ProcessSnapshot, PrivilegeError> {
        Err(PrivilegeError)
    }

    pub fn close_untrusted_fds() -> Result<(), PrivilegeError> {
        Err(PrivilegeError)
    }

    pub fn snapshot() -> Result<ProcessSnapshot, PrivilegeError> {
        Err(PrivilegeError)
    }
}

pub use platform::*;
