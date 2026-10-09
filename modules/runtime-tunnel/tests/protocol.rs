use antnest_runtime_tunnel::{Event, KeyId, MAX_DATAGRAM, Peer};
use std::net::{IpAddr, Ipv4Addr};

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

fn packet(marker: u8) -> Vec<u8> {
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
const IP: IpAddr = IpAddr::V4(Ipv4Addr::new(10, 243, 1, 2));

fn establish(a: &mut Peer, b: &mut Peer) -> Vec<Vec<u8>> {
    let init = network(a.send(&packet(1)).unwrap()).pop().unwrap();
    let reply = network(b.receive(&init, IP).unwrap()).pop().unwrap();
    let outgoing = network(a.receive(&reply, IP).unwrap());
    let mut encrypted = vec![];
    for p in outgoing {
        if !inner(b.receive(&p, IP).unwrap()).is_empty() {
            encrypted.push(p);
        }
    }
    assert_eq!(encrypted.len(), 1);
    encrypted
}

#[test]
fn shared_framing_rejects_raw_unknown_context_and_oversized_datagrams() {
    let (mut a, mut b) = pair();
    assert!(b.receive(&packet(1), IP).is_err());
    assert!(b.receive(&vec![0; MAX_DATAGRAM + 1], IP).is_err());
    let mut init = network(a.send(&packet(1)).unwrap()).pop().unwrap();
    init[4] ^= 1;
    assert!(b.receive(&init, IP).is_err());
    for bad in [
        "rtk_bad",
        "RTK_0102030405060708090a0b0c0d0e0f10",
        "rtk_0102030405060708090a0b0c0d0e0f1G",
    ] {
        assert!(KeyId::parse(bad).is_err());
    }
}

#[test]
fn encryption_authentication_and_bidirectional_data_use_the_protocol_engine() {
    let (mut a, mut b) = pair();
    establish(&mut a, &mut b);
    let encrypted = network(a.send(&packet(2)).unwrap()).pop().unwrap();
    assert!(!encrypted.windows(40).any(|w| w == packet(2)));
    assert_eq!(inner(b.receive(&encrypted, IP).unwrap()), vec![packet(2)]);
    let reverse = network(b.send(&packet(3)).unwrap()).pop().unwrap();
    assert_eq!(inner(a.receive(&reverse, IP).unwrap()), vec![packet(3)]);
}

#[test]
fn tampering_replay_and_old_sessions_never_return_plaintext() {
    let (mut a, mut b) = pair();
    establish(&mut a, &mut b);
    let encrypted = network(a.send(&packet(4)).unwrap()).pop().unwrap();
    let mut tampered = encrypted.clone();
    *tampered.last_mut().unwrap() ^= 1;
    assert!(b.receive(&tampered, IP).is_err());
    assert_eq!(inner(b.receive(&encrypted, IP).unwrap()), vec![packet(4)]);
    assert!(b.receive(&encrypted, IP).is_err());
    let (_, mut restarted) = pair();
    assert!(restarted.receive(&encrypted, IP).is_err());
    let (mut new_a, _) = pair();
    establish(&mut new_a, &mut restarted);
    assert!(restarted.receive(&encrypted, IP).is_err());
}

#[test]
fn a_warm_peer_recovers_a_restarted_receiver_using_only_engine_timers() {
    let (mut runtime, mut egress) = pair();
    establish(&mut runtime, &mut egress);
    let reply = network(egress.send(&packet(10)).unwrap()).pop().unwrap();
    assert_eq!(
        inner(runtime.receive(&reply, IP).unwrap()),
        vec![packet(10)]
    );
    // The timer uses millisecond resolution and requires a send after the last
    // authenticated receive. Keep the established Runtime peer throughout.
    std::thread::sleep(std::time::Duration::from_millis(2));
    let captured = network(runtime.send(&packet(11)).unwrap()).pop().unwrap();
    assert_eq!(
        inner(egress.receive(&captured, IP).unwrap()),
        vec![packet(11)]
    );
    let (_, mut restarted) = pair();
    assert!(restarted.receive(&captured, IP).is_err());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        assert!(
            std::time::Instant::now() < deadline,
            "engine did not rehandshake a silent restarted peer"
        );
        for frame in network(runtime.tick().unwrap()) {
            if let Ok(events) = restarted.receive(&frame, IP) {
                for response in network(events) {
                    for confirmation in network(runtime.receive(&response, IP).unwrap()) {
                        restarted.receive(&confirmation, IP).unwrap();
                    }
                }
            }
        }
        let frame = network(runtime.send(&packet(12)).unwrap()).pop().unwrap();
        if let Ok(events) = restarted.receive(&frame, IP)
            && inner(events) == vec![packet(12)]
        {
            assert!(restarted.receive(&captured, IP).is_err());
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

#[test]
fn wrong_preshared_key_cannot_complete_the_authenticated_handshake() {
    let (mut a, _) = pair();
    let mut wrong = Peer::new(a.key_id(), [29; 32], Peer::public_key([11; 32]), [54; 32]);
    let init = network(a.send(&packet(1)).unwrap()).pop().unwrap();
    let reply = network(wrong.receive(&init, IP).unwrap()).pop().unwrap();
    assert!(a.receive(&reply, IP).is_err());
}

#[test]
fn reordering_is_accepted_once_but_out_of_window_is_rejected() {
    let (mut a, mut b) = pair();
    establish(&mut a, &mut b);
    let old = network(a.send(&packet(5)).unwrap()).pop().unwrap();
    let late = network(a.send(&packet(6)).unwrap()).pop().unwrap();
    assert_eq!(inner(b.receive(&late, IP).unwrap()), vec![packet(6)]);
    assert_eq!(inner(b.receive(&old, IP).unwrap()), vec![packet(5)]);
    let stale = network(a.send(&packet(7)).unwrap()).pop().unwrap();
    let mut latest = vec![];
    for _ in 0..2048 {
        latest = network(a.send(&packet(8)).unwrap()).pop().unwrap();
    }
    assert_eq!(inner(b.receive(&latest, IP).unwrap()), vec![packet(8)]);
    assert!(b.receive(&stale, IP).is_err());
}

#[test]
fn rewriting_context_does_not_authenticate_another_agents_packet() {
    let (mut a, mut b) = pair();
    establish(&mut a, &mut b);
    let other_id = KeyId::from_bytes([92; 16]);
    let mut other = Peer::new(other_id, [66; 32], Peer::public_key([77; 32]), [88; 32]);
    let mut data = network(a.send(&packet(9)).unwrap()).pop().unwrap();
    data[4..20].copy_from_slice(&other_id.bytes());
    assert!(other.receive(&data, IP).is_err());
    let mut init = network(pair().0.send(&packet(1)).unwrap()).pop().unwrap();
    init[4..20].copy_from_slice(&other_id.bytes());
    assert!(other.receive(&init, IP).is_err());
}

#[test]
fn malformed_inputs_are_bounded_and_never_return_plaintext() {
    let (_, mut b) = pair();
    for length in 0..180 {
        let packet = vec![0xff; length];
        assert!(b.receive(&packet, IP).is_err());
    }
    assert!(b.send(&[0x60; 40]).is_err());
    assert!(b.send(&vec![0x45; 1401]).is_err());
    assert!(b.send(&[]).is_err());
}
