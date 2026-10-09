//! Test-only encrypted packet client. Never installed in the production image.
use antnest_runtime_tunnel::{Event, KeyId, MAX_DATAGRAM, Peer, TIMER_MILLIS};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use std::{
    io,
    net::{Ipv4Addr, SocketAddrV4, UdpSocket},
    time::{Duration, Instant},
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Keys {
    key_id: String,
    runtime_private_key: String,
    egress_public_key: String,
    preshared_key: String,
}
fn key(value: &str) -> [u8; 32] {
    URL_SAFE_NO_PAD.decode(value).unwrap().try_into().unwrap()
}
fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = bytes.chunks(2).fold(0u32, |s, p| {
        s + u32::from(u16::from_be_bytes([p[0], *p.get(1).unwrap_or(&0)]))
    });
    while sum >> 16 != 0 {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}
fn syn(source: Ipv4Addr, destination: SocketAddrV4, port: u16) -> Vec<u8> {
    let mut p = vec![0; 40];
    p[0] = 0x45;
    p[2..4].copy_from_slice(&40u16.to_be_bytes());
    p[8] = 64;
    p[9] = 6;
    p[12..16].copy_from_slice(&source.octets());
    p[16..20].copy_from_slice(&destination.ip().octets());
    p[20..22].copy_from_slice(&port.to_be_bytes());
    p[22..24].copy_from_slice(&destination.port().to_be_bytes());
    p[24..28].copy_from_slice(&1u32.to_be_bytes());
    p[32] = 0x50;
    p[33] = 2;
    p[34..36].copy_from_slice(&8192u16.to_be_bytes());
    let sum = checksum(&p[..20]);
    p[10..12].copy_from_slice(&sum.to_be_bytes());
    let mut pseudo = p[12..20].to_vec();
    pseudo.extend_from_slice(&[0, 6, 0, 20]);
    pseudo.extend_from_slice(&p[20..]);
    p[36..38].copy_from_slice(&checksum(&pseudo).to_be_bytes());
    p
}
fn send_events(socket: &UdpSocket, events: Vec<Event>) {
    for event in events {
        if let Event::Network(frame) = event {
            socket.send(&frame).unwrap();
        }
    }
}
fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert_eq!(
        args.len(),
        7,
        "keys-file egress source destination mode capture-file"
    );
    let keys: Keys = serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
    if args[5] == "public" {
        println!(
            "{}",
            serde_json::json!({"key_id":keys.key_id,"egress_public_key":keys.egress_public_key})
        );
        return;
    }
    let mut peer = Peer::new(
        KeyId::parse(&keys.key_id).unwrap(),
        key(&keys.runtime_private_key),
        key(&keys.egress_public_key),
        key(&keys.preshared_key),
    );
    let egress: SocketAddrV4 = args[2].parse().unwrap();
    let source: Ipv4Addr = args[3].parse().unwrap();
    let destination: SocketAddrV4 = args[4].parse().unwrap();
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
    socket.connect(egress).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_millis(TIMER_MILLIS)))
        .unwrap();
    if args[5] == "saved" {
        socket.send(&std::fs::read(&args[6]).unwrap()).unwrap();
        println!("{{\"sent\":true}}");
        return;
    }
    // Handshake only a canonical local probe, so crypto setup creates no policy flow.
    let probe = syn(source, "192.0.2.1:9".parse().unwrap(), 53000);
    send_events(&socket, peer.send(&probe).unwrap());
    let deadline = Instant::now()
        + if args[5] == "wrong" {
            Duration::from_millis(500)
        } else {
            Duration::from_secs(9)
        };
    let mut buffer = [0; MAX_DATAGRAM + 1];
    let mut ready = false;
    while Instant::now() < deadline && !ready {
        match socket.recv(&mut buffer) {
            Ok(size) => {
                if let Ok(events) = peer.receive(&buffer[..size], (*egress.ip()).into()) {
                    for event in events {
                        match event {
                            Event::Network(frame) => {
                                socket.send(&frame).unwrap();
                            }
                            Event::Ipv4(p) => {
                                ready = p.len() >= 40 && p[33] & 0x14 == 0x14;
                            }
                        }
                    }
                }
            }
            Err(e)
                if matches!(
                    e.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                send_events(&socket, peer.tick().unwrap());
            }
            Err(_) => break,
        }
    }
    if !ready {
        assert_eq!(args[5], "wrong", "authenticated readiness did not complete");
        println!("{{\"sent\":true,\"ready\":false}}");
        return;
    }
    let packet = syn(source, destination, 40000);
    for event in peer.send(&packet).unwrap() {
        if let Event::Network(mut frame) = event {
            match args[5].as_str() {
                "tamper" => *frame.last_mut().unwrap() ^= 1,
                "send" | "replay" | "capture" => {}
                _ => panic!("unknown mode"),
            }
            if args[5] == "capture" {
                std::fs::write(&args[6], &frame).unwrap();
            }
            socket.send(&frame).unwrap();
            if args[5] == "replay" {
                socket.send(&frame).unwrap();
            }
        }
    }
    println!("{{\"sent\":true,\"ready\":true}}");
}
