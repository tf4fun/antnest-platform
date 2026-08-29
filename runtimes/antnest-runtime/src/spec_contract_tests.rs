use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

use crate::spec::{
    FilesystemSpec, NetworkMode, NetworkSpec, RuntimeIdentity, RuntimeSpec, UdpEndpoint,
};

#[test]
fn runtime_spec_is_the_domain_authority() {
    let identity = RuntimeIdentity::new("agent-1", 7).expect("identity");
    let endpoint =
        UdpEndpoint::new(SocketAddrV4::new(Ipv4Addr::new(192, 0, 2, 10), 8092)).expect("endpoint");
    let network = NetworkSpec::unrestricted(
        endpoint,
        Ipv4Addr::new(100, 96, 0, 2),
        Ipv4Addr::new(100, 64, 0, 1),
    )
    .expect("network");
    let filesystem = FilesystemSpec::new("/agent-home", "/skills").expect("filesystem");
    let spec = RuntimeSpec::new(
        identity.clone(),
        "0.0.0.0:8093".parse::<SocketAddr>().unwrap(),
        network,
        filesystem,
    )
    .expect("RuntimeSpec");

    assert_eq!(spec.identity(), &identity);
    assert_eq!(spec.network().mode(), NetworkMode::Unrestricted);
    assert!(spec.network().egress_endpoint().is_some());
    assert_eq!(spec.filesystem().workspace().to_str(), Some("/agent-home"));
}

#[test]
fn runtime_spec_rejects_an_unusable_listener() {
    let identity = RuntimeIdentity::new("agent-1", 7).expect("identity");
    let network =
        NetworkSpec::restricted(Ipv4Addr::new(100, 96, 0, 2), Ipv4Addr::new(100, 64, 0, 1))
            .expect("network");
    let filesystem = FilesystemSpec::new("/agent-home", "/skills").expect("filesystem");
    assert!(
        RuntimeSpec::new(
            identity,
            "0.0.0.0:0".parse::<SocketAddr>().unwrap(),
            network,
            filesystem,
        )
        .is_err()
    );
}
