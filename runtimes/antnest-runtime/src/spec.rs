use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use std::path::{Path, PathBuf};

use thiserror::Error;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RuntimeIdentity {
    agent_id: String,
    generation: u64,
}

impl RuntimeIdentity {
    pub(crate) fn new(agent_id: impl Into<String>, generation: u64) -> Result<Self, SpecError> {
        let agent_id = agent_id.into();
        if agent_id.is_empty()
            || agent_id.len() > 255
            || !agent_id.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(SpecError::Identity(
                "Agent ID must contain 1-255 visible ASCII bytes",
            ));
        }
        if generation == 0 {
            return Err(SpecError::Identity("generation must be positive"));
        }
        Ok(Self {
            agent_id,
            generation,
        })
    }

    pub(crate) fn agent_id(&self) -> &str {
        &self.agent_id
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
}

#[derive(Debug)]
pub(crate) struct RuntimeSpec {
    identity: RuntimeIdentity,
    listen: SocketAddr,
    network: NetworkSpec,
    filesystem: FilesystemSpec,
    mcp_servers: Vec<crate::managed_mcp::spec::ServerSpec>,
}

impl RuntimeSpec {
    pub(crate) fn new(
        identity: RuntimeIdentity,
        listen: SocketAddr,
        network: NetworkSpec,
        filesystem: FilesystemSpec,
    ) -> Result<Self, SpecError> {
        if listen.port() == 0 {
            return Err(SpecError::Listen("listen port must be non-zero"));
        }
        Ok(Self {
            identity,
            listen,
            network,
            filesystem,
            mcp_servers: Vec::new(),
        })
    }

    pub(crate) fn identity(&self) -> &RuntimeIdentity {
        &self.identity
    }

    pub(crate) fn listen(&self) -> SocketAddr {
        self.listen
    }

    pub(crate) fn network(&self) -> &NetworkSpec {
        &self.network
    }

    pub(crate) fn filesystem(&self) -> &FilesystemSpec {
        &self.filesystem
    }

    pub(crate) fn with_mcp_servers(
        mut self,
        servers: Vec<crate::managed_mcp::spec::ServerSpec>,
    ) -> Self {
        self.mcp_servers = servers;
        self
    }

    pub(crate) fn mcp_servers(&self) -> &[crate::managed_mcp::spec::ServerSpec] {
        &self.mcp_servers
    }
}

#[derive(Debug)]
pub(crate) struct NetworkSpec {
    egress_endpoint: UdpEndpoint,
    tunnel_ipv4: Ipv4Addr,
    resolver_ipv4: Ipv4Addr,
}

impl NetworkSpec {
    pub(crate) fn new(
        egress_endpoint: UdpEndpoint,
        tunnel_ipv4: Ipv4Addr,
        resolver_ipv4: Ipv4Addr,
    ) -> Result<Self, SpecError> {
        validate_usable_ipv4(tunnel_ipv4)?;
        validate_usable_ipv4(resolver_ipv4)?;
        if tunnel_ipv4 == resolver_ipv4 {
            return Err(SpecError::Network(
                "tunnel and resolver addresses must differ",
            ));
        }
        Ok(Self {
            egress_endpoint,
            tunnel_ipv4,
            resolver_ipv4,
        })
    }

    pub(crate) fn tunnel_ipv4(&self) -> Ipv4Addr {
        self.tunnel_ipv4
    }

    pub(crate) fn resolver_ipv4(&self) -> Ipv4Addr {
        self.resolver_ipv4
    }

    pub(crate) fn egress_endpoint(&self) -> &UdpEndpoint {
        &self.egress_endpoint
    }
}

#[derive(Debug)]
pub(crate) struct FilesystemSpec {
    workspace: PathBuf,
    system_skills: PathBuf,
}

impl FilesystemSpec {
    pub(crate) fn new(
        workspace: impl Into<PathBuf>,
        system_skills: impl Into<PathBuf>,
    ) -> Result<Self, SpecError> {
        let workspace = workspace.into();
        let system_skills = system_skills.into();
        validate_root("workspace", &workspace)?;
        validate_root("system_skills", &system_skills)?;
        if workspace.starts_with(&system_skills) || system_skills.starts_with(&workspace) {
            return Err(SpecError::Filesystem(
                "workspace and system Skill roots must not overlap",
            ));
        }
        Ok(Self {
            workspace,
            system_skills,
        })
    }

    pub(crate) fn workspace(&self) -> &Path {
        &self.workspace
    }

    pub(crate) fn system_skills(&self) -> &Path {
        &self.system_skills
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UdpEndpoint {
    address: SocketAddrV4,
}

impl UdpEndpoint {
    pub(crate) fn new(address: SocketAddrV4) -> Result<Self, SpecError> {
        validate_usable_ipv4(*address.ip())?;
        if address.port() == 0 {
            return Err(SpecError::Network("egress endpoint port must be non-zero"));
        }
        Ok(Self { address })
    }

    pub(crate) fn address(&self) -> SocketAddrV4 {
        self.address
    }
}

fn validate_usable_ipv4(address: Ipv4Addr) -> Result<(), SpecError> {
    if address.is_unspecified() || address.is_multicast() || address.is_broadcast() {
        return Err(SpecError::Network(
            "address must be a usable unicast IPv4 address",
        ));
    }
    Ok(())
}

fn validate_root(name: &'static str, path: &Path) -> Result<(), SpecError> {
    if !path.is_absolute() {
        return Err(SpecError::Filesystem(match name {
            "workspace" => "workspace root must be absolute",
            _ => "system Skill root must be absolute",
        }));
    }
    if path.as_os_str().as_encoded_bytes().contains(&0)
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(SpecError::Filesystem(match name {
            "workspace" => "workspace root must be a normalized path",
            _ => "system Skill root must be a normalized path",
        }));
    }
    Ok(())
}

#[derive(Debug, Error)]
pub(crate) enum SpecError {
    #[error("invalid Runtime identity: {0}")]
    Identity(&'static str),
    #[error("invalid Runtime listen address: {0}")]
    Listen(&'static str),
    #[error("invalid Runtime network: {0}")]
    Network(&'static str),
    #[error("invalid Runtime filesystem: {0}")]
    Filesystem(&'static str),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filesystem_roots_are_absolute_and_disjoint() {
        assert!(FilesystemSpec::new("/workspace", "/skills").is_ok());
        assert!(FilesystemSpec::new("workspace", "/skills").is_err());
        assert!(FilesystemSpec::new("/workspace", "/workspace/skills").is_err());
        assert!(FilesystemSpec::new("/workspace/../skills", "/skills").is_err());
    }

    #[test]
    fn network_addresses_are_usable_and_distinct() {
        let tunnel = Ipv4Addr::new(198, 18, 0, 2);
        let resolver = Ipv4Addr::new(198, 18, 0, 1);
        let endpoint = UdpEndpoint::new("192.0.2.10:8092".parse().unwrap()).unwrap();
        assert!(NetworkSpec::new(endpoint.clone(), tunnel, resolver).is_ok());
        assert!(NetworkSpec::new(endpoint.clone(), tunnel, tunnel).is_err());
        assert!(NetworkSpec::new(endpoint, Ipv4Addr::UNSPECIFIED, resolver).is_err());
    }

    #[test]
    fn agent_identity_has_one_canonical_spelling() {
        assert!(RuntimeIdentity::new("agent-1", 1).is_ok());
        assert!(RuntimeIdentity::new(" agent-1", 1).is_err());
        assert!(RuntimeIdentity::new("agent 1", 1).is_err());
    }
}
