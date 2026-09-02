use std::net::Ipv4Addr;

use antnest_runtime_egress::packet::{
    INNER_MTU, PACKET_CONTRACT_REVISION, PacketError, TcpFlags, parse_ipv4_tcp, tcp_reset,
};
use serde::Deserialize;

#[derive(Deserialize)]
struct PacketFixtures {
    contract: String,
    fixtures: Vec<PacketFixture>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PacketContract {
    revision: u32,
    transport: String,
    inner_ip_version: u8,
    inner_transport_protocol: String,
    inner_mtu: usize,
    fragmentation: bool,
    one_packet_per_datagram: bool,
    readiness_probe: ReadinessProbe,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReadinessProbe {
    destination_ipv4: String,
    destination_port: u16,
    source_port_min: u16,
    request_flags: Vec<String>,
    request_acknowledgement: u32,
    request_payload_bytes: usize,
    response_flags: Vec<String>,
    local_response_only: bool,
}

#[derive(Deserialize)]
struct PacketFixture {
    name: String,
    accepted: bool,
    hex: String,
}

#[test]
fn shared_fixtures_define_the_egress_packet_boundary() {
    let fixtures: PacketFixtures = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/packet-fixtures.json"
    )))
    .expect("packet fixtures");
    assert_eq!(fixtures.contract, "raw-ipv4-tcp-over-udp");
    let contract: PacketContract = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../contracts/runtime/packet-contract.json"
    )))
    .expect("packet contract");
    assert_eq!(contract.revision, PACKET_CONTRACT_REVISION);
    assert_eq!(contract.transport, "raw-ip-over-udp");
    assert_eq!(contract.inner_ip_version, 4);
    assert_eq!(contract.inner_transport_protocol, "tcp");
    assert_eq!(contract.inner_mtu, INNER_MTU);
    assert!(!contract.fragmentation);
    assert!(contract.one_packet_per_datagram);
    assert_eq!(contract.readiness_probe.destination_ipv4, "192.0.2.1");
    assert_eq!(contract.readiness_probe.destination_port, 9);
    assert_eq!(contract.readiness_probe.source_port_min, 49_152);
    assert_eq!(contract.readiness_probe.request_flags, ["syn"]);
    assert_eq!(contract.readiness_probe.request_acknowledgement, 0);
    assert_eq!(contract.readiness_probe.request_payload_bytes, 0);
    assert_eq!(contract.readiness_probe.response_flags, ["rst", "ack"]);
    assert!(contract.readiness_probe.local_response_only);

    for fixture in fixtures.fixtures {
        let packet = decode_hex(&fixture.hex).expect("fixture hex");
        assert_eq!(
            parse_ipv4_tcp(&packet, contract.inner_mtu).is_ok(),
            fixture.accepted,
            "{}",
            fixture.name
        );
    }
}

#[test]
fn parser_exposes_the_complete_flow_identity() {
    let packet = decode_hex(
        "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000",
    )
    .unwrap();
    let parsed = parse_ipv4_tcp(&packet, 1400).expect("valid TCP SYN");

    assert_eq!(parsed.source, Ipv4Addr::new(100, 96, 0, 10));
    assert_eq!(parsed.destination, Ipv4Addr::new(93, 184, 216, 34));
    assert_eq!(parsed.source_port, 40_000);
    assert_eq!(parsed.destination_port, 443);
    assert!(parsed.flags.contains(TcpFlags::SYN));
    assert_eq!(parsed.flow_key().reverse(), parsed.reverse_flow_key());
}

#[test]
fn denied_syn_gets_a_valid_reverse_reset() {
    let packet = decode_hex(
        "4500002800004000400600006460000a5db8d8229c4001bb00000029000000005002000000000000",
    )
    .unwrap();
    let parsed = parse_ipv4_tcp(&packet, 1400).unwrap();
    let reset = tcp_reset(&parsed).expect("reset");
    let reply = parse_ipv4_tcp(&reset, 1400).expect("valid reset packet");

    assert_eq!(reply.source, parsed.destination);
    assert_eq!(reply.destination, parsed.source);
    assert!(reply.flags.contains(TcpFlags::RST));
    assert!(reply.flags.contains(TcpFlags::ACK));
}

#[test]
fn parser_rejects_packets_over_the_inner_mtu() {
    let packet = vec![0_u8; 1401];
    assert_eq!(parse_ipv4_tcp(&packet, 1400), Err(PacketError::InvalidSize));
}

fn decode_hex(value: &str) -> Result<Vec<u8>, String> {
    if !value.len().is_multiple_of(2) {
        return Err("odd hex length".to_owned());
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let encoded = std::str::from_utf8(pair).map_err(|error| error.to_string())?;
            u8::from_str_radix(encoded, 16).map_err(|error| error.to_string())
        })
        .collect()
}
