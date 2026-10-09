use std::{net::Ipv4Addr, time::Duration};

use async_trait::async_trait;
use ipnet::Ipv4Net;
use thiserror::Error;

use crate::application::KernelCleanup;
pub use platform::TunDevice;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KernelPlan {
    tun_name: String,
    tunnel_cidr: Ipv4Net,
    resolver_ipv4: Ipv4Addr,
    inner_mtu: usize,
}

#[derive(Debug, Error)]
pub enum KernelError {
    #[error("invalid Egress kernel plan: {0}")]
    InvalidPlan(&'static str),
    #[error("Egress kernel setup is supported only on Linux")]
    UnsupportedPlatform,
    #[error("Egress TUN operation failed: {0}")]
    Tun(String),
    #[error("IPv4 forwarding is disabled in the Egress network namespace")]
    ForwardingDisabled,
    #[error("Egress kernel command failed: {0}")]
    Command(String),
}

impl KernelPlan {
    pub fn new(
        tun_name: impl Into<String>,
        tunnel_cidr: Ipv4Net,
        resolver_ipv4: Ipv4Addr,
        inner_mtu: usize,
    ) -> Result<Self, KernelError> {
        let tun_name = tun_name.into();
        if tun_name.is_empty() || tun_name.len() > 15 {
            return Err(KernelError::InvalidPlan("invalid TUN name"));
        }
        if !tunnel_cidr.contains(&resolver_ipv4)
            || resolver_ipv4 == tunnel_cidr.network()
            || resolver_ipv4 == tunnel_cidr.broadcast()
        {
            return Err(KernelError::InvalidPlan(
                "resolver is not a usable pool address",
            ));
        }
        if !(576..=65_507).contains(&inner_mtu) {
            return Err(KernelError::InvalidPlan("invalid inner MTU"));
        }
        Ok(Self {
            tun_name,
            tunnel_cidr,
            resolver_ipv4,
            inner_mtu,
        })
    }

    pub fn setup_commands(&self) -> Vec<Vec<String>> {
        vec![
            strings([
                "ip".to_owned(),
                "address".to_owned(),
                "replace".to_owned(),
                format!("{}/{}", self.resolver_ipv4, self.tunnel_cidr.prefix_len()),
                "dev".to_owned(),
                self.tun_name.clone(),
            ]),
            strings([
                "ip".to_owned(),
                "link".to_owned(),
                "set".to_owned(),
                "dev".to_owned(),
                self.tun_name.clone(),
                "mtu".to_owned(),
                self.inner_mtu.to_string(),
                "up".to_owned(),
            ]),
            strings([
                "ip".to_owned(),
                "route".to_owned(),
                "replace".to_owned(),
                self.tunnel_cidr.to_string(),
                "dev".to_owned(),
                self.tun_name.clone(),
            ]),
        ]
    }

    pub fn tun_name(&self) -> &str {
        &self.tun_name
    }

    pub fn tunnel_cidr(&self) -> Ipv4Net {
        self.tunnel_cidr
    }
}

fn strings<const N: usize>(values: [String; N]) -> Vec<String> {
    values.into_iter().collect()
}

pub fn nft_rules(
    tun_name: &str,
    tunnel_cidr: Ipv4Net,
    resolver_ipv4: Ipv4Addr,
    connected: &[Ipv4Net],
) -> String {
    let protected = protected_ipv4_networks(tunnel_cidr, connected);
    let destinations = protected
        .iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        r#"table ip antnest_egress {{
  chain forward {{
    type filter hook forward priority filter; policy drop;
    iifname "{tun_name}" ip daddr {{ {destinations} }} counter drop
    iifname "{tun_name}" ip saddr {tunnel_cidr} meta l4proto tcp accept
    oifname "{tun_name}" ip daddr {tunnel_cidr} ct state established,related accept
  }}
  chain input {{
    type filter hook input priority filter; policy accept;
    iifname "{tun_name}" ip saddr {tunnel_cidr} ip daddr {resolver_ipv4} tcp dport 53 accept
    iifname "{tun_name}" drop
  }}
  chain postrouting {{
    type nat hook postrouting priority srcnat; policy accept;
    ip saddr {tunnel_cidr} masquerade
  }}
}}
"#
    )
}

fn protected_ipv4_networks(tunnel_cidr: Ipv4Net, connected: &[Ipv4Net]) -> Vec<Ipv4Net> {
    let mut networks = crate::policy::PROTECTED_IPV4_NETWORKS.to_vec();
    networks.push(tunnel_cidr);
    networks.extend_from_slice(connected);
    networks.sort_by_key(|network| (network.prefix_len(), network.network()));
    let mut protected: Vec<Ipv4Net> = Vec::new();
    for network in networks {
        if !protected.iter().any(|existing| existing.contains(&network)) {
            protected.push(network);
        }
    }
    protected
}

pub fn connected_ipv4_subnets(routes: &str) -> Result<Vec<Ipv4Net>, KernelError> {
    let mut lines = routes.lines();
    if lines
        .next()
        .is_none_or(|header| !header.starts_with("Iface"))
    {
        return Err(KernelError::Command(
            "invalid IPv4 route table header".to_owned(),
        ));
    }
    let invalid = || KernelError::Command("invalid IPv4 connected route".to_owned());
    let mut networks = Vec::new();
    for line in lines.filter(|line| !line.trim().is_empty()) {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 8 {
            return Err(invalid());
        }
        let destination = u32::from_str_radix(fields[1], 16).map_err(|_| invalid())?;
        let gateway = u32::from_str_radix(fields[2], 16).map_err(|_| invalid())?;
        let flags = u32::from_str_radix(fields[3], 16).map_err(|_| invalid())?;
        if destination == 0 || gateway != 0 || flags & 1 == 0 {
            continue;
        }
        let mask = u32::from_str_radix(fields[7], 16)
            .map_err(|_| invalid())?
            .to_ne_bytes();
        let mask = u32::from_be_bytes(mask);
        let prefix = mask.leading_ones();
        if mask != u32::MAX.checked_shl(32 - prefix).unwrap_or(0) {
            return Err(invalid());
        }
        let address = Ipv4Addr::from(destination.to_ne_bytes());
        let network = Ipv4Net::new(address, prefix as u8)
            .map_err(|_| invalid())?
            .trunc();
        networks.push(network);
    }
    Ok(networks)
}

#[cfg(any(target_os = "linux", test))]
fn require_ipv4_forwarding(value: &str) -> Result<(), KernelError> {
    if value.trim() == "1" {
        Ok(())
    } else {
        Err(KernelError::ForwardingDisabled)
    }
}

#[cfg(test)]
mod tests {
    use super::{KernelError, require_ipv4_forwarding};

    #[test]
    fn deployment_must_enable_ipv4_forwarding() {
        assert!(require_ipv4_forwarding("1\n").is_ok());
        assert!(matches!(
            require_ipv4_forwarding("0\n"),
            Err(KernelError::ForwardingDisabled)
        ));
    }
}

#[derive(Clone)]
pub struct LinuxKernel {
    tunnel_cidr: Ipv4Net,
    command_timeout: Duration,
    protected_networks: Vec<Ipv4Net>,
}

impl LinuxKernel {
    pub async fn bootstrap(
        plan: &KernelPlan,
        command_timeout: Duration,
    ) -> Result<(Self, TunDevice), KernelError> {
        let device = platform::create_tun(plan.tun_name()).await?;
        let protected_networks = platform::configure(plan, command_timeout).await?;
        Ok((
            Self {
                tunnel_cidr: plan.tunnel_cidr(),
                command_timeout,
                protected_networks,
            },
            device,
        ))
    }

    pub async fn clear_all(&self) -> Result<(), KernelError> {
        platform::clear_conntrack(&self.tunnel_cidr.to_string(), self.command_timeout).await
    }

    pub fn protected_ipv4_networks(&self) -> &[Ipv4Net] {
        &self.protected_networks
    }
}

#[async_trait]
impl KernelCleanup for LinuxKernel {
    async fn clear_agent(&self, address: Ipv4Addr) -> Result<(), String> {
        platform::clear_conntrack(&address.to_string(), self.command_timeout)
            .await
            .map_err(|error| error.to_string())
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::{
        fs::{File, OpenOptions},
        io,
        os::{fd::AsRawFd, unix::fs::OpenOptionsExt},
        process::Stdio,
        time::Duration,
    };

    use async_trait::async_trait;
    use tokio::{
        io::{AsyncRead, AsyncReadExt, AsyncWriteExt, unix::AsyncFd},
        process::{Child, Command},
        time::timeout,
    };

    use super::{KernelError, KernelPlan, nft_rules, protected_ipv4_networks};
    use crate::network::PacketDevice;
    use ipnet::Ipv4Net;

    const TUNSETIFF: libc::c_ulong = 0x4004_54ca;
    const IFF_TUN: i16 = 0x0001;
    const IFF_NO_PI: i16 = 0x1000;
    const IFNAMSIZ: usize = 16;
    const IFREQ_UNION_SIZE: usize = 24;

    #[repr(C)]
    struct IfReq {
        name: [libc::c_char; IFNAMSIZ],
        data: [u8; IFREQ_UNION_SIZE],
    }

    pub struct TunDevice(AsyncFd<File>);

    #[async_trait]
    impl PacketDevice for TunDevice {
        async fn read_packet(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            loop {
                let mut ready = self.0.readable().await?;
                match ready.try_io(|inner| read_fd(inner.get_ref(), buffer)) {
                    Ok(result) => return result,
                    Err(_) => continue,
                }
            }
        }

        async fn write_packet(&mut self, mut packet: &[u8]) -> io::Result<()> {
            while !packet.is_empty() {
                let mut ready = self.0.writable().await?;
                let written = match ready.try_io(|inner| write_fd(inner.get_ref(), packet)) {
                    Ok(result) => result?,
                    Err(_) => continue,
                };
                if written == 0 {
                    return Err(io::ErrorKind::WriteZero.into());
                }
                packet = &packet[written..];
            }
            Ok(())
        }
    }

    pub(super) async fn create_tun(name: &str) -> Result<TunDevice, KernelError> {
        let device = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_CLOEXEC)
            .open("/dev/net/tun")
            .map_err(|error| KernelError::Tun(format!("open /dev/net/tun: {error}")))?;
        let mut request = IfReq {
            name: [0; IFNAMSIZ],
            data: [0; IFREQ_UNION_SIZE],
        };
        for (target, source) in request.name.iter_mut().zip(name.bytes()) {
            *target = source as libc::c_char;
        }
        request.data[..2].copy_from_slice(&(IFF_TUN | IFF_NO_PI).to_ne_bytes());
        // SAFETY: `request` has the Linux `ifreq` ABI layout, the file descriptor
        // owns `/dev/net/tun`, and both remain valid for the duration of ioctl.
        let result = unsafe { libc::ioctl(device.as_raw_fd(), TUNSETIFF, &mut request) };
        if result < 0 {
            return Err(KernelError::Tun(format!(
                "create TUN {name}: {}",
                io::Error::last_os_error()
            )));
        }
        AsyncFd::new(device)
            .map(TunDevice)
            .map_err(|error| KernelError::Tun(format!("register TUN {name}: {error}")))
    }

    fn read_fd(file: &File, buffer: &mut [u8]) -> io::Result<usize> {
        let result =
            unsafe { libc::read(file.as_raw_fd(), buffer.as_mut_ptr().cast(), buffer.len()) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as usize)
        }
    }

    fn write_fd(file: &File, packet: &[u8]) -> io::Result<usize> {
        let result = unsafe { libc::write(file.as_raw_fd(), packet.as_ptr().cast(), packet.len()) };
        if result < 0 {
            Err(io::Error::last_os_error())
        } else {
            Ok(result as usize)
        }
    }

    pub(super) async fn configure(
        plan: &KernelPlan,
        command_timeout: Duration,
    ) -> Result<Vec<Ipv4Net>, KernelError> {
        let forwarding = timeout(
            command_timeout,
            tokio::fs::read_to_string("/proc/sys/net/ipv4/ip_forward"),
        )
        .await
        .map_err(|_| KernelError::Command("read net.ipv4.ip_forward timed out".to_owned()))?
        .map_err(|error| KernelError::Command(format!("read net.ipv4.ip_forward: {error}")))?;
        super::require_ipv4_forwarding(&forwarding)?;
        for command in plan.setup_commands() {
            run(&command[0], &command[1..], None, command_timeout, false).await?;
        }
        let delete = [
            "delete".to_owned(),
            "table".to_owned(),
            "ip".to_owned(),
            "antnest_egress".to_owned(),
        ];
        run("nft", &delete, None, command_timeout, true).await?;
        let routes = timeout(
            command_timeout,
            tokio::fs::read_to_string("/proc/net/route"),
        )
        .await
        .map_err(|_| KernelError::Command("IPv4 subnet discovery timed out".to_owned()))?
        .map_err(|_| KernelError::Command("IPv4 subnet discovery failed".to_owned()))?;
        let connected = super::connected_ipv4_subnets(&routes)?;
        let rules = nft_rules(
            plan.tun_name(),
            plan.tunnel_cidr(),
            plan.resolver_ipv4,
            &connected,
        );
        run(
            "nft",
            &["-f".to_owned(), "-".to_owned()],
            Some(rules.as_bytes()),
            command_timeout,
            false,
        )
        .await?;
        clear_conntrack(&plan.tunnel_cidr().to_string(), command_timeout).await?;
        Ok(protected_ipv4_networks(plan.tunnel_cidr(), &connected))
    }

    pub(super) async fn clear_conntrack(
        source: &str,
        command_timeout: Duration,
    ) -> Result<(), KernelError> {
        for direction in ["-s", "-d"] {
            run(
                "conntrack",
                &[
                    "-D".to_owned(),
                    direction.to_owned(),
                    source.to_owned(),
                    "-p".to_owned(),
                    "tcp".to_owned(),
                ],
                None,
                command_timeout,
                true,
            )
            .await?;
        }
        Ok(())
    }

    async fn run(
        program: &str,
        arguments: &[String],
        input: Option<&[u8]>,
        deadline: Duration,
        allow_no_match: bool,
    ) -> Result<(), KernelError> {
        let mut command = Command::new(program);
        command
            .args(arguments)
            .kill_on_drop(true)
            .process_group(0)
            .stdout(Stdio::null())
            .stderr(Stdio::piped());
        if input.is_some() {
            command.stdin(Stdio::piped());
        }
        let mut child = command
            .spawn()
            .map_err(|error| KernelError::Command(format!("start {program}: {error}")))?;
        let stderr = child.stderr.take().expect("stderr is configured as a pipe");
        let stderr_task = tokio::spawn(read_bounded(stderr, 2048));
        if let (Some(bytes), Some(mut stdin)) = (input, child.stdin.take()) {
            match timeout(deadline, stdin.write_all(bytes)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    terminate(&mut child).await;
                    let _ = stderr_task.await;
                    return Err(KernelError::Command(format!(
                        "write {program} input: {error}"
                    )));
                }
                Err(_) => {
                    terminate(&mut child).await;
                    let _ = stderr_task.await;
                    return Err(KernelError::Command(format!("{program} timed out")));
                }
            }
        }
        let status = match timeout(deadline, child.wait()).await {
            Ok(result) => result
                .map_err(|error| KernelError::Command(format!("wait for {program}: {error}")))?,
            Err(_) => {
                terminate(&mut child).await;
                let _ = stderr_task.await;
                return Err(KernelError::Command(format!("{program} timed out")));
            }
        };
        let stderr = stderr_task
            .await
            .map_err(|error| KernelError::Command(format!("read {program} stderr: {error}")))?
            .map_err(|error| KernelError::Command(format!("read {program} stderr: {error}")))?;
        if status.success() || (allow_no_match && status.code() == Some(1)) {
            return Ok(());
        }
        let stderr = String::from_utf8_lossy(&stderr);
        let stderr = stderr.trim();
        Err(KernelError::Command(format!(
            "{program} exited with {}: {stderr}",
            status
        )))
    }

    async fn terminate(child: &mut Child) {
        if let Some(process_id) = child.id() {
            let result = unsafe { libc::kill(-(process_id as i32), libc::SIGKILL) };
            if result < 0 {
                tracing::warn!(error = %io::Error::last_os_error(), "failed to kill kernel command process group");
            }
        }
        if let Err(error) = child.wait().await {
            tracing::warn!(%error, "failed to reap timed-out kernel command");
        }
    }

    async fn read_bounded(mut reader: impl AsyncRead + Unpin, limit: usize) -> io::Result<Vec<u8>> {
        let mut captured = Vec::with_capacity(limit);
        let mut buffer = [0_u8; 1024];
        loop {
            let read = reader.read(&mut buffer).await?;
            if read == 0 {
                return Ok(captured);
            }
            let remaining = limit.saturating_sub(captured.len());
            captured.extend_from_slice(&buffer[..read.min(remaining)]);
        }
    }

    #[cfg(test)]
    mod tests {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/integration/runtime-egress/kernel_process.rs"
        ));
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use std::{io, time::Duration};

    use super::{KernelError, KernelPlan};
    use crate::network::PacketDevice;
    use async_trait::async_trait;

    pub struct TunDevice;

    #[async_trait]
    impl PacketDevice for TunDevice {
        async fn read_packet(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "TUN is supported only on Linux",
            ))
        }

        async fn write_packet(&mut self, _: &[u8]) -> io::Result<()> {
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "TUN is supported only on Linux",
            ))
        }
    }

    pub(super) async fn create_tun(_: &str) -> Result<TunDevice, KernelError> {
        Err(KernelError::UnsupportedPlatform)
    }

    pub(super) async fn configure(
        _: &KernelPlan,
        _: Duration,
    ) -> Result<Vec<ipnet::Ipv4Net>, KernelError> {
        Err(KernelError::UnsupportedPlatform)
    }

    pub(super) async fn clear_conntrack(_: &str, _: Duration) -> Result<(), KernelError> {
        Err(KernelError::UnsupportedPlatform)
    }
}
