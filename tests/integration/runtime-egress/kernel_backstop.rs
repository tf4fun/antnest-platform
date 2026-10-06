#![cfg(target_os = "linux")]

use antnest_runtime_egress::{
    kernel::{KernelPlan, LinuxKernel},
    network::PacketDevice,
};
use serde_json::Value;
use std::{net::Ipv4Addr, time::Duration};
use tokio::{
    process::Command,
    time::{Instant, sleep, timeout},
};

async fn drop_count() -> u64 {
    let output = timeout(
        Duration::from_secs(5),
        Command::new("nft")
            .kill_on_drop(true)
            .args(["-j", "list", "table", "ip", "antnest_egress"])
            .output(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(output.status.success());
    let rules: Value = serde_json::from_slice(&output.stdout).unwrap();
    rules["nftables"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|item| item.get("rule"))
        .filter(|rule| rule["chain"] == "forward")
        .flat_map(|rule| rule["expr"].as_array().unwrap())
        .filter_map(|expression| expression["counter"]["packets"].as_u64())
        .sum()
}

fn checksum(bytes: &[u8]) -> u16 {
    let mut sum = bytes
        .chunks(2)
        .map(|chunk| u32::from(u16::from_be_bytes([chunk[0], *chunk.get(1).unwrap_or(&0)])))
        .sum::<u32>();
    while sum > 0xffff {
        sum = (sum & 0xffff) + (sum >> 16);
    }
    !(sum as u16)
}

fn syn(destination: Ipv4Addr) -> Vec<u8> {
    let mut packet = vec![0_u8; 40];
    packet[0] = 0x45;
    packet[2..4].copy_from_slice(&40_u16.to_be_bytes());
    packet[8] = 64;
    packet[9] = 6;
    packet[12..16].copy_from_slice(&[100, 64, 0, 2]);
    packet[16..20].copy_from_slice(&destination.octets());
    packet[20..22].copy_from_slice(&40000_u16.to_be_bytes());
    packet[22..24].copy_from_slice(&9010_u16.to_be_bytes());
    packet[27] = 1;
    packet[32] = 0x50;
    packet[33] = 2;
    packet[34..36].copy_from_slice(&8192_u16.to_be_bytes());
    let header_checksum = checksum(&packet[..20]);
    packet[10..12].copy_from_slice(&header_checksum.to_be_bytes());
    let mut pseudo = packet[12..20].to_vec();
    pseudo.extend_from_slice(&[0, 6, 0, 20]);
    pseudo.extend_from_slice(&packet[20..]);
    let tcp_checksum = checksum(&pseudo);
    packet[36..38].copy_from_slice(&tcp_checksum.to_be_bytes());
    packet
}

#[tokio::test]
#[ignore = "requires isolated Docker network namespace, NET_ADMIN and /dev/net/tun"]
async fn kernel_rejects_database_destination_when_userspace_policy_is_bypassed() {
    let destination = std::env::var("ANTNEST_EGRESS_KERNEL_TEST_DESTINATION")
        .unwrap()
        .parse::<Ipv4Addr>()
        .unwrap();
    assert!(!antnest_runtime_egress::policy::is_external_ipv4(
        destination
    ));
    let plan = KernelPlan::new(
        "antnest-egress0",
        "100.64.0.0/29".parse().unwrap(),
        "100.64.0.1".parse().unwrap(),
        1400,
    )
    .unwrap();
    let (_, mut tun) = LinuxKernel::bootstrap(&plan, Duration::from_secs(5))
        .await
        .unwrap();
    let before = drop_count().await;
    // Test-only admission hook: bypass every userspace decision and write a
    // valid SYN directly into the production kernel adapter.
    tun.write_packet(&syn(destination)).await.unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if drop_count().await > before {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "protected traffic never hit the kernel backstop"
        );
        sleep(Duration::from_millis(20)).await;
    }
}
