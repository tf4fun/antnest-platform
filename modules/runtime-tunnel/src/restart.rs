use super::Error;
use std::net::Ipv4Addr;

pub const EGRESS_DRAIN_MAX_MILLIS: u32 = 120_000;
pub const EGRESS_DRAIN_DEFAULT_MILLIS: u32 = 30_000;

const PACKET_LEN: usize = 48;
const HEADER_LEN: usize = 20;
const SOURCE: Ipv4Addr = Ipv4Addr::new(192, 0, 2, 1);
const MAGIC: &[u8; 4] = b"ANTR";

pub fn egress_restart_packet(tunnel_ipv4: Ipv4Addr, drain_millis: u32) -> Result<Vec<u8>, Error> {
    if !usable(tunnel_ipv4) || !(1..=EGRESS_DRAIN_MAX_MILLIS).contains(&drain_millis) {
        return Err(Error::Invalid);
    }
    let mut p = [0u8; PACKET_LEN];
    p[0] = 0x45;
    p[2..4].copy_from_slice(&(PACKET_LEN as u16).to_be_bytes());
    p[6..8].copy_from_slice(&0x4000u16.to_be_bytes());
    p[8] = 64;
    p[9] = 6;
    p[12..16].copy_from_slice(&SOURCE.octets());
    p[16..20].copy_from_slice(&tunnel_ipv4.octets());
    p[20..22].copy_from_slice(&9u16.to_be_bytes());
    p[22..24].copy_from_slice(&9u16.to_be_bytes());
    p[32] = 0x50;
    p[33] = 0x10;
    p[40..44].copy_from_slice(MAGIC);
    p[44..48].copy_from_slice(&drain_millis.to_be_bytes());
    let header = checksum(&[&p[..HEADER_LEN]]);
    p[10..12].copy_from_slice(&header.to_be_bytes());
    let transport = checksum(&[&pseudo_header(&SOURCE, &tunnel_ipv4), &p[HEADER_LEN..]]);
    p[36..38].copy_from_slice(&transport.to_be_bytes());
    Ok(p.to_vec())
}

pub fn parse_egress_restart(packet: &[u8], tunnel_ipv4: Ipv4Addr) -> Result<u32, Error> {
    if !usable(tunnel_ipv4) {
        return Err(Error::Invalid);
    }
    if packet.len() != PACKET_LEN {
        return Err(Error::Invalid);
    }
    let destination = Ipv4Addr::new(packet[16], packet[17], packet[18], packet[19]);
    if destination != tunnel_ipv4 {
        return Err(Error::WrongContext);
    }
    if packet[0] != 0x45
        || packet[1] != 0
        || packet[2..4] != (PACKET_LEN as u16).to_be_bytes()
        || packet[4..8] != [0, 0, 0x40, 0]
        || packet[8] != 64
        || packet[9] != 6
        || packet[12..16] != SOURCE.octets()
        || checksum(&[&packet[..HEADER_LEN]]) != 0
    {
        return Err(Error::Invalid);
    }
    if packet[20..24] != [0, 9, 0, 9]
        || packet[24..32] != [0; 8]
        || packet[32] != 0x50
        || packet[33] != 0x10
        || packet[34..36] != [0, 0]
        || packet[38..40] != [0, 0]
        || checksum(&[&pseudo_header(&SOURCE, &tunnel_ipv4), &packet[HEADER_LEN..]]) != 0
    {
        return Err(Error::Invalid);
    }
    if packet[40..44] != *MAGIC {
        return Err(Error::Invalid);
    }
    let drain_millis = u32::from_be_bytes(packet[44..48].try_into().map_err(|_| Error::Invalid)?);
    if !(1..=EGRESS_DRAIN_MAX_MILLIS).contains(&drain_millis) {
        return Err(Error::Invalid);
    }
    Ok(drain_millis)
}

fn usable(ip: Ipv4Addr) -> bool {
    let first = ip.octets()[0];
    first != 0 && first != 127 && first < 224
}

fn pseudo_header(source: &Ipv4Addr, destination: &Ipv4Addr) -> [u8; 12] {
    let mut h = [0u8; 12];
    h[..4].copy_from_slice(&source.octets());
    h[4..8].copy_from_slice(&destination.octets());
    h[9] = 6;
    h[10..12].copy_from_slice(&((PACKET_LEN - HEADER_LEN) as u16).to_be_bytes());
    h
}

fn checksum(parts: &[&[u8]]) -> u16 {
    let mut sum = 0u32;
    for part in parts {
        let mut words = part.chunks_exact(2);
        for w in &mut words {
            sum += u16::from_be_bytes([w[0], w[1]]) as u32;
        }
        for &b in words.remainder() {
            sum += (b as u32) << 8;
        }
    }
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}
