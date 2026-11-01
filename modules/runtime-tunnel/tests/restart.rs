use antnest_runtime_tunnel::{
    EGRESS_DRAIN_DEFAULT_MILLIS, EGRESS_DRAIN_MAX_MILLIS, Error, Event, KeyId, Peer,
    egress_restart_packet, parse_egress_restart,
};
use std::net::{IpAddr, Ipv4Addr};

const TUNNEL: Ipv4Addr = Ipv4Addr::new(10, 243, 1, 9);
const IP: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 243, 1, 2));

fn pair() -> (Peer, Peer) {
    let id = KeyId::parse("rtk_0102030405060708090a0b0c0d0e0f10").unwrap();
    let alice = [11; 32];
    let bob = [29; 32];
    let psk = [53; 32];
    (
        Peer::new(id, alice, Peer::public_key(bob), psk),
        Peer::new(id, bob, Peer::public_key(alice), psk),
    )
}

fn network(events: Vec<Event>) -> Vec<Vec<u8>> {
    events
        .into_iter()
        .filter_map(|e| {
            if let Event::Network(p) = e {
                Some(p)
            } else {
                None
            }
        })
        .collect()
}
fn inner(events: Vec<Event>) -> Vec<Vec<u8>> {
    events
        .into_iter()
        .filter_map(|e| {
            if let Event::Ipv4(p) = e {
                Some(p)
            } else {
                None
            }
        })
        .collect()
}

fn probe(marker: u8) -> Vec<u8> {
    let mut p = vec![0u8; 40];
    p[0] = 0x45;
    p[2..4].copy_from_slice(&40u16.to_be_bytes());
    p[8] = 64;
    p[9] = 6;
    p[12..16].copy_from_slice(&[100, 64, 0, 2]);
    p[16..20].copy_from_slice(&[1, 1, 1, 1]);
    p[32] = 0x50;
    p[39] = marker;
    p
}

fn establish(a: &mut Peer, b: &mut Peer) {
    let init = network(a.send(&probe(1)).unwrap()).pop().unwrap();
    let reply = network(b.receive(&init, IP).unwrap()).pop().unwrap();
    let outgoing = network(a.receive(&reply, IP).unwrap());
    let mut encrypted = 0;
    for p in outgoing {
        if !inner(b.receive(&p, IP).unwrap()).is_empty() {
            encrypted += 1;
        }
    }
    assert_eq!(encrypted, 1);
}

fn sum16(parts: &[&[u8]]) -> u16 {
    let mut sum = 0u32;
    for part in parts {
        let (words, remainder) = part.as_chunks::<2>();
        for w in words {
            sum += u16::from_be_bytes([w[0], w[1]]) as u32;
        }
        for &b in remainder {
            sum += (b as u32) << 8;
        }
    }
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

fn tcp_sum(packet: &[u8]) -> u16 {
    let mut pseudo = [0u8; 12];
    pseudo[..4].copy_from_slice(&packet[12..16]);
    pseudo[4..8].copy_from_slice(&packet[16..20]);
    pseudo[9] = packet[9];
    pseudo[10..12].copy_from_slice(&((packet.len() - 20) as u16).to_be_bytes());
    sum16(&[&pseudo, &packet[20..]])
}

fn repair(packet: &mut [u8]) {
    packet[10..12].fill(0);
    let ip = sum16(&[&packet[..20]]);
    packet[10..12].copy_from_slice(&ip.to_be_bytes());
    packet[36..38].fill(0);
    let tcp = tcp_sum(packet);
    packet[36..38].copy_from_slice(&tcp.to_be_bytes());
}

fn readiness_probe() -> Vec<u8> {
    let mut p = vec![0u8; 40];
    p[0] = 0x45;
    p[2..4].copy_from_slice(&40u16.to_be_bytes());
    p[6..8].copy_from_slice(&0x4000u16.to_be_bytes());
    p[8] = 64;
    p[9] = 6;
    p[12..16].copy_from_slice(&TUNNEL.octets());
    p[16..20].copy_from_slice(&[192, 0, 2, 1]);
    p[20..22].copy_from_slice(&49152u16.to_be_bytes());
    p[22..24].copy_from_slice(&9u16.to_be_bytes());
    p[32] = 0x50;
    p[33] = 0x02;
    p[34..36].copy_from_slice(&65535u16.to_be_bytes());
    repair(&mut p);
    p
}

#[test]
fn restart_notice_roundtrips_boundary_and_default_durations() {
    assert_eq!(EGRESS_DRAIN_DEFAULT_MILLIS, 30_000);
    assert_eq!(EGRESS_DRAIN_MAX_MILLIS, 120_000);
    for duration in [1, EGRESS_DRAIN_DEFAULT_MILLIS, EGRESS_DRAIN_MAX_MILLIS] {
        let packet = egress_restart_packet(TUNNEL, duration).unwrap();
        assert_eq!(packet.len(), 48);
        assert_eq!(parse_egress_restart(&packet, TUNNEL), Ok(duration));
    }
}

#[test]
fn restart_notice_rejects_out_of_range_durations() {
    for duration in [0, EGRESS_DRAIN_MAX_MILLIS + 1, u32::MAX] {
        assert_eq!(egress_restart_packet(TUNNEL, duration), Err(Error::Invalid));
    }
}

#[test]
fn restart_notice_has_the_exact_fixed_wire_layout() {
    let packet = egress_restart_packet(TUNNEL, 30_000).unwrap();
    assert_eq!(packet.len(), 48);
    assert_eq!(packet[0], 0x45);
    assert_eq!(packet[1], 0);
    assert_eq!(&packet[2..4], &48u16.to_be_bytes());
    assert_eq!(&packet[4..8], &[0, 0, 0x40, 0]);
    assert_eq!(packet[8], 64);
    assert_eq!(packet[9], 6);
    assert_eq!(&packet[12..16], &[192, 0, 2, 1]);
    assert_eq!(&packet[16..20], &TUNNEL.octets());
    assert_eq!(&packet[20..24], &[0, 9, 0, 9]);
    assert_eq!(&packet[24..32], &[0; 8]);
    assert_eq!(packet[32], 0x50);
    assert_eq!(packet[33], 0x10);
    assert_eq!(&packet[34..36], &[0, 0]);
    assert_eq!(&packet[38..40], &[0, 0]);
    assert_eq!(&packet[40..44], b"ANTR");
    assert_eq!(&packet[44..48], &30_000u32.to_be_bytes());
    assert_eq!(sum16(&[&packet[..20]]), 0);
    assert_eq!(tcp_sum(&packet), 0);
}

#[test]
fn parser_accepts_only_the_bound_usable_tunnel_destination() {
    let packet = egress_restart_packet(TUNNEL, 5_000).unwrap();
    assert_eq!(
        parse_egress_restart(&packet, Ipv4Addr::new(10, 243, 1, 10)),
        Err(Error::WrongContext)
    );
    for unusable in [
        Ipv4Addr::UNSPECIFIED,
        Ipv4Addr::BROADCAST,
        Ipv4Addr::new(224, 0, 0, 1),
        Ipv4Addr::new(127, 0, 0, 1),
        Ipv4Addr::new(240, 0, 0, 1),
    ] {
        assert_eq!(egress_restart_packet(unusable, 5_000), Err(Error::Invalid));
        assert!(parse_egress_restart(&packet, unusable).is_err());
    }
    let mut crafted = packet.clone();
    crafted[16..20].copy_from_slice(&[0, 0, 0, 0]);
    repair(&mut crafted);
    assert!(parse_egress_restart(&crafted, Ipv4Addr::UNSPECIFIED).is_err());
}

#[test]
fn parser_rejects_truncated_extended_and_garbage_frames() {
    let packet = egress_restart_packet(TUNNEL, 1_000).unwrap();
    for length in 0..48 {
        assert!(parse_egress_restart(&packet[..length], TUNNEL).is_err());
    }
    for extra in [1usize, 8, 1352] {
        let mut extended = packet.clone();
        extended.resize(48 + extra, 0);
        assert!(parse_egress_restart(&extended, TUNNEL).is_err());
    }
    assert!(parse_egress_restart(&[0xff; 48], TUNNEL).is_err());
    assert!(parse_egress_restart(&[0x45; 48], TUNNEL).is_err());
}

#[test]
fn parser_rejects_mutated_header_transport_and_payload_fields() {
    let base = egress_restart_packet(TUNNEL, 60_000).unwrap();
    type PacketMutation = Box<dyn Fn(&mut Vec<u8>)>;
    let mutations: Vec<PacketMutation> = vec![
        Box::new(|p| p[0] = 0x46),
        Box::new(|p| p[0] = 0x55),
        Box::new(|p| p[1] = 1),
        Box::new(|p| p[2..4].copy_from_slice(&47u16.to_be_bytes())),
        Box::new(|p| p[2..4].copy_from_slice(&49u16.to_be_bytes())),
        Box::new(|p| p[5] = 1),
        Box::new(|p| p[6] = 0),
        Box::new(|p| p[6] = 0x20),
        Box::new(|p| p[7] = 1),
        Box::new(|p| p[8] = 63),
        Box::new(|p| p[9] = 17),
        Box::new(|p| p[12] = 198),
        Box::new(|p| p[21] = 10),
        Box::new(|p| p[23] = 10),
        Box::new(|p| p[27] = 1),
        Box::new(|p| p[31] = 1),
        Box::new(|p| p[32] = 0x60),
        Box::new(|p| p[33] = 0x12),
        Box::new(|p| p[33] = 0x11),
        Box::new(|p| p[33] = 0x02),
        Box::new(|p| p[35] = 1),
        Box::new(|p| p[39] = 1),
        Box::new(|p| p[43] = b'X'),
        Box::new(|p| p[44..48].copy_from_slice(&0u32.to_be_bytes())),
        Box::new(|p| p[44..48].copy_from_slice(&120_001u32.to_be_bytes())),
    ];
    for mutate in mutations {
        let mut p = base.clone();
        mutate(&mut p);
        repair(&mut p);
        assert!(parse_egress_restart(&p, TUNNEL).is_err());
    }
    for offset in [10usize, 11, 36, 37] {
        let mut p = base.clone();
        p[offset] ^= 1;
        assert!(parse_egress_restart(&p, TUNNEL).is_err());
    }
}

#[test]
fn ordinary_readiness_and_data_frames_are_not_restart_notices() {
    assert!(parse_egress_restart(&readiness_probe(), TUNNEL).is_err());
    assert!(parse_egress_restart(&probe(7), TUNNEL).is_err());
    let mut valid_other = readiness_probe();
    valid_other[33] = 0x18;
    valid_other.resize(48, 0);
    valid_other[2..4].copy_from_slice(&48u16.to_be_bytes());
    repair(&mut valid_other);
    assert!(parse_egress_restart(&valid_other, TUNNEL).is_err());
}

#[test]
fn restart_notice_survives_only_inside_the_encrypted_session() {
    let (mut egress, mut runtime) = pair();
    establish(&mut egress, &mut runtime);
    let notice = egress_restart_packet(TUNNEL, 45_000).unwrap();
    let frame = network(egress.send(&notice).unwrap()).pop().unwrap();
    assert!(!frame.windows(notice.len()).any(|w| w == notice));
    let decoded = inner(runtime.receive(&frame, IP).unwrap());
    assert_eq!(decoded.len(), 1);
    assert_eq!(parse_egress_restart(&decoded[0], TUNNEL), Ok(45_000));

    assert!(parse_egress_restart(&frame, TUNNEL).is_err());
    assert!(runtime.receive(&notice, IP).is_err());

    let mut forged = network(egress.send(&notice).unwrap()).pop().unwrap();
    *forged.last_mut().unwrap() ^= 1;
    assert!(runtime.receive(&forged, IP).is_err());

    let replay = network(egress.send(&notice).unwrap()).pop().unwrap();
    assert_eq!(inner(runtime.receive(&replay, IP).unwrap()), vec![notice]);
    assert!(runtime.receive(&replay, IP).is_err());
}
