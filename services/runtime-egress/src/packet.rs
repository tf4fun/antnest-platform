use std::net::Ipv4Addr;

use thiserror::Error;

const IPV4_HEADER_LEN: usize = 20;
const TCP_HEADER_LEN: usize = 20;
const IP_PROTOCOL_TCP: u8 = 6;
const READINESS_PROBE_DESTINATION: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);
const READINESS_PROBE_DESTINATION_PORT: u16 = 9;
const READINESS_PROBE_SOURCE_PORT_MIN: u16 = 49_152;
pub const INNER_MTU: usize = 1400;
pub const PACKET_CONTRACT_REVISION: u32 = 1;

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct FlowKey {
    pub source: Ipv4Addr,
    pub source_port: u16,
    pub destination: Ipv4Addr,
    pub destination_port: u16,
}

impl FlowKey {
    pub const fn tcp(
        source: Ipv4Addr,
        source_port: u16,
        destination: Ipv4Addr,
        destination_port: u16,
    ) -> Self {
        Self {
            source,
            source_port,
            destination,
            destination_port,
        }
    }

    pub const fn reverse(self) -> Self {
        Self {
            source: self.destination,
            source_port: self.destination_port,
            destination: self.source,
            destination_port: self.source_port,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TcpFlags(u8);

impl TcpFlags {
    pub const FIN: Self = Self(0x01);
    pub const SYN: Self = Self(0x02);
    pub const RST: Self = Self(0x04);
    pub const ACK: Self = Self(0x10);

    pub const fn contains(self, flag: Self) -> bool {
        self.0 & flag.0 != 0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Ipv4TcpPacket {
    pub source: Ipv4Addr,
    pub destination: Ipv4Addr,
    pub source_port: u16,
    pub destination_port: u16,
    pub sequence: u32,
    pub acknowledgement: u32,
    pub flags: TcpFlags,
    pub payload_len: usize,
}

impl Ipv4TcpPacket {
    pub const fn flow_key(&self) -> FlowKey {
        FlowKey::tcp(
            self.source,
            self.source_port,
            self.destination,
            self.destination_port,
        )
    }

    pub const fn reverse_flow_key(&self) -> FlowKey {
        self.flow_key().reverse()
    }
}

#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum PacketError {
    #[error("inner packet size is invalid")]
    InvalidSize,
    #[error("inner packet is not IPv4")]
    UnsupportedVersion,
    #[error("IPv4 header is invalid")]
    InvalidIpv4Header,
    #[error("IPv4 total length does not match the datagram")]
    LengthMismatch,
    #[error("fragmented IPv4 is unsupported")]
    Fragmented,
    #[error("inner protocol is unsupported")]
    UnsupportedProtocol,
    #[error("TCP header is invalid")]
    InvalidTcpHeader,
}

pub fn parse_ipv4_tcp(packet: &[u8], mtu: usize) -> Result<Ipv4TcpPacket, PacketError> {
    if packet.is_empty() || packet.len() > mtu {
        return Err(PacketError::InvalidSize);
    }
    if packet.len() < IPV4_HEADER_LEN {
        return Err(PacketError::InvalidIpv4Header);
    }
    if packet[0] >> 4 != 4 {
        return Err(PacketError::UnsupportedVersion);
    }

    let ipv4_header_len = usize::from(packet[0] & 0x0f) * 4;
    if ipv4_header_len < IPV4_HEADER_LEN || ipv4_header_len > packet.len() {
        return Err(PacketError::InvalidIpv4Header);
    }
    let total_len = usize::from(u16::from_be_bytes([packet[2], packet[3]]));
    if total_len != packet.len() {
        return Err(PacketError::LengthMismatch);
    }
    if u16::from_be_bytes([packet[6], packet[7]]) & 0x3fff != 0 {
        return Err(PacketError::Fragmented);
    }
    if packet[9] != IP_PROTOCOL_TCP {
        return Err(PacketError::UnsupportedProtocol);
    }
    if ipv4_header_len + TCP_HEADER_LEN > packet.len() {
        return Err(PacketError::InvalidTcpHeader);
    }

    let tcp_header_len = usize::from(packet[ipv4_header_len + 12] >> 4) * 4;
    if tcp_header_len < TCP_HEADER_LEN || ipv4_header_len + tcp_header_len > packet.len() {
        return Err(PacketError::InvalidTcpHeader);
    }

    Ok(Ipv4TcpPacket {
        source: Ipv4Addr::from(
            <[u8; 4]>::try_from(&packet[12..16]).expect("validated IPv4 source"),
        ),
        destination: Ipv4Addr::from(
            <[u8; 4]>::try_from(&packet[16..20]).expect("validated IPv4 destination"),
        ),
        source_port: u16::from_be_bytes(
            packet[ipv4_header_len..ipv4_header_len + 2]
                .try_into()
                .expect("validated TCP source port"),
        ),
        destination_port: u16::from_be_bytes(
            packet[ipv4_header_len + 2..ipv4_header_len + 4]
                .try_into()
                .expect("validated TCP destination port"),
        ),
        sequence: u32::from_be_bytes(
            packet[ipv4_header_len + 4..ipv4_header_len + 8]
                .try_into()
                .expect("validated TCP sequence"),
        ),
        acknowledgement: u32::from_be_bytes(
            packet[ipv4_header_len + 8..ipv4_header_len + 12]
                .try_into()
                .expect("validated TCP acknowledgement"),
        ),
        flags: TcpFlags(packet[ipv4_header_len + 13]),
        payload_len: packet.len() - ipv4_header_len - tcp_header_len,
    })
}

pub fn tcp_reset(incoming: &Ipv4TcpPacket) -> Option<Vec<u8>> {
    if incoming.flags.contains(TcpFlags::RST) {
        return None;
    }

    let reset_len = IPV4_HEADER_LEN + TCP_HEADER_LEN;
    let mut reset = vec![0_u8; reset_len];
    reset[0] = 0x45;
    reset[2..4].copy_from_slice(&(reset_len as u16).to_be_bytes());
    reset[6..8].copy_from_slice(&0x4000_u16.to_be_bytes());
    reset[8] = 64;
    reset[9] = IP_PROTOCOL_TCP;
    reset[12..16].copy_from_slice(&incoming.destination.octets());
    reset[16..20].copy_from_slice(&incoming.source.octets());

    let tcp = IPV4_HEADER_LEN;
    reset[tcp..tcp + 2].copy_from_slice(&incoming.destination_port.to_be_bytes());
    reset[tcp + 2..tcp + 4].copy_from_slice(&incoming.source_port.to_be_bytes());
    if incoming.flags.contains(TcpFlags::ACK) {
        reset[tcp + 4..tcp + 8].copy_from_slice(&incoming.acknowledgement.to_be_bytes());
        reset[tcp + 13] = TcpFlags::RST.0;
    } else {
        let acknowledged_len = incoming.payload_len as u32
            + u32::from(incoming.flags.contains(TcpFlags::SYN))
            + u32::from(incoming.flags.contains(TcpFlags::FIN));
        reset[tcp + 8..tcp + 12].copy_from_slice(
            &incoming
                .sequence
                .wrapping_add(acknowledged_len)
                .to_be_bytes(),
        );
        reset[tcp + 13] = TcpFlags::RST.0 | TcpFlags::ACK.0;
    }
    reset[tcp + 12] = 5 << 4;

    let ip_checksum = internet_checksum(&reset[..IPV4_HEADER_LEN]);
    reset[10..12].copy_from_slice(&ip_checksum.to_be_bytes());
    let tcp_checksum = tcp_checksum(
        incoming.destination.octets(),
        incoming.source.octets(),
        &reset[IPV4_HEADER_LEN..],
    );
    reset[tcp + 16..tcp + 18].copy_from_slice(&tcp_checksum.to_be_bytes());
    Some(reset)
}

pub fn is_readiness_probe(packet: &Ipv4TcpPacket, encoded_len: usize) -> bool {
    encoded_len == IPV4_HEADER_LEN + TCP_HEADER_LEN
        && packet.destination == READINESS_PROBE_DESTINATION
        && packet.destination_port == READINESS_PROBE_DESTINATION_PORT
        && packet.source_port >= READINESS_PROBE_SOURCE_PORT_MIN
        && packet.acknowledgement == 0
        && packet.flags == TcpFlags::SYN
        && packet.payload_len == 0
}

fn tcp_checksum(source: [u8; 4], destination: [u8; 4], segment: &[u8]) -> u16 {
    let mut sum = checksum_add(0, &source);
    sum = checksum_add(sum, &destination);
    sum = checksum_add(sum, &[0, IP_PROTOCOL_TCP]);
    sum = checksum_add(sum, &(segment.len() as u16).to_be_bytes());
    finish_checksum(checksum_add(sum, segment))
}

fn internet_checksum(bytes: &[u8]) -> u16 {
    finish_checksum(checksum_add(0, bytes))
}

fn checksum_add(mut sum: u32, bytes: &[u8]) -> u32 {
    let mut chunks = bytes.chunks_exact(2);
    for chunk in &mut chunks {
        sum += u32::from(u16::from_be_bytes([chunk[0], chunk[1]]));
    }
    if let Some(value) = chunks.remainder().first() {
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
