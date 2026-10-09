use std::{fs, io};

pub fn check_startup() -> io::Result<()> {
    check_status(&fs::read_to_string("/proc/self/status")?)
}

fn check_status(status: &str) -> io::Result<()> {
    let field = |name| {
        status
            .lines()
            .find_map(|line| line.strip_prefix(name))
            .map(str::trim)
            .ok_or_else(|| io::Error::other(format!("process status is missing {name}")))
    };
    let identity = |name| -> io::Result<u32> {
        field(name)?
            .split_whitespace()
            .nth(1)
            .and_then(|value| value.parse().ok())
            .ok_or_else(|| io::Error::other(format!("process status has invalid {name}")))
    };
    let uid = identity("Uid:")?;
    let gid = identity("Gid:")?;
    let effective = u64::from_str_radix(field("CapEff:")?, 16)
        .map_err(|_| io::Error::other("process status has invalid CapEff"))?;
    tracing::info!(
        uid,
        gid,
        effective_capabilities = %format!("{effective:016x}"),
        "Runtime Egress process privileges"
    );
    if effective & (1 << 12) == 0 {
        return Err(io::Error::other(
            "Runtime Egress requires effective CAP_NET_ADMIN",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::check_status;

    fn status(capabilities: &str) -> String {
        format!("Uid:\t1000\t0\t0\t0\nGid:\t1000\t0\t0\t0\nCapEff:\t{capabilities}\n")
    }

    #[test]
    fn startup_requires_effective_net_admin() {
        for capabilities in ["0000000000000000", "0000000000000001"] {
            let error = check_status(&status(capabilities)).expect_err("missing CAP_NET_ADMIN");
            assert!(error.to_string().contains("CAP_NET_ADMIN"));
        }
        check_status(&status("0000000000001000")).unwrap();
    }

    #[test]
    fn startup_logs_effective_identity_and_capability_set() {
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let writer = output.clone();
        let subscriber = tracing_subscriber::fmt()
            .json()
            .with_ansi(false)
            .with_writer(move || LogWriter(writer.clone()))
            .finish();
        tracing::subscriber::with_default(subscriber, || {
            check_status(&status("0000000000001001")).unwrap();
        });
        let bytes = output.lock().unwrap();
        let record: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(record["fields"]["uid"], 0);
        assert_eq!(record["fields"]["gid"], 0);
        assert_eq!(
            record["fields"]["effective_capabilities"],
            "0000000000001001"
        );
    }

    #[test]
    fn unreadable_privilege_fields_fail_closed() {
        for input in [
            "",
            "Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\n",
            "Uid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nCapEff:\tnot-hex\n",
            "Uid:\t0\tinvalid\t0\t0\nGid:\t0\t0\t0\t0\nCapEff:\t1000\n",
        ] {
            assert!(check_status(input).is_err(), "accepted {input:?}");
        }
    }

    struct LogWriter(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for LogWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            std::io::Write::write(&mut *self.0.lock().unwrap(), bytes)
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
}
