use antnest_runtime_egress::kernel::{KernelPlan, nft_rules};

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
    let rules = nft_rules("antnest-egress0", "100.64.0.0/10".parse().unwrap());

    assert!(rules.contains("iifname \"antnest-egress0\" ip saddr 100.64.0.0/10"));
    assert!(rules.contains("tcp dport 53 accept"));
    assert!(rules.contains("ip saddr 100.64.0.0/10 masquerade"));
    assert!(!rules.contains("agent_id"));
    assert!(!rules.contains("generation"));
}
