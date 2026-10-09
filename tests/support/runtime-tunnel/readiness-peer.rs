//! Test-only encrypted readiness responder. No TUN, policy or external forwarding.
use antnest_runtime_tunnel::{Event, KeyId, MAX_DATAGRAM, Peer, TIMER_MILLIS};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use std::{
    net::{Ipv4Addr, UdpSocket},
    time::Duration,
};
#[derive(Deserialize)]
struct Input {
    key_id: String,
    egress_private_key: String,
    runtime_public_key: String,
    preshared_key: String,
    tunnel_ipv4: Ipv4Addr,
}
fn key(value: &str) -> [u8; 32] {
    URL_SAFE_NO_PAD
        .decode(value)
        .expect("fixture key encoding")
        .try_into()
        .expect("fixture key size")
}
fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = bytes.chunks(2).fold(0u32, |s, p| {
        s + u32::from(u16::from_be_bytes([p[0], *p.get(1).unwrap_or(&0)]))
    });
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16)
    }
    !(sum as u16)
}
fn reset(packet: &[u8], ip: Ipv4Addr) -> Option<Vec<u8>> {
    if packet.len() < 40 || packet[0] >> 4 != 4 || packet[9] != 6 || packet[12..16] != ip.octets() {
        return None;
    }
    let ihl = usize::from(packet[0] & 15) * 4;
    if ihl < 20 || packet.len() < ihl + 20 || packet[ihl + 13] & 2 == 0 {
        return None;
    }
    let mut r = vec![0; 40];
    r[0] = 0x45;
    r[2..4].copy_from_slice(&40u16.to_be_bytes());
    r[8] = 64;
    r[9] = 6;
    r[12..16].copy_from_slice(&packet[16..20]);
    r[16..20].copy_from_slice(&packet[12..16]);
    r[20..22].copy_from_slice(&packet[ihl + 2..ihl + 4]);
    r[22..24].copy_from_slice(&packet[ihl..ihl + 2]);
    let seq = u32::from_be_bytes(packet[ihl + 4..ihl + 8].try_into().ok()?);
    r[28..32].copy_from_slice(&seq.wrapping_add(1).to_be_bytes());
    r[32] = 0x50;
    r[33] = 0x14;
    let ip_sum = checksum(&r[..20]);
    r[10..12].copy_from_slice(&ip_sum.to_be_bytes());
    let mut pseudo = r[12..20].to_vec();
    pseudo.extend_from_slice(&[0, 6, 0, 20]);
    pseudo.extend_from_slice(&r[20..]);
    r[36..38].copy_from_slice(&checksum(&pseudo).to_be_bytes());
    Some(r)
}
fn main() {
    let path = std::env::args().nth(1).expect("fixture profile path");
    let input: Input = serde_json::from_slice(&std::fs::read(path).expect("fixture profile file"))
        .expect("fixture profile JSON");
    let mut crypto = Peer::new(
        KeyId::parse(&input.key_id).unwrap(),
        key(&input.egress_private_key),
        key(&input.runtime_public_key),
        key(&input.preshared_key),
    );
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 8092)).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(TIMER_MILLIS)))
        .unwrap();
    let mut buffer = [0u8; MAX_DATAGRAM + 1];
    let mut remote = None;
    loop {
        match socket.recv_from(&mut buffer) {
            Ok((size, peer)) => {
                let Ok(events) = crypto.receive(&buffer[..size], peer.ip()) else {
                    continue;
                };
                for event in events {
                    match event {
                        Event::Network(frame) => {
                            let _ = socket.send_to(&frame, peer);
                        }
                        Event::Ipv4(packet) => {
                            if let Some(reply) = reset(&packet, input.tunnel_ipv4) {
                                remote = Some(peer);
                                if let Ok(output) = crypto.send(&reply) {
                                    for event in output {
                                        if let Event::Network(frame) = event {
                                            let _ = socket.send_to(&frame, peer);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if let (Some(peer), Ok(events)) = (remote, crypto.tick()) {
                    for event in events {
                        if let Event::Network(frame) = event {
                            let _ = socket.send_to(&frame, peer);
                        }
                    }
                }
            }
            Err(_) => break,
        }
    }
}
