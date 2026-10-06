use antnest_runtime_egress::{
    kernel::{KernelPlan, connected_ipv4_subnets, nft_rules},
    policy::{PROTECTED_IPV4_NETWORKS, is_external_ipv4},
};
use std::collections::BTreeSet;

#[test]
fn nft_and_userspace_use_the_same_protected_range_set() {
    let rules = nft_rules(
        "antnest-egress0",
        "100.64.0.0/10".parse().unwrap(),
        "100.64.0.1".parse().unwrap(),
        &[],
    );
    let ranges = rules
        .split_once("ip daddr { ")
        .unwrap()
        .1
        .split_once(" }")
        .unwrap()
        .0;
    let actual: BTreeSet<ipnet::Ipv4Net> = ranges
        .split(", ")
        .map(|value| value.parse().unwrap())
        .collect();
    assert_eq!(actual, PROTECTED_IPV4_NETWORKS.iter().copied().collect());
    for network in PROTECTED_IPV4_NETWORKS {
        assert!(!is_external_ipv4(network.network()));
        assert!(!is_external_ipv4(network.broadcast()));
    }
    assert!(rules.contains("ip daddr 100.64.0.1 tcp dport 53 accept"));
    assert!(rules.contains("iifname \"antnest-egress0\" drop"));
}

#[test]
fn kernel_also_protects_connected_public_subnets_without_overlapping_intervals() {
    let connected = [
        "93.184.216.0/24".parse().unwrap(),
        "93.184.216.128/25".parse().unwrap(),
        "10.243.1.0/24".parse().unwrap(),
    ];
    let rules = nft_rules(
        "antnest-egress0",
        "100.64.0.0/10".parse().unwrap(),
        "100.64.0.1".parse().unwrap(),
        &connected,
    );
    assert!(rules.contains("93.184.216.0/24"));
    assert!(!rules.contains("93.184.216.128/25"));
    assert!(!rules.contains("10.243.1.0/24"));
}

#[test]
fn connected_subnet_discovery_reads_kernel_routes_and_rejects_incomplete_evidence() {
    let destination = u32::from_ne_bytes([93, 184, 216, 0]);
    let mask = u32::from_ne_bytes([255, 255, 255, 0]);
    let routes = format!(
        "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\neth0 {destination:08X} 00000000 0001 0 0 0 {mask:08X} 0 0 0\neth0 00000000 01010101 0003 0 0 0 00000000 0 0 0\n"
    );
    assert_eq!(
        connected_ipv4_subnets(&routes).unwrap(),
        vec!["93.184.216.0/24".parse::<ipnet::Ipv4Net>().unwrap()]
    );
    for invalid in [
        "",
        "unexpected header",
        "Iface Destination Gateway\neth0 0001",
        "Iface Destination Gateway\neth0 00000001 00000000 0001 0 0 0 00FF00FF",
    ] {
        assert!(connected_ipv4_subnets(invalid).is_err());
    }
}

#[test]
fn kernel_plan_owns_only_the_egress_namespace() {
    let plan = KernelPlan::new(
        "antnest-egress0",
        "100.64.0.0/10".parse().unwrap(),
        "100.64.0.1".parse().unwrap(),
        1400,
    )
    .unwrap();

    assert_eq!(
        plan.setup_commands(),
        vec![
            vec![
                "ip",
                "address",
                "replace",
                "100.64.0.1/10",
                "dev",
                "antnest-egress0",
            ],
            vec![
                "ip",
                "link",
                "set",
                "dev",
                "antnest-egress0",
                "mtu",
                "1400",
                "up",
            ],
            vec![
                "ip",
                "route",
                "replace",
                "100.64.0.0/10",
                "dev",
                "antnest-egress0",
            ],
        ]
    );
}

#[test]
fn nft_policy_forwards_tcp_dns_and_nat_without_agent_rules() {
    let rules = nft_rules(
        "antnest-egress0",
        "100.64.0.0/10".parse().unwrap(),
        "100.64.0.1".parse().unwrap(),
        &[],
    );

    assert!(rules.contains("iifname \"antnest-egress0\" ip saddr 100.64.0.0/10"));
    assert!(rules.contains("tcp dport 53 accept"));
    assert!(rules.contains("ip saddr 100.64.0.0/10 masquerade"));
    assert!(!rules.contains("agent_id"));
    assert!(!rules.contains("generation"));
}

#[test]
fn issue_34_kernel_drops_protected_destinations_before_accepting_uplink() {
    let rules = nft_rules(
        "antnest-egress0",
        "100.64.0.0/10".parse().unwrap(),
        "100.64.0.1".parse().unwrap(),
        &[],
    );
    let forward = rules.split("chain input").next().unwrap();
    let drop = forward
        .find("0.0.0.0/8")
        .expect("destination backstop missing");
    let accept = forward.find("meta l4proto tcp accept").unwrap();
    assert!(drop < accept);
    for range in [
        "10.0.0.0/8",
        "100.64.0.0/10",
        "127.0.0.0/8",
        "169.254.0.0/16",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "224.0.0.0/4",
        "240.0.0.0/4",
    ] {
        assert!(forward[..accept].contains(range), "{range}");
    }
}
