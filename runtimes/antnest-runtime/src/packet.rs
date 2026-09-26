use std::net::Ipv4Addr;

use thiserror::Error;

const IPV4_HEADER_LEN: usize = 20;
const TCP_HEADER_LEN: usize = 20;
const ICMP_HEADER_LEN: usize = 8;
const IP_PROTOCOL_ICMP: u8 = 1;
const IP_PROTOCOL_TCP: u8 = 6;
const ICMP_DESTINATION_UNREACHABLE: u8 = 3;
const ICMP_ADMINISTRATIVELY_PROHIBITED: u8 = 13;
const TCP_FLAG_FIN: u8 = 0x01;
const TCP_FLAG_SYN: u8 = 0x02;
const TCP_FLAG_RST: u8 = 0x04;
const TCP_FLAG_ACK: u8 = 0x10;
const READINESS_PROBE_SEQUENCE_BASE: u32 = 0x414e_544e;
const READINESS_PROBE_DESTINATION: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);
const READINESS_PROBE_DESTINATION_PORT: u16 = 9;
pub(crate) const INNER_MTU: u16 = 1400;
pub(crate) const PACKET_CONTRACT_REVISION: u32 = 1;

#[derive(Debug, Error)]
pub(crate) enum PacketError {
    #[error("{0}")]
    Invalid(&'static str),
}

struct Ipv4TcpPacket {
    source: [u8; 4],
    destination: [u8; 4],
    source_port: [u8; 2],
    destination_port: [u8; 2],
    sequence: u32,
    acknowledgement: u32,
    flags: u8,
    payload_len: usize,
}

pub(crate) fn unsupported_ipv4_rejection(packet: &[u8]) -> Option<Vec<u8>> {
    let ipv4 = parse_ipv4(packet)?;
    if ipv4.protocol == IP_PROTOCOL_TCP {
        return unsupported_tcp_reset(packet);
    }
    if ipv4.protocol == IP_PROTOCOL_ICMP
        && packet
            .get(ipv4.header_len)
            .is_some_and(|kind| matches!(*kind, 3 | 4 | 5 | 11 | 12))
    {
        return None;
    }
    Some(icmp_administratively_prohibited(packet, &ipv4))
}

pub(crate) fn tunnel_datagram(packet: &[u8], mtu: usize) -> Result<&[u8], PacketError> {
    if packet.is_empty() || packet.len() > mtu {
        return Err(PacketError::Invalid("inner packet size is invalid"));
    }
    if parse_ipv4_tcp(packet).is_none() {
        return Err(PacketError::Invalid(
            "inner packet is not complete unfragmented IPv4/TCP",
        ));
    }
    Ok(packet)
}

pub(crate) fn outbound_tunnel_datagram(
    packet: &[u8],
    mtu: usize,
    tunnel: Ipv4Addr,
) -> Result<&[u8], PacketError> {
    let packet = tunnel_datagram(packet, mtu)?;
    if parse_ipv4_tcp(packet).is_some_and(|parsed| parsed.source == tunnel.octets()) {
        Ok(packet)
    } else {
        Err(PacketError::Invalid(
            "inner source does not match the Runtime Tunnel IPv4",
        ))
    }
}

pub(crate) fn inbound_tunnel_datagram(
    packet: &[u8],
    mtu: usize,
    tunnel: Ipv4Addr,
) -> Result<&[u8], PacketError> {
    let packet = tunnel_datagram(packet, mtu)?;
    if parse_ipv4_tcp(packet).is_some_and(|parsed| parsed.destination == tunnel.octets()) {
        Ok(packet)
    } else {
        Err(PacketError::Invalid(
            "inner destination does not match the Runtime Tunnel IPv4",
        ))
    }
}

pub(crate) fn egress_readiness_probe(tunnel: Ipv4Addr, source_port: u16, sequence: u32) -> Vec<u8> {
    let packet_len = IPV4_HEADER_LEN + TCP_HEADER_LEN;
    let mut packet = vec![0_u8; packet_len];
    packet[0] = 0x45;
    packet[2..4].copy_from_slice(&(packet_len as u16).to_be_bytes());
    packet[6..8].copy_from_slice(&0x4000_u16.to_be_bytes());
    packet[8] = 64;
    packet[9] = IP_PROTOCOL_TCP;
    packet[12..16].copy_from_slice(&tunnel.octets());
    packet[16..20].copy_from_slice(&READINESS_PROBE_DESTINATION.octets());
    packet[IPV4_HEADER_LEN..IPV4_HEADER_LEN + 2].copy_from_slice(&source_port.to_be_bytes());
    packet[IPV4_HEADER_LEN + 2..IPV4_HEADER_LEN + 4]
        .copy_from_slice(&READINESS_PROBE_DESTINATION_PORT.to_be_bytes());
    packet[IPV4_HEADER_LEN + 4..IPV4_HEADER_LEN + 8].copy_from_slice(&sequence.to_be_bytes());
    packet[IPV4_HEADER_LEN + 12] = 5 << 4;
    packet[IPV4_HEADER_LEN + 13] = TCP_FLAG_SYN;
    packet[IPV4_HEADER_LEN + 14..IPV4_HEADER_LEN + 16].copy_from_slice(&1024_u16.to_be_bytes());
    let ip_checksum = internet_checksum(&packet[..IPV4_HEADER_LEN]);
    packet[10..12].copy_from_slice(&ip_checksum.to_be_bytes());
    let tcp_checksum = tcp_checksum(
        tunnel.octets(),
        READINESS_PROBE_DESTINATION.octets(),
        &packet[IPV4_HEADER_LEN..],
    );
    packet[IPV4_HEADER_LEN + 16..IPV4_HEADER_LEN + 18].copy_from_slice(&tcp_checksum.to_be_bytes());
    packet
}

pub(crate) fn readiness_probe_sequence(generation: u64) -> u32 {
    READINESS_PROBE_SEQUENCE_BASE ^ generation as u32
}

pub(crate) fn readiness_probe_source_port(generation: u64) -> u16 {
    const FIRST_DYNAMIC_PORT: u64 = 49_152;
    const DYNAMIC_PORT_COUNT: u64 = u16::MAX as u64 - FIRST_DYNAMIC_PORT + 1;
    (FIRST_DYNAMIC_PORT + generation % DYNAMIC_PORT_COUNT) as u16
}

pub(crate) fn is_egress_readiness_reply(
    packet: &[u8],
    tunnel: Ipv4Addr,
    source_port: u16,
    sequence: u32,
) -> bool {
    let Some(reply) = parse_ipv4_tcp(packet) else {
        return false;
    };
    reply.source == READINESS_PROBE_DESTINATION.octets()
        && reply.destination == tunnel.octets()
        && reply.source_port == READINESS_PROBE_DESTINATION_PORT.to_be_bytes()
        && reply.destination_port == source_port.to_be_bytes()
        && reply.acknowledgement == sequence.wrapping_add(1)
        && reply.flags == TCP_FLAG_RST | TCP_FLAG_ACK
}

fn unsupported_tcp_reset(packet: &[u8]) -> Option<Vec<u8>> {
    let incoming = parse_ipv4_tcp(packet)?;
    if incoming.flags & TCP_FLAG_RST != 0 {
        return None;
    }

    let reset_len = IPV4_HEADER_LEN + TCP_HEADER_LEN;
    let mut reset = vec![0_u8; reset_len];
    reset[0] = 0x45;
    reset[2..4].copy_from_slice(&(reset_len as u16).to_be_bytes());
    reset[6..8].copy_from_slice(&0x4000_u16.to_be_bytes());
    reset[8] = 64;
    reset[9] = IP_PROTOCOL_TCP;
    reset[12..16].copy_from_slice(&incoming.destination);
    reset[16..20].copy_from_slice(&incoming.source);

    let tcp = IPV4_HEADER_LEN;
    reset[tcp..tcp + 2].copy_from_slice(&incoming.destination_port);
    reset[tcp + 2..tcp + 4].copy_from_slice(&incoming.source_port);
    if incoming.flags & TCP_FLAG_ACK != 0 {
        reset[tcp + 4..tcp + 8].copy_from_slice(&incoming.acknowledgement.to_be_bytes());
        reset[tcp + 13] = TCP_FLAG_RST;
    } else {
        let acknowledged_len = incoming.payload_len as u32
            + u32::from(incoming.flags & TCP_FLAG_SYN != 0)
            + u32::from(incoming.flags & TCP_FLAG_FIN != 0);
        reset[tcp + 8..tcp + 12].copy_from_slice(
            &incoming
                .sequence
                .wrapping_add(acknowledged_len)
                .to_be_bytes(),
        );
        reset[tcp + 13] = TCP_FLAG_RST | TCP_FLAG_ACK;
    }
    reset[tcp + 12] = 5 << 4;

    let ip_checksum = internet_checksum(&reset[..IPV4_HEADER_LEN]);
    reset[10..12].copy_from_slice(&ip_checksum.to_be_bytes());
    let tcp_checksum = tcp_checksum(
        incoming.destination,
        incoming.source,
        &reset[IPV4_HEADER_LEN..],
    );
    reset[tcp + 16..tcp + 18].copy_from_slice(&tcp_checksum.to_be_bytes());
    Some(reset)
}

fn parse_ipv4_tcp(packet: &[u8]) -> Option<Ipv4TcpPacket> {
    let ipv4 = parse_ipv4(packet)?;
    if ipv4.protocol != IP_PROTOCOL_TCP || ipv4.header_len + TCP_HEADER_LEN > packet.len() {
        return None;
    }
    let tcp_header_len = usize::from(packet[ipv4.header_len + 12] >> 4) * 4;
    if tcp_header_len < TCP_HEADER_LEN || ipv4.header_len + tcp_header_len > packet.len() {
        return None;
    }
    Some(Ipv4TcpPacket {
        source: ipv4.source,
        destination: ipv4.destination,
        source_port: packet[ipv4.header_len..ipv4.header_len + 2]
            .try_into()
            .ok()?,
        destination_port: packet[ipv4.header_len + 2..ipv4.header_len + 4]
            .try_into()
            .ok()?,
        sequence: u32::from_be_bytes(
            packet[ipv4.header_len + 4..ipv4.header_len + 8]
                .try_into()
                .ok()?,
        ),
        acknowledgement: u32::from_be_bytes(
            packet[ipv4.header_len + 8..ipv4.header_len + 12]
                .try_into()
                .ok()?,
        ),
        flags: packet[ipv4.header_len + 13],
        payload_len: packet.len() - ipv4.header_len - tcp_header_len,
    })
}

struct Ipv4Packet {
    header_len: usize,
    protocol: u8,
    source: [u8; 4],
    destination: [u8; 4],
}

fn parse_ipv4(packet: &[u8]) -> Option<Ipv4Packet> {
    if packet.len() < IPV4_HEADER_LEN || packet[0] >> 4 != 4 {
        return None;
    }
    let header_len = usize::from(packet[0] & 0x0f) * 4;
    let total_len = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    let fragment = u16::from_be_bytes([packet[6], packet[7]]);
    if header_len < IPV4_HEADER_LEN
        || header_len > packet.len()
        || total_len != packet.len()
        || fragment & 0x3fff != 0
    {
        return None;
    }
    Some(Ipv4Packet {
        header_len,
        protocol: packet[9],
        source: packet[12..16].try_into().ok()?,
        destination: packet[16..20].try_into().ok()?,
    })
}

fn icmp_administratively_prohibited(packet: &[u8], incoming: &Ipv4Packet) -> Vec<u8> {
    let quote_len = (incoming.header_len + 8).min(packet.len());
    let reply_len = IPV4_HEADER_LEN + ICMP_HEADER_LEN + quote_len;
    let mut reply = vec![0_u8; reply_len];
    reply[0] = 0x45;
    reply[2..4].copy_from_slice(&(reply_len as u16).to_be_bytes());
    reply[6..8].copy_from_slice(&0x4000_u16.to_be_bytes());
    reply[8] = 64;
    reply[9] = IP_PROTOCOL_ICMP;
    reply[12..16].copy_from_slice(&incoming.destination);
    reply[16..20].copy_from_slice(&incoming.source);

    reply[IPV4_HEADER_LEN] = ICMP_DESTINATION_UNREACHABLE;
    reply[IPV4_HEADER_LEN + 1] = ICMP_ADMINISTRATIVELY_PROHIBITED;
    reply[IPV4_HEADER_LEN + ICMP_HEADER_LEN..].copy_from_slice(&packet[..quote_len]);
    let icmp_checksum = internet_checksum(&reply[IPV4_HEADER_LEN..]);
    reply[IPV4_HEADER_LEN + 2..IPV4_HEADER_LEN + 4].copy_from_slice(&icmp_checksum.to_be_bytes());
    let ip_checksum = internet_checksum(&reply[..IPV4_HEADER_LEN]);
    reply[10..12].copy_from_slice(&ip_checksum.to_be_bytes());
    reply
}

fn tcp_checksum(source: [u8; 4], destination: [u8; 4], segment: &[u8]) -> u16 {
    let mut sum = 0_u32;
    sum = checksum_add(sum, &source);
    sum = checksum_add(sum, &destination);
    sum = checksum_add(sum, &[0, IP_PROTOCOL_TCP]);
    sum = checksum_add(sum, &(segment.len() as u16).to_be_bytes());
    finish_checksum(checksum_add(sum, segment))
}

fn internet_checksum(bytes: &[u8]) -> u16 {
    finish_checksum(checksum_add(0, bytes))
}

fn checksum_add(mut sum: u32, bytes: &[u8]) -> u32 {
    let (chunks, remainder) = bytes.as_chunks::<2>();
    for chunk in chunks {
        sum += u32::from(u16::from_be_bytes(*chunk));
    }
    if let Some(value) = remainder.first() {
        sum += u32::from(*value) << 8;
    }
    sum
}

fn finish_checksum(mut sum: u32) -> u16 {
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

#[cfg(test)]
mod tests {
    use serde::Deserialize;

    use super::*;

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
    fn shared_packet_fixtures_define_the_tunnel_boundary() {
        let fixtures: PacketFixtures = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/runtime/packet-fixtures.json"
        )))
        .expect("decode packet fixtures");
        assert_eq!(fixtures.contract, "raw-ipv4-tcp-over-udp");
        let contract: PacketContract = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../contracts/runtime/packet-contract.json"
        )))
        .expect("decode packet contract");
        assert_eq!(contract.revision, PACKET_CONTRACT_REVISION);
        assert_eq!(contract.transport, "raw-ip-over-udp");
        assert_eq!(contract.inner_ip_version, 4);
        assert_eq!(contract.inner_transport_protocol, "tcp");
        assert_eq!(contract.inner_mtu, usize::from(INNER_MTU));
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
                tunnel_datagram(&packet, contract.inner_mtu).is_ok(),
                fixture.accepted,
                "{}",
                fixture.name
            );
        }
    }

    #[test]
    fn validates_only_complete_unfragmented_ipv4_tcp() {
        let mut packet = tcp_packet(TCP_FLAG_SYN, 41, 0, &[]);
        assert!(parse_ipv4_tcp(&packet).is_some());

        packet[9] = 17;
        assert!(parse_ipv4_tcp(&packet).is_none());
        packet[9] = IP_PROTOCOL_TCP;
        packet[6] = 0x20;
        assert!(parse_ipv4_tcp(&packet).is_none());
        packet[6] = 0;
        packet[IPV4_HEADER_LEN + 12] = 4 << 4;
        assert!(parse_ipv4_tcp(&packet).is_none());
    }

    #[test]
    fn one_udp_datagram_is_exactly_one_raw_ip_packet() {
        let packet = tcp_packet(TCP_FLAG_SYN, 41, 0, &[]);
        let datagram = tunnel_datagram(&packet, 1400).expect("validate UDP payload");
        assert_eq!(datagram, packet.as_slice());
    }

    #[test]
    fn runtime_packet_boundary_binds_both_directions_to_its_tunnel_address() {
        let tunnel = Ipv4Addr::new(100, 96, 0, 10);
        let outbound = tcp_packet(TCP_FLAG_SYN, 41, 0, &[]);
        assert!(outbound_tunnel_datagram(&outbound, 1400, tunnel).is_ok());
        assert!(outbound_tunnel_datagram(&outbound, 1400, Ipv4Addr::new(100, 64, 0, 11)).is_err());

        let inbound = unsupported_ipv4_rejection(&outbound).expect("reverse packet");
        assert!(inbound_tunnel_datagram(&inbound, 1400, tunnel).is_ok());
        assert!(inbound_tunnel_datagram(&inbound, 1400, Ipv4Addr::new(100, 64, 0, 11)).is_err());
    }

    #[test]
    fn readiness_probe_is_an_ordinary_tcp_packet_with_a_correlated_reply() {
        let tunnel = Ipv4Addr::new(100, 64, 0, 2);
        let source_port = readiness_probe_source_port(7);
        let sequence = readiness_probe_sequence(7);
        let probe = egress_readiness_probe(tunnel, source_port, sequence);
        let parsed = parse_ipv4_tcp(&probe).expect("valid readiness SYN");

        assert_eq!(parsed.source, tunnel.octets());
        assert_eq!(parsed.destination, [192, 0, 2, 1]);
        assert_eq!(parsed.source_port, source_port.to_be_bytes());
        assert_eq!(parsed.destination_port, 9_u16.to_be_bytes());
        assert_eq!(parsed.sequence, sequence);
        assert_eq!(parsed.flags, TCP_FLAG_SYN);
        assert_eq!(internet_checksum(&probe[..IPV4_HEADER_LEN]), 0);
        assert_eq!(
            tcp_checksum(tunnel.octets(), [192, 0, 2, 1], &probe[IPV4_HEADER_LEN..]),
            0
        );

        let reply = unsupported_ipv4_rejection(&probe).expect("matching RST reply");
        assert!(is_egress_readiness_reply(
            &reply,
            tunnel,
            source_port,
            sequence
        ));
        assert!(!is_egress_readiness_reply(
            &reply,
            Ipv4Addr::new(100, 64, 0, 3),
            source_port,
            sequence
        ));
        let mut syn_ack = reply;
        syn_ack[IPV4_HEADER_LEN + 13] = TCP_FLAG_SYN | TCP_FLAG_ACK;
        assert!(!is_egress_readiness_reply(
            &syn_ack,
            tunnel,
            source_port,
            sequence
        ));
    }

    #[test]
    fn resets_new_connection_with_acknowledgement() {
        let packet = tcp_packet(TCP_FLAG_SYN, 41, 0, &[]);
        let reset = unsupported_ipv4_rejection(&packet).expect("TCP SYN reset");

        assert_eq!(reset.len(), IPV4_HEADER_LEN + TCP_HEADER_LEN);
        assert_eq!(&reset[12..16], &[93, 184, 216, 34]);
        assert_eq!(&reset[16..20], &[100, 96, 0, 10]);
        assert_eq!(&reset[20..22], &443_u16.to_be_bytes());
        assert_eq!(&reset[22..24], &40_000_u16.to_be_bytes());
        assert_eq!(u32::from_be_bytes(reset[24..28].try_into().unwrap()), 0);
        assert_eq!(u32::from_be_bytes(reset[28..32].try_into().unwrap()), 42);
        assert_eq!(reset[33], TCP_FLAG_RST | TCP_FLAG_ACK);
        assert_eq!(internet_checksum(&reset[..IPV4_HEADER_LEN]), 0);
        assert_eq!(
            tcp_checksum(
                reset[12..16].try_into().unwrap(),
                reset[16..20].try_into().unwrap(),
                &reset[IPV4_HEADER_LEN..]
            ),
            0
        );
    }

    #[test]
    fn resets_acknowledged_segment_with_incoming_ack_sequence() {
        let packet = tcp_packet(TCP_FLAG_ACK, 41, 900, b"request");
        let reset = unsupported_ipv4_rejection(&packet).expect("acknowledged TCP reset");

        assert_eq!(u32::from_be_bytes(reset[24..28].try_into().unwrap()), 900);
        assert_eq!(u32::from_be_bytes(reset[28..32].try_into().unwrap()), 0);
        assert_eq!(reset[33], TCP_FLAG_RST);
    }

    #[test]
    fn never_responds_to_reset_with_another_reset() {
        let packet = tcp_packet(TCP_FLAG_RST, 41, 0, &[]);
        assert!(unsupported_ipv4_rejection(&packet).is_none());
    }

    #[test]
    fn rejects_udp_with_icmp_administratively_prohibited() {
        let packet_len = IPV4_HEADER_LEN + 8;
        let mut packet = vec![0_u8; packet_len];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&(packet_len as u16).to_be_bytes());
        packet[8] = 64;
        packet[9] = 17;
        packet[12..16].copy_from_slice(&[100, 96, 0, 10]);
        packet[16..20].copy_from_slice(&[1, 1, 1, 1]);
        packet[20..22].copy_from_slice(&40_000_u16.to_be_bytes());
        packet[22..24].copy_from_slice(&53_u16.to_be_bytes());
        packet[24..26].copy_from_slice(&8_u16.to_be_bytes());

        let rejection = unsupported_ipv4_rejection(&packet).expect("UDP ICMP rejection");
        assert_eq!(rejection[9], IP_PROTOCOL_ICMP);
        assert_eq!(&rejection[12..16], &[1, 1, 1, 1]);
        assert_eq!(&rejection[16..20], &[100, 96, 0, 10]);
        assert_eq!(rejection[20], ICMP_DESTINATION_UNREACHABLE);
        assert_eq!(rejection[21], ICMP_ADMINISTRATIVELY_PROHIBITED);
        assert_eq!(internet_checksum(&rejection[..IPV4_HEADER_LEN]), 0);
        assert_eq!(internet_checksum(&rejection[IPV4_HEADER_LEN..]), 0);
        assert_eq!(&rejection[IPV4_HEADER_LEN + ICMP_HEADER_LEN..], &packet);
    }

    #[test]
    fn never_responds_to_icmp_error_with_another_error() {
        let packet_len = IPV4_HEADER_LEN + ICMP_HEADER_LEN;
        let mut packet = vec![0_u8; packet_len];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&(packet_len as u16).to_be_bytes());
        packet[8] = 64;
        packet[9] = IP_PROTOCOL_ICMP;
        packet[12..16].copy_from_slice(&[100, 96, 0, 10]);
        packet[16..20].copy_from_slice(&[1, 1, 1, 1]);
        packet[20] = ICMP_DESTINATION_UNREACHABLE;

        assert!(unsupported_ipv4_rejection(&packet).is_none());
    }

    fn tcp_packet(flags: u8, sequence: u32, acknowledgement: u32, payload: &[u8]) -> Vec<u8> {
        let packet_len = IPV4_HEADER_LEN + TCP_HEADER_LEN + payload.len();
        let mut packet = vec![0_u8; packet_len];
        packet[0] = 0x45;
        packet[2..4].copy_from_slice(&(packet_len as u16).to_be_bytes());
        packet[8] = 64;
        packet[9] = IP_PROTOCOL_TCP;
        packet[12..16].copy_from_slice(&[100, 96, 0, 10]);
        packet[16..20].copy_from_slice(&[93, 184, 216, 34]);
        packet[20..22].copy_from_slice(&40_000_u16.to_be_bytes());
        packet[22..24].copy_from_slice(&443_u16.to_be_bytes());
        packet[24..28].copy_from_slice(&sequence.to_be_bytes());
        packet[28..32].copy_from_slice(&acknowledgement.to_be_bytes());
        packet[32] = 5 << 4;
        packet[33] = flags;
        packet[40..].copy_from_slice(payload);
        packet
    }

    fn decode_hex(value: &str) -> Result<Vec<u8>, &'static str> {
        if !value.len().is_multiple_of(2) {
            return Err("hex length must be even");
        }
        value
            .as_bytes()
            .as_chunks::<2>()
            .0
            .iter()
            .map(|pair| {
                let text = std::str::from_utf8(pair).map_err(|_| "hex must be ASCII")?;
                u8::from_str_radix(text, 16).map_err(|_| "hex byte is invalid")
            })
            .collect()
    }
}
