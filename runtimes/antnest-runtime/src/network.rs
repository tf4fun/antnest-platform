use std::net::{IpAddr, Ipv4Addr};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PlatformRoute {
    interface: String,
    network: Ipv4Addr,
    prefix_len: u8,
}

impl PlatformRoute {
    pub(crate) fn new(
        interface: String,
        network: Ipv4Addr,
        prefix_len: u8,
    ) -> Result<Self, &'static str> {
        if interface.is_empty() || prefix_len > 32 {
            return Err("platform route is invalid");
        }
        let mask = prefix_mask(prefix_len);
        if u32::from(network) & mask != u32::from(network) {
            return Err("platform route network has host bits");
        }
        Ok(Self {
            interface,
            network,
            prefix_len,
        })
    }

    #[cfg(test)]
    pub(crate) fn cidr(&self) -> String {
        format!("{}/{}", self.network, self.prefix_len)
    }

    fn contains(&self, address: Ipv4Addr) -> bool {
        let mask = prefix_mask(self.prefix_len);
        u32::from(address) & mask == u32::from(self.network)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub(crate) struct PlatformNetwork {
    routes: Vec<PlatformRoute>,
}

impl PlatformNetwork {
    pub(crate) fn new(routes: Vec<PlatformRoute>) -> Self {
        Self { routes }
    }

    pub(crate) fn contains(&self, address: IpAddr) -> bool {
        match address {
            IpAddr::V4(address) => {
                address.is_loopback() || self.routes.iter().any(|route| route.contains(address))
            }
            IpAddr::V6(address) => address.is_loopback(),
        }
    }
}

fn prefix_mask(prefix_len: u8) -> u32 {
    if prefix_len == 0 {
        0
    } else {
        u32::MAX << (32 - prefix_len)
    }
}

#[cfg(any(target_os = "linux", test))]
fn kill_switch_rules(tun_name: &str, mcp_port: u16) -> String {
    format!(
        "table inet antnest_runtime {{\n\
           chain output {{ type filter hook output priority -100; policy accept; \
             meta skuid 1000 meta nfproto ipv6 counter drop; \
             meta skuid 1000 tcp dport {} counter drop; \
             meta skuid 1000 ip daddr 127.0.0.11 counter drop; \
             meta skuid 1000 oifname \"lo\" counter accept; \
             meta skuid 1000 oifname \"{}\" counter accept; \
             meta skuid 1000 counter drop; \
             meta skuid 2000-2007 meta nfproto ipv6 counter drop; \
             meta skuid 2000-2007 tcp dport {mcp_port} counter drop; \
             meta skuid 2000-2007 ip daddr 127.0.0.11 counter drop; \
             meta skuid 2000-2007 oifname \"lo\" counter accept; \
             meta skuid 2000-2007 oifname \"{tun_name}\" counter accept; \
             meta skuid 2000-2007 counter drop; \
           }}\n\
           chain input {{ type filter hook input priority -100; policy accept; \
             iifname \"{}\" tcp dport {} counter drop; \
           }}\n\
         }}",
        mcp_port, tun_name, tun_name, mcp_port,
    )
}

#[cfg(test)]
mod tests {
    use super::kill_switch_rules;

    #[test]
    fn kill_switch_classifies_executor_traffic_by_uid() {
        let rules = kill_switch_rules("antnest0", 8093);

        assert!(rules.contains("meta skuid 1000 meta nfproto ipv6 counter drop"));
        assert!(rules.contains("meta skuid 1000 tcp dport 8093 counter drop"));
        assert!(rules.contains("meta skuid 1000 ip daddr 127.0.0.11 counter drop"));
        assert!(rules.contains("meta skuid 1000 oifname \"lo\" counter accept"));
        assert!(rules.contains("meta skuid 1000 oifname \"antnest0\" counter accept"));
        assert!(rules.contains("meta skuid 1000 counter drop"));
        assert!(rules.contains("iifname \"antnest0\" tcp dport 8093 counter drop"));
        assert!(rules.contains("meta skuid 2000-2007 tcp dport 8093 counter drop"));
        assert!(rules.contains("meta skuid 2000-2007 ip daddr 127.0.0.11 counter drop"));
        assert!(rules.contains("meta skuid 2000-2007 oifname \"lo\" counter accept"));
        assert!(rules.contains("meta skuid 2000-2007 oifname \"antnest0\" counter accept"));
        assert!(rules.contains("meta skuid 2000-2007 counter drop"));
        assert!(!rules.contains("meta mark"));
        assert!(!rules.contains("172.30.0.0/16"));
    }

    fn assert_embedded_dns_drop_precedes_loopback(uid: &str) {
        let rules = kill_switch_rules("antnest0", 8093);
        let drop = format!("meta skuid {uid} ip daddr 127.0.0.11 counter drop");
        let accept = format!("meta skuid {uid} oifname \"lo\" counter accept");
        let drop_position = rules
            .find(&drop)
            .expect("protocol-independent Docker DNS drop missing");
        let accept_position = rules.find(&accept).expect("loopback accept missing");
        assert!(
            drop_position < accept_position,
            "Docker DNS drop must precede loopback accept"
        );
    }

    #[test]
    fn executor_docker_dns_drop_covers_tcp_and_udp_before_loopback_accept() {
        assert_embedded_dns_drop_precedes_loopback("1000");
    }

    #[test]
    fn tool_docker_dns_drop_covers_tcp_and_udp_before_loopback_accept() {
        assert_embedded_dns_drop_precedes_loopback("2000-2007");
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use std::ffi::{CStr, CString};
    use std::fs::{self, File, OpenOptions};
    use std::io::{self, Write};
    use std::mem;
    use std::net::Ipv4Addr;
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::fs::OpenOptionsExt;
    use std::path::Path;
    use std::ptr;

    use thiserror::Error;

    use crate::spec::{NetworkSpec, UdpEndpoint};

    use super::{PlatformNetwork, PlatformRoute, kill_switch_rules};

    pub const TUN_NAME: &str = "antnest0";
    const IFREQ_DATA_SIZE: usize = 24;
    const IFF_TUN: libc::c_short = 0x0001;
    const IFF_NO_PI: libc::c_short = 0x1000;
    const RTF_UP: libc::c_ushort = 0x0001;
    const AGENT_ROUTE_TABLE: &str = "18953";
    const AGENT_RULE_PRIORITY: &str = "18953";

    #[repr(C)]
    struct IfReq {
        name: [libc::c_char; libc::IFNAMSIZ],
        data: [u8; IFREQ_DATA_SIZE],
    }

    #[derive(Debug, Error)]
    pub enum NetworkError {
        #[error("{operation}: {source}")]
        System {
            operation: &'static str,
            #[source]
            source: io::Error,
        },
        #[error("{0}")]
        Invalid(String),
        #[error("nftables rejected the runtime kill-switch: {0}")]
        Nftables(String),
    }

    pub struct RuntimeNetwork {
        tun: File,
        mtu: u16,
        platform: PlatformNetwork,
        egress_endpoint: UdpEndpoint,
        tunnel_ipv4: Ipv4Addr,
    }

    pub(crate) struct NetworkTransport {
        pub(crate) tun: File,
        pub(crate) mtu: u16,
        pub(crate) egress_endpoint: UdpEndpoint,
        pub(crate) tunnel_ipv4: Ipv4Addr,
    }

    impl RuntimeNetwork {
        pub fn bootstrap(spec: &NetworkSpec, mcp_port: u16) -> Result<Self, NetworkError> {
            let route_target = *spec.egress_endpoint().address().ip();
            let platform_routes = read_platform_routes(route_target)?;
            configure_resolver(spec.resolver_ipv4())?;
            let tun = create_tun(TUN_NAME, crate::packet::INNER_MTU, spec.tunnel_ipv4())?;
            install_routes(TUN_NAME, spec.tunnel_ipv4())?;
            install_kill_switch(TUN_NAME, mcp_port)?;
            let platform = PlatformNetwork::new(platform_routes);
            Ok(Self {
                tun,
                mtu: crate::packet::INNER_MTU,
                platform,
                egress_endpoint: spec.egress_endpoint().clone(),
                tunnel_ipv4: spec.tunnel_ipv4(),
            })
        }

        pub fn platform_network(&self) -> &PlatformNetwork {
            &self.platform
        }

        pub(crate) fn into_transport(self) -> NetworkTransport {
            NetworkTransport {
                tun: self.tun,
                mtu: self.mtu,
                egress_endpoint: self.egress_endpoint,
                tunnel_ipv4: self.tunnel_ipv4,
            }
        }
    }

    fn create_tun(name: &str, mtu: u16, address: Ipv4Addr) -> Result<File, NetworkError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .custom_flags(libc::O_CLOEXEC | libc::O_NONBLOCK)
            .open("/dev/net/tun")
            .map_err(|source| system("open /dev/net/tun", source))?;
        let mut request = ifreq(name)?;
        request.data[..2].copy_from_slice(&(IFF_TUN | IFF_NO_PI).to_ne_bytes());
        ioctl(
            file.as_raw_fd(),
            libc::TUNSETIFF as libc::c_ulong,
            &mut request,
            "create TUN interface",
        )?;

        let socket =
            unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM | libc::SOCK_CLOEXEC, 0) };
        if socket < 0 {
            return Err(system(
                "open network configuration socket",
                io::Error::last_os_error(),
            ));
        }
        let result = configure_interface(socket, name, mtu, address);
        unsafe { libc::close(socket) };
        result?;
        Ok(file)
    }

    fn configure_interface(
        socket: RawFd,
        name: &str,
        mtu: u16,
        address: Ipv4Addr,
    ) -> Result<(), NetworkError> {
        let mut mtu_request = ifreq(name)?;
        mtu_request.data[..4].copy_from_slice(&(i32::from(mtu)).to_ne_bytes());
        ioctl(
            socket,
            libc::SIOCSIFMTU as libc::c_ulong,
            &mut mtu_request,
            "set TUN MTU",
        )?;

        let mut address_request = ifreq(name)?;
        write_sockaddr(&mut address_request.data, address);
        ioctl(
            socket,
            libc::SIOCSIFADDR as libc::c_ulong,
            &mut address_request,
            "set TUN IPv4 address",
        )?;

        let mut mask_request = ifreq(name)?;
        write_sockaddr(&mut mask_request.data, Ipv4Addr::new(255, 255, 255, 255));
        ioctl(
            socket,
            libc::SIOCSIFNETMASK as libc::c_ulong,
            &mut mask_request,
            "set TUN IPv4 netmask",
        )?;

        let mut flags_request = ifreq(name)?;
        ioctl(
            socket,
            libc::SIOCGIFFLAGS as libc::c_ulong,
            &mut flags_request,
            "read TUN flags",
        )?;
        let flags = libc::c_short::from_ne_bytes([flags_request.data[0], flags_request.data[1]])
            | libc::IFF_UP as i16;
        flags_request.data[..2].copy_from_slice(&flags.to_ne_bytes());
        ioctl(
            socket,
            libc::SIOCSIFFLAGS as libc::c_ulong,
            &mut flags_request,
            "bring TUN up",
        )?;
        Ok(())
    }

    fn read_platform_routes(control: Ipv4Addr) -> Result<Vec<PlatformRoute>, NetworkError> {
        let routes = fs::read_to_string("/proc/net/route")
            .map_err(|source| system("read /proc/net/route", source))?;
        parse_platform_routes(&routes, control)
    }

    fn parse_platform_routes(
        routes: &str,
        control: Ipv4Addr,
    ) -> Result<Vec<PlatformRoute>, NetworkError> {
        let control = u32::from(control);
        let mut control_reachable = false;
        let mut platform = Vec::new();
        for line in routes.lines().skip(1) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() < 8 {
                continue;
            }
            let flags = u16::from_str_radix(fields[3], 16)
                .map_err(|error| NetworkError::Invalid(format!("parse route flags: {error}")))?;
            if flags & RTF_UP == 0 {
                continue;
            }
            let destination = parse_route_address(fields[1], "destination")?;
            let mask = parse_route_address(fields[7], "mask")?;
            if control & mask == destination {
                control_reachable = true;
            }
            if destination != 0 || mask != 0 {
                let prefix_len = contiguous_prefix(mask)?;
                let platform_route = PlatformRoute::new(
                    fields[0].to_owned(),
                    Ipv4Addr::from(destination & mask),
                    prefix_len,
                )
                .map_err(|error| NetworkError::Invalid(error.into()))?;
                if !platform.contains(&platform_route) {
                    platform.push(platform_route);
                }
            }
        }
        if !control_reachable {
            return Err(NetworkError::Invalid(
                "container has no IPv4 route to the control endpoint".into(),
            ));
        }
        Ok(platform)
    }

    fn contiguous_prefix(mask: u32) -> Result<u8, NetworkError> {
        let prefix_len = mask.leading_ones() as u8;
        if mask != super::prefix_mask(prefix_len) {
            return Err(NetworkError::Invalid(format!(
                "route mask {mask:#010x} is not contiguous"
            )));
        }
        Ok(prefix_len)
    }

    fn parse_route_address(value: &str, field: &str) -> Result<u32, NetworkError> {
        u32::from_str_radix(value, 16)
            .map(u32::swap_bytes)
            .map_err(|error| NetworkError::Invalid(format!("parse route {field}: {error}")))
    }

    fn install_routes(tun_name: &str, tunnel_ipv4: Ipv4Addr) -> Result<(), NetworkError> {
        for arguments in route_cleanup_commands(tun_name, tunnel_ipv4) {
            let _ = run_ip(&arguments, true)?;
        }
        let rule_output = run_ip(&reserved_rule_query(), false)?;
        if !rule_output.stdout.is_empty() {
            return Err(NetworkError::Invalid(
                "Runtime-owned policy-rule priority is already used".into(),
            ));
        }
        let route_output = run_ip(&all_route_tables_query(), false)?;
        if reserved_route_table_is_used(&route_output.stdout) {
            return Err(NetworkError::Invalid(
                "Runtime-owned routing table identifier is already used".into(),
            ));
        }
        for arguments in agent_route_commands(tun_name, tunnel_ipv4) {
            let _ = run_ip(&arguments, false)?;
        }
        Ok(())
    }

    fn run_ip(
        arguments: &[String],
        tolerate_failure: bool,
    ) -> Result<std::process::Output, NetworkError> {
        let output = std::process::Command::new("/sbin/ip")
            .args(arguments)
            .output()
            .map_err(|source| system("execute iproute2", source))?;
        if output.status.success() || tolerate_failure {
            return Ok(output);
        }
        Err(NetworkError::Invalid(format!(
            "ip {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        )))
    }

    fn route_cleanup_commands(tun_name: &str, tunnel_ipv4: Ipv4Addr) -> Vec<Vec<String>> {
        let command =
            |arguments: &[&str]| arguments.iter().map(|value| (*value).to_owned()).collect();
        let tunnel_ipv4 = tunnel_ipv4.to_string();
        vec![
            command(&[
                "rule",
                "del",
                "pref",
                AGENT_RULE_PRIORITY,
                "uidrange",
                "1000-1000",
                "lookup",
                AGENT_ROUTE_TABLE,
            ]),
            command(&[
                "rule",
                "del",
                "pref",
                AGENT_RULE_PRIORITY,
                "from",
                &tunnel_ipv4,
                "lookup",
                AGENT_ROUTE_TABLE,
            ]),
            command(&[
                "rule",
                "del",
                "pref",
                AGENT_RULE_PRIORITY,
                "uidrange",
                "2000-2007",
                "lookup",
                AGENT_ROUTE_TABLE,
            ]),
            command(&[
                "route",
                "del",
                "table",
                AGENT_ROUTE_TABLE,
                "default",
                "dev",
                tun_name,
                "metric",
                "10",
            ]),
            command(&[
                "route",
                "del",
                "table",
                AGENT_ROUTE_TABLE,
                "unreachable",
                "default",
                "metric",
                "32767",
            ]),
        ]
    }

    fn reserved_rule_query() -> Vec<String> {
        let command =
            |arguments: &[&str]| arguments.iter().map(|value| (*value).to_owned()).collect();
        command(&["-o", "rule", "show", "priority", AGENT_RULE_PRIORITY])
    }

    fn all_route_tables_query() -> Vec<String> {
        ["-o", "route", "show", "table", "all"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    fn reserved_route_table_is_used(output: &[u8]) -> bool {
        String::from_utf8_lossy(output).lines().any(|line| {
            let fields = line.split_whitespace().collect::<Vec<_>>();
            fields
                .windows(2)
                .any(|field| field == ["table", AGENT_ROUTE_TABLE])
        })
    }

    fn agent_route_commands(tun_name: &str, tunnel_ipv4: Ipv4Addr) -> Vec<Vec<String>> {
        let command =
            |arguments: &[&str]| arguments.iter().map(|value| (*value).to_owned()).collect();
        let tunnel_ipv4 = tunnel_ipv4.to_string();
        vec![
            command(&[
                "route",
                "add",
                "table",
                AGENT_ROUTE_TABLE,
                "default",
                "dev",
                tun_name,
                "metric",
                "10",
            ]),
            command(&[
                "route",
                "add",
                "table",
                AGENT_ROUTE_TABLE,
                "unreachable",
                "default",
                "metric",
                "32767",
            ]),
            command(&[
                "rule",
                "add",
                "pref",
                AGENT_RULE_PRIORITY,
                "uidrange",
                "1000-1000",
                "lookup",
                AGENT_ROUTE_TABLE,
            ]),
            command(&[
                "rule",
                "add",
                "pref",
                AGENT_RULE_PRIORITY,
                "uidrange",
                "2000-2007",
                "lookup",
                AGENT_ROUTE_TABLE,
            ]),
            // Reverse-path filtering validates a reply arriving on TUN with a
            // uid-less lookup sourced from the Tunnel IPv4. Without this rule
            // that lookup misses the uid rules, finds no route in main, and
            // the kernel drops the reply when rp_filter is 1 or 2.
            command(&[
                "rule",
                "add",
                "pref",
                AGENT_RULE_PRIORITY,
                "from",
                &tunnel_ipv4,
                "lookup",
                AGENT_ROUTE_TABLE,
            ]),
        ]
    }

    fn configure_resolver(resolver: Ipv4Addr) -> Result<(), NetworkError> {
        configure_resolver_file(Path::new("/etc/resolv.conf"), resolver)
    }

    fn configure_resolver_file(path: &Path, resolver: Ipv4Addr) -> Result<(), NetworkError> {
        let document = format!("options use-vc\nnameserver {resolver}\n");
        let mut file = OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .map_err(|source| system("open Agent resolver for reconciliation", source))?;
        file.write_all(document.as_bytes())
            .map_err(|source| system("write Agent resolver", source))?;
        file.sync_all()
            .map_err(|source| system("flush Agent resolver", source))?;
        drop(file);

        let contents = fs::read_to_string(path)
            .map_err(|source| system("read reconciled Agent resolver", source))?;
        validate_resolver_contents(&contents, resolver)
    }

    fn validate_resolver_contents(contents: &str, resolver: Ipv4Addr) -> Result<(), NetworkError> {
        let nameservers: Vec<_> = contents
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("nameserver "))
            .map(|line| line.trim_start_matches("nameserver ").trim())
            .collect();
        let resolver = resolver.to_string();
        if nameservers != [resolver.as_str()] {
            return Err(NetworkError::Invalid(format!(
                "immutable Agent resolver mismatch: expected only {resolver}"
            )));
        }
        let use_vc = contents
            .lines()
            .map(str::trim)
            .filter_map(|line| line.strip_prefix("options "))
            .flat_map(str::split_whitespace)
            .any(|option| option == "use-vc");
        if !use_vc {
            return Err(NetworkError::Invalid(
                "immutable Agent resolver must force DNS over TCP with use-vc".into(),
            ));
        }
        Ok(())
    }

    fn install_kill_switch(tun_name: &str, mcp_port: u16) -> Result<(), NetworkError> {
        let context = NftContext::new()?;
        let _ = context.run("delete table inet antnest_runtime");
        context.run(&kill_switch_rules(tun_name, mcp_port))
    }

    fn ifreq(name: &str) -> Result<IfReq, NetworkError> {
        let bytes = name.as_bytes();
        if bytes.is_empty() || bytes.len() >= libc::IFNAMSIZ {
            return Err(NetworkError::Invalid(format!(
                "invalid interface name {name:?}"
            )));
        }
        let mut request = IfReq {
            name: [0; libc::IFNAMSIZ],
            data: [0; IFREQ_DATA_SIZE],
        };
        for (target, source) in request.name.iter_mut().zip(bytes) {
            *target = *source as libc::c_char;
        }
        Ok(request)
    }

    fn write_sockaddr(target: &mut [u8], address: Ipv4Addr) {
        let value = sockaddr_in(address);
        let length = mem::size_of::<libc::sockaddr_in>();
        unsafe {
            ptr::copy_nonoverlapping(
                (&value as *const libc::sockaddr_in).cast::<u8>(),
                target.as_mut_ptr(),
                length,
            );
        }
    }

    fn sockaddr_in(address: Ipv4Addr) -> libc::sockaddr_in {
        libc::sockaddr_in {
            sin_family: libc::AF_INET as libc::sa_family_t,
            sin_port: 0,
            sin_addr: libc::in_addr {
                s_addr: u32::from_ne_bytes(address.octets()),
            },
            sin_zero: [0; 8],
        }
    }

    fn ioctl(
        fd: RawFd,
        request: libc::c_ulong,
        value: &mut IfReq,
        operation: &'static str,
    ) -> Result<(), NetworkError> {
        if unsafe { libc::ioctl(fd, request, value) } != 0 {
            return Err(system(operation, io::Error::last_os_error()));
        }
        Ok(())
    }

    fn system(operation: &'static str, source: io::Error) -> NetworkError {
        NetworkError::System { operation, source }
    }

    #[link(name = "nftables")]
    unsafe extern "C" {
        fn nft_ctx_new(flags: u32) -> *mut libc::c_void;
        fn nft_ctx_free(context: *mut libc::c_void);
        fn nft_ctx_buffer_output(context: *mut libc::c_void) -> bool;
        fn nft_ctx_buffer_error(context: *mut libc::c_void) -> bool;
        fn nft_ctx_get_error_buffer(context: *mut libc::c_void) -> *const libc::c_char;
        fn nft_run_cmd_from_buffer(
            context: *mut libc::c_void,
            command: *const libc::c_char,
        ) -> libc::c_int;
    }

    struct NftContext(*mut libc::c_void);

    impl NftContext {
        fn new() -> Result<Self, NetworkError> {
            let context = unsafe { nft_ctx_new(0) };
            if context.is_null() {
                return Err(NetworkError::Nftables("create libnftables context".into()));
            }
            unsafe {
                nft_ctx_buffer_output(context);
                nft_ctx_buffer_error(context);
            }
            Ok(Self(context))
        }

        fn run(&self, command: &str) -> Result<(), NetworkError> {
            let command = CString::new(command)
                .map_err(|_| NetworkError::Invalid("nftables command contains NUL".into()))?;
            if unsafe { nft_run_cmd_from_buffer(self.0, command.as_ptr()) } == 0 {
                return Ok(());
            }
            let message = unsafe {
                let buffer = nft_ctx_get_error_buffer(self.0);
                if buffer.is_null() {
                    "unknown libnftables error".to_owned()
                } else {
                    CStr::from_ptr(buffer).to_string_lossy().trim().to_owned()
                }
            };
            Err(NetworkError::Nftables(message))
        }
    }

    impl Drop for NftContext {
        fn drop(&mut self) {
            unsafe { nft_ctx_free(self.0) };
        }
    }

    const _: () = assert!(mem::size_of::<IfReq>() == 40);

    #[cfg(test)]
    mod tests {
        use std::net::Ipv4Addr;

        use super::{
            agent_route_commands, all_route_tables_query, configure_resolver_file,
            parse_platform_routes, reserved_route_table_is_used, route_cleanup_commands,
            validate_resolver_contents,
        };

        #[test]
        fn control_route_does_not_require_a_default_route() {
            let routes = "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n\
                          eth0 00FF1EAC 00000000 0001 0 0 0 00FFFFFF 0 0 0\n";
            let platform = parse_platform_routes(routes, Ipv4Addr::new(172, 30, 255, 2)).unwrap();

            assert_eq!(platform.len(), 1);
            assert_eq!(platform[0].interface, "eth0");
            assert_eq!(platform[0].cidr(), "172.30.255.0/24");
        }

        #[test]
        fn control_route_prefers_connected_subnet_over_default() {
            let routes = "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n\
                          eth0 00000000 01001EAC 0003 0 0 0 00000000 0 0 0\n\
                          eth1 00FF1EAC 00000000 0001 0 0 0 00FFFFFF 0 0 0\n";
            let platform = parse_platform_routes(routes, Ipv4Addr::new(172, 30, 255, 2)).unwrap();

            assert_eq!(platform.len(), 1);
            assert_eq!(platform[0].interface, "eth1");
            assert_eq!(platform[0].cidr(), "172.30.255.0/24");
        }

        #[test]
        fn resolver_accepts_only_the_virtual_tun_dns() {
            let resolver = Ipv4Addr::new(100, 64, 0, 1);
            validate_resolver_contents("nameserver 100.64.0.1\noptions use-vc\n", resolver)
                .unwrap();
            assert!(
                validate_resolver_contents(
                    "nameserver 127.0.0.11\noptions use-vc ndots:0\n# ExtServers: [100.64.0.1]\n",
                    resolver,
                )
                .is_err()
            );
            assert!(validate_resolver_contents("nameserver 100.64.0.1\n", resolver).is_err());
        }

        #[test]
        fn resolver_reconciliation_replaces_the_docker_stub() {
            let directory = tempfile::tempdir().expect("temporary resolver directory");
            let path = directory.path().join("resolv.conf");
            std::fs::write(
                &path,
                "nameserver 127.0.0.11\noptions use-vc ndots:0\n# ExtServers: [100.64.0.1]\n",
            )
            .expect("write Docker resolver stub");

            configure_resolver_file(&path, Ipv4Addr::new(100, 64, 0, 1))
                .expect("reconcile resolver");

            assert_eq!(
                std::fs::read_to_string(path).expect("read reconciled resolver"),
                "options use-vc\nnameserver 100.64.0.1\n"
            );
        }

        #[test]
        fn uid_policy_route_never_replaces_the_platform_default_route() {
            let commands = agent_route_commands("antnest0", Ipv4Addr::new(100, 64, 0, 2));
            let expected = |values: &[&str]| {
                values
                    .iter()
                    .map(|value| (*value).to_owned())
                    .collect::<Vec<_>>()
            };
            assert!(commands.contains(&expected(&[
                "rule",
                "add",
                "pref",
                "18953",
                "uidrange",
                "1000-1000",
                "lookup",
                "18953",
            ])));
            assert!(commands.contains(&expected(&[
                "route", "add", "table", "18953", "default", "dev", "antnest0", "metric", "10",
            ])));
            assert!(commands.contains(&expected(&[
                "route",
                "add",
                "table",
                "18953",
                "unreachable",
                "default",
                "metric",
                "32767",
            ])));
            assert!(
                commands
                    .iter()
                    .any(|command| command.contains(&"2000-2007".to_owned()))
            );
            assert!(!commands.iter().flatten().any(|value| value == "main"));
            let cleanup = route_cleanup_commands("antnest0", Ipv4Addr::new(100, 64, 0, 2));
            assert!(
                !cleanup
                    .iter()
                    .any(|command| command.contains(&"flush".to_owned()))
            );
            assert!(cleanup[0].contains(&"uidrange".to_owned()));
            assert!(cleanup[0].contains(&"lookup".to_owned()));
            assert_eq!(
                all_route_tables_query(),
                ["-o", "route", "show", "table", "all"]
            );
            assert!(reserved_route_table_is_used(
                b"default dev antnest0 table 18953 metric 10\n"
            ));
            assert!(!reserved_route_table_is_used(
                b"default via 172.30.0.1 dev eth0\nlocal 127.0.0.0/8 dev lo table local\n"
            ));
        }

        #[test]
        fn tunnel_replies_pass_reverse_path_filtering_through_the_agent_table() {
            let tunnel = Ipv4Addr::new(100, 64, 0, 2);
            let rule = ["pref", "18953", "from", "100.64.0.2", "lookup", "18953"];
            let with_action = |action: &str| {
                ["rule", action]
                    .iter()
                    .chain(rule.iter())
                    .map(|value| (*value).to_owned())
                    .collect::<Vec<_>>()
            };
            assert!(agent_route_commands("antnest0", tunnel).contains(&with_action("add")));
            assert!(route_cleanup_commands("antnest0", tunnel).contains(&with_action("del")));
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod platform {
    use thiserror::Error;

    use crate::spec::NetworkSpec;

    use super::PlatformNetwork;

    #[derive(Debug, Error)]
    #[error("antnest-runtime network bootstrap requires Linux")]
    pub struct NetworkError;

    pub struct RuntimeNetwork;

    impl RuntimeNetwork {
        pub fn bootstrap(_spec: &NetworkSpec, _mcp_port: u16) -> Result<Self, NetworkError> {
            Err(NetworkError)
        }

        pub fn platform_network(&self) -> &PlatformNetwork {
            unreachable!("Linux-only runtime")
        }
    }
}

pub use platform::*;
