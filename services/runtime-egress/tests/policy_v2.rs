use std::net::Ipv4Addr;

use antnest_runtime_egress::policy::{
    Decision, PROTECTED_IPV4_NETWORKS, PolicyAction, PolicySpec, is_external_ipv4,
};
use ipnet::Ipv4Net;

fn ip(text: &str) -> Ipv4Addr {
    text.parse().expect("ipv4")
}

fn resolver() -> Ipv4Addr {
    ip("100.64.0.1")
}

fn spec(document: &str) -> PolicySpec {
    serde_json::from_str(document).expect("policy document")
}

fn rule_doc(rule: &str) -> String {
    format!(r#"{{"schema_version":2,"default":"deny","rules":[{rule}]}}"#)
}

const HARD_SPECIAL_CASES: &[&str] = &[
    "0.0.0.1",
    "100.64.0.2",
    "127.0.0.1",
    "169.254.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.88.99.1",
    "198.18.0.1",
    "198.19.255.255",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
];

#[test]
fn v2_representative_policy_enforces_ordered_rules_and_internal_allow() {
    let policy = spec(
        r#"{
          "schema_version": 2,
          "default": "deny",
          "rules": [
            {"action": "deny", "ports": [25]},
            {"action": "allow", "domains": ["api.github.com"], "ports": [443]},
            {"action": "allow", "cidrs": ["10.20.0.15/32"], "ports": [443]},
            {"action": "allow", "cidrs": ["93.184.216.0/24"], "ports": [{"from": 400, "to": 450}]}
          ]
        }"#,
    )
    .compile(resolver());

    assert_eq!(policy.decide(ip("140.82.112.6"), 443), Decision::Deny);
    assert_eq!(policy.decide(ip("93.184.216.10"), 25), Decision::Deny);
    assert_eq!(policy.decide(ip("10.20.0.15"), 25), Decision::Deny);
    assert_eq!(policy.decide(ip("10.20.0.15"), 443), Decision::Allow);
    assert_eq!(policy.decide(ip("10.20.0.16"), 443), Decision::Deny);
    assert_eq!(policy.decide(ip("10.20.0.15"), 80), Decision::Deny);
    assert_eq!(policy.decide(ip("93.184.216.10"), 400), Decision::Allow);
    assert_eq!(policy.decide(ip("93.184.216.10"), 443), Decision::Allow);
    assert_eq!(policy.decide(ip("93.184.216.10"), 450), Decision::Allow);
    assert_eq!(policy.decide(ip("93.184.216.10"), 399), Decision::Deny);
    assert_eq!(policy.decide(ip("93.184.216.10"), 451), Decision::Deny);
    assert_eq!(policy.decide(ip("8.8.8.8"), 443), Decision::Deny);
}

#[test]
fn v2_rules_decide_first_match_not_rule_priority() {
    let deny_first = spec(
        r#"{"schema_version":2,"default":"deny","rules":[
            {"action":"deny","ports":[25]},{"action":"allow"}]}"#,
    )
    .compile(resolver());
    assert_eq!(deny_first.decide(ip("8.8.8.8"), 25), Decision::Deny);
    assert_eq!(deny_first.decide(ip("8.8.8.8"), 443), Decision::Allow);

    let allow_first = spec(
        r#"{"schema_version":2,"default":"deny","rules":[
            {"action":"allow"},{"action":"deny","ports":[25]}]}"#,
    )
    .compile(resolver());
    assert_eq!(allow_first.decide(ip("8.8.8.8"), 25), Decision::Allow);
}

#[test]
fn v2_default_allow_stays_external_only_and_default_deny_keeps_resolver() {
    let allow = spec(r#"{"schema_version":2,"default":"allow","rules":[]}"#).compile(resolver());
    assert_eq!(allow.decide(ip("93.184.216.34"), 443), Decision::Allow);
    for &protected in ["10.0.0.1", "172.16.0.1", "192.168.0.1"]
        .iter()
        .chain(HARD_SPECIAL_CASES)
    {
        assert_eq!(
            allow.decide(ip(protected), 443),
            Decision::Deny,
            "{protected}"
        );
    }
    assert_eq!(allow.decide(resolver(), 53), Decision::Allow);
    assert_eq!(allow.decide(resolver(), 443), Decision::Deny);

    let deny = spec(r#"{"schema_version":2,"default":"deny","rules":[]}"#).compile(resolver());
    assert_eq!(deny.decide(resolver(), 53), Decision::Allow);
    assert_eq!(deny.decide(resolver(), 443), Decision::Deny);
    assert_eq!(deny.decide(ip("93.184.216.34"), 443), Decision::Deny);
}

#[test]
fn v2_explicit_allow_reaches_rfc1918_but_never_hard_special() {
    let policy = spec(r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow"}]}"#)
        .compile(resolver());
    for internal in ["10.20.0.15", "172.16.9.9", "192.168.7.7"] {
        assert_eq!(
            policy.decide(ip(internal), 443),
            Decision::Allow,
            "{internal}"
        );
    }
    for &hard in HARD_SPECIAL_CASES {
        assert_eq!(policy.decide(ip(hard), 443), Decision::Deny, "{hard}");
    }
    assert_eq!(policy.decide(resolver(), 53), Decision::Allow);
    assert_eq!(policy.decide(resolver(), 443), Decision::Deny);
}

#[test]
fn v1_documents_keep_exact_bytes_and_resolver_denial() {
    let allow: PolicySpec =
        serde_json::from_str(r#"{"schema_version":1,"action":"allow_all"}"#).expect("v1 allow");
    let deny: PolicySpec =
        serde_json::from_str(r#"{"schema_version":1,"action":"deny_all"}"#).expect("v1 deny");
    assert_eq!(
        serde_json::to_string(&allow).expect("v1 allow bytes"),
        r#"{"schema_version":1,"action":"allow_all"}"#
    );
    assert_eq!(
        serde_json::to_string(&deny).expect("v1 deny bytes"),
        r#"{"schema_version":1,"action":"deny_all"}"#
    );
    assert_eq!(allow.schema_version(), 1);
    assert_eq!(allow.action(), PolicyAction::AllowAll);
    assert_eq!(deny.action(), PolicyAction::DenyAll);
    assert_eq!(
        allow.compile(resolver()).decide(resolver(), 53),
        Decision::Allow
    );
    assert_eq!(
        allow.compile(resolver()).decide(resolver(), 443),
        Decision::Deny
    );
    assert_eq!(
        allow.compile(resolver()).decide(ip("10.20.0.15"), 443),
        Decision::Deny
    );
    assert_eq!(
        allow.compile(resolver()).decide(ip("93.184.216.34"), 443),
        Decision::Allow
    );
    assert_eq!(
        deny.compile(resolver()).decide(resolver(), 53),
        Decision::Deny
    );
    assert_eq!(
        deny.compile(resolver()).decide(ip("93.184.216.34"), 443),
        Decision::Deny
    );
}

#[test]
fn v2_rejects_invalid_documents() {
    let mut invalid = vec![
        r#"{"schema_version":3,"default":"deny","rules":[]}"#.to_string(),
        r#"{"schema_version":2,"action":"allow_all"}"#.to_string(),
        r#"{"schema_version":1,"default":"deny","rules":[]}"#.to_string(),
        r#"{"schema_version":2,"default":"allow_all","rules":[]}"#.to_string(),
        r#"{"schema_version":2,"default":"deny"}"#.to_string(),
        r#"{"schema_version":2,"rules":[]}"#.to_string(),
        r#"{"schema_version":2,"default":"deny","rules":[],"note":"x"}"#.to_string(),
        rule_doc(r#"{}"#),
        rule_doc(r#"{"action":"permit"}"#),
        rule_doc(r#"{"action":"allow","protocol":"udp"}"#),
        rule_doc(r#"{"action":"allow","priority":1}"#),
        rule_doc(r#"{"action":"allow","cidrs":[]}"#),
        rule_doc(r#"{"action":"allow","domains":[]}"#),
        rule_doc(r#"{"action":"allow","ports":[]}"#),
        rule_doc(r#"{"action":"allow","cidrs":["10.0.0.0/8"],"domains":["example.com"]}"#),
    ];
    for cidr in [
        "10.0.0.0/33",
        "10.0.0.0/08",
        "010.0.0.0/8",
        "10.0.0.1",
        "256.0.0.0/8",
        "10.0.0.0/",
        "::1/64",
        "10.0.0.1/24",
        "192.168.1.1/16",
    ] {
        invalid.push(rule_doc(&format!(
            r#"{{"action":"deny","cidrs":["{cidr}"]}}"#
        )));
    }
    let mut domains: Vec<String> = [
        "*.example.com",
        "Example.COM",
        "localhost",
        "example.com.",
        "-example.com",
        "example-.com",
        "example..com",
        "exa_mple.com",
    ]
    .iter()
    .map(|domain| domain.to_string())
    .collect();
    domains.push(format!("{}.com", "a".repeat(64)));
    domains.push(format!(
        "{}.{}.{}.{}.example.com",
        "a".repeat(63),
        "b".repeat(63),
        "c".repeat(63),
        "d".repeat(63)
    ));
    for domain in domains {
        invalid.push(rule_doc(&format!(
            r#"{{"action":"allow","domains":["{domain}"]}}"#
        )));
    }
    for ports in [
        "[0]",
        "[65536]",
        "[-1]",
        "[1.5]",
        r#"["443"]"#,
        r#"[{"from":0,"to":80}]"#,
        r#"[{"from":80,"to":65536}]"#,
        r#"[{"from":90,"to":80}]"#,
        r#"[{"from":80}]"#,
        r#"[{"to":80}]"#,
        r#"[{"from":80,"to":90,"label":"x"}]"#,
        r#"[{"from":"80","to":90}]"#,
    ] {
        invalid.push(rule_doc(&format!(
            r#"{{"action":"allow","ports":{ports}}}"#
        )));
    }
    invalid.push(format!(
        r#"{{"schema_version":2,"default":"deny","rules":[{}]}}"#,
        vec![r#"{"action":"deny"}"#; 129].join(",")
    ));
    for (field, item) in [
        ("cidrs", r#""10.0.0.0/8""#),
        ("domains", r#""a.example.com""#),
        ("ports", "443"),
    ] {
        invalid.push(rule_doc(&format!(
            r#"{{"action":"allow","{field}":[{}]}}"#,
            vec![item; 65].join(",")
        )));
    }
    for document in invalid {
        assert!(
            serde_json::from_str::<PolicySpec>(&document).is_err(),
            "{document}"
        );
    }
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }
}

fn build_cidr(rng: &mut Rng) -> String {
    let prefix = (8 + rng.below(25)) as u32;
    let base = match rng.below(4) {
        0 => u32::from_be_bytes([10, rng.next() as u8, rng.next() as u8, rng.next() as u8]),
        1 => u32::from_be_bytes([
            172,
            16 + (rng.next() as u8 & 15),
            rng.next() as u8,
            rng.next() as u8,
        ]),
        2 => u32::from_be_bytes([192, 168, rng.next() as u8, rng.next() as u8]),
        _ => rng.next() as u32,
    };
    let mask = if prefix == 32 {
        u32::MAX
    } else {
        u32::MAX << (32 - prefix)
    };
    format!("{}/{}", Ipv4Addr::from(base & mask), prefix)
}

fn build_port(rng: &mut Rng) -> serde_json::Value {
    if rng.below(2) == 0 {
        serde_json::json!(1 + rng.below(65535))
    } else {
        let from = 1 + rng.below(65535);
        let to = from + rng.below(65536 - from);
        serde_json::json!({"from": from, "to": to})
    }
}

fn build_policy(rng: &mut Rng) -> serde_json::Value {
    let rules = (0..rng.below(9))
        .map(|_| {
            let mut rule = serde_json::json!({
                "action": if rng.below(4) == 0 { "deny" } else { "allow" }
            });
            if rng.below(4) > 0 {
                rule["cidrs"] = serde_json::json!(
                    (0..1 + rng.below(3))
                        .map(|_| build_cidr(rng))
                        .collect::<Vec<_>>()
                );
            }
            if rng.below(3) > 0 {
                rule["ports"] = serde_json::json!(
                    (0..1 + rng.below(4))
                        .map(|_| build_port(rng))
                        .collect::<Vec<_>>()
                );
            }
            if rng.below(2) == 0 {
                rule["protocol"] = serde_json::json!("tcp");
            }
            rule
        })
        .collect::<Vec<_>>();
    serde_json::json!({
        "schema_version": 2,
        "default": if rng.below(2) == 0 { "allow" } else { "deny" },
        "rules": rules,
    })
}

fn build_destinations(
    rng: &mut Rng,
    document: &serde_json::Value,
    resolver: Ipv4Addr,
) -> Vec<(Ipv4Addr, u16)> {
    let mut out: Vec<(Ipv4Addr, u16)> = vec![
        (resolver, 53),
        (resolver, 443),
        (ip("8.8.8.8"), 443),
        (ip("8.8.8.8"), 25),
        (ip("1.1.1.1"), 53),
        (ip("9.255.255.255"), 443),
        (ip("10.0.0.0"), 443),
        (ip("10.255.255.255"), 443),
        (ip("11.0.0.0"), 443),
        (ip("172.15.255.255"), 443),
        (ip("172.16.0.0"), 443),
        (ip("172.31.255.255"), 443),
        (ip("172.32.0.0"), 443),
        (ip("192.167.255.255"), 443),
        (ip("192.168.0.0"), 443),
        (ip("192.168.255.255"), 443),
        (ip("192.169.0.0"), 443),
        (ip("127.0.0.1"), 443),
        (ip("169.254.1.1"), 443),
        (ip("100.64.0.2"), 443),
        (ip("192.0.2.1"), 443),
        (ip("198.51.100.1"), 443),
        (ip("203.0.113.1"), 443),
        (ip("224.0.0.1"), 443),
        (ip("240.0.0.1"), 443),
        (ip("255.255.255.255"), 443),
        (ip("0.0.0.1"), 443),
        (ip("198.18.0.1"), 443),
        (ip("198.19.255.255"), 443),
        (ip("192.88.99.1"), 443),
        (ip("192.0.0.1"), 443),
        (ip("93.184.216.34"), 443),
    ];
    let empty = Vec::new();
    let rules = document["rules"].as_array().unwrap_or(&empty);
    for rule in rules {
        let mut bases: Vec<u32> = Vec::new();
        if let Some(list) = rule.get("cidrs") {
            for entry in list.as_array().expect("cidrs list") {
                let network: Ipv4Net = entry.as_str().expect("cidr").parse().expect("net");
                let base = u32::from(network.network());
                let broadcast = u32::from(network.broadcast());
                bases.push(base);
                bases.push(broadcast);
                if broadcast > base {
                    bases.push(base + (rng.below(u64::from(broadcast - base + 1)) as u32));
                }
                if base > 0 {
                    bases.push(base - 1);
                }
                if broadcast < u32::MAX {
                    bases.push(broadcast + 1);
                }
            }
        } else {
            bases.extend([u32::from(ip("8.8.8.8")), u32::from(ip("10.20.0.15"))]);
        }
        let mut ports: Vec<u16> = Vec::new();
        if let Some(list) = rule.get("ports") {
            for entry in list.as_array().expect("ports list") {
                if let Some(value) = entry.as_u64() {
                    let port = value as u16;
                    if port > 1 {
                        ports.push(port - 1);
                    }
                    ports.push(port);
                    if port < u16::MAX {
                        ports.push(port + 1);
                    }
                } else {
                    let from = entry["from"].as_u64().expect("from") as u16;
                    let to = entry["to"].as_u64().expect("to") as u16;
                    if from > 1 {
                        ports.push(from - 1);
                    }
                    ports.push(from);
                    ports.push(to);
                    if to < u16::MAX {
                        ports.push(to + 1);
                    }
                }
            }
        } else {
            ports.extend([443, 25]);
        }
        for &address in bases.iter().take(6) {
            for &port in ports.iter().take(6) {
                out.push((Ipv4Addr::from(address), port));
            }
        }
    }
    while out.len() < 128 {
        out.push((
            Ipv4Addr::from(rng.next() as u32),
            1 + rng.below(65535) as u16,
        ));
    }
    out.truncate(128);
    out
}

fn rfc1918() -> [Ipv4Net; 3] {
    [
        Ipv4Net::new_assert(Ipv4Addr::new(10, 0, 0, 0), 8),
        Ipv4Net::new_assert(Ipv4Addr::new(172, 16, 0, 0), 12),
        Ipv4Net::new_assert(Ipv4Addr::new(192, 168, 0, 0), 16),
    ]
}

fn reference_rule_matches(rule: &serde_json::Value, address: Ipv4Addr, port: u16) -> bool {
    if let Some(list) = rule.get("cidrs") {
        let hit = list.as_array().expect("cidrs list").iter().any(|entry| {
            entry
                .as_str()
                .expect("cidr")
                .parse::<Ipv4Net>()
                .expect("net")
                .contains(&address)
        });
        if !hit {
            return false;
        }
    }
    if rule.get("domains").is_some() {
        return false;
    }
    if let Some(list) = rule.get("ports") {
        let hit = list.as_array().expect("ports list").iter().any(|entry| {
            if let Some(value) = entry.as_u64() {
                value == u64::from(port)
            } else {
                let from = entry["from"].as_u64().expect("from");
                let to = entry["to"].as_u64().expect("to");
                from <= u64::from(port) && u64::from(port) <= to
            }
        });
        if !hit {
            return false;
        }
    }
    true
}

fn reference_decide(
    document: &serde_json::Value,
    resolver: Ipv4Addr,
    address: Ipv4Addr,
    port: u16,
) -> Decision {
    if address == resolver && port == 53 {
        return Decision::Allow;
    }
    let internal = rfc1918().iter().any(|network| network.contains(&address));
    let protected = PROTECTED_IPV4_NETWORKS
        .iter()
        .any(|network| network.contains(&address));
    if protected && !internal {
        return Decision::Deny;
    }
    let empty = Vec::new();
    for rule in document["rules"].as_array().unwrap_or(&empty) {
        if reference_rule_matches(rule, address, port) {
            return if rule["action"] == "allow" {
                Decision::Allow
            } else {
                Decision::Deny
            };
        }
    }
    if document["default"] == "allow" && is_external_ipv4(address) {
        Decision::Allow
    } else {
        Decision::Deny
    }
}

#[test]
fn generated_v2_policies_match_linear_reference() {
    let resolver = resolver();
    let mut rng = Rng(0x9E3779B97F4A7C15);
    for _ in 0..64 {
        let document = build_policy(&mut rng);
        let policy: PolicySpec =
            serde_json::from_value(document.clone()).expect("generated policy document");
        let compiled = policy.compile(resolver);
        for (address, port) in build_destinations(&mut rng, &document, resolver) {
            assert_eq!(
                compiled.decide(address, port),
                reference_decide(&document, resolver, address, port),
                "{document} {address}:{port}"
            );
        }
    }
}

#[test]
fn v2_port_segments_cover_exact_bounds_and_the_128th_rule() {
    let rules: Vec<String> = (0..127)
        .map(|index| {
            format!(
                r#"{{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[{}]}}"#,
                1000 + index
            )
        })
        .collect();
    let document = format!(
        r#"{{"schema_version":2,"default":"deny","rules":[{},{{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[{{"from":65534,"to":65535}}]}}]}}"#,
        rules.join(",")
    );
    let parsed = spec(&document);
    let compiled = parsed.compile(resolver());
    let target = ip("93.184.216.7");
    for (port, allowed) in [
        (443_u16, false),
        (1000, true),
        (1126, true),
        (1127, false),
        (65533, false),
        (65534, true),
        (65535, true),
    ] {
        assert_eq!(
            compiled.decide(target, port),
            if allowed {
                Decision::Allow
            } else {
                Decision::Deny
            },
            "port {port}"
        );
    }
    let bounded = r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[65535]}]}"#;
    let compiled = spec(bounded).compile(resolver());
    assert_eq!(compiled.decide(target, 65535), Decision::Allow);
    assert_eq!(compiled.decide(target, 65534), Decision::Deny);
    let only = r#"{"schema_version":2,"default":"deny","rules":[{"action":"allow","cidrs":["93.184.216.0/24"],"ports":[65534]}]}"#;
    let compiled = spec(only).compile(resolver());
    assert_eq!(compiled.decide(target, 65534), Decision::Allow);
    assert_eq!(compiled.decide(target, 65535), Decision::Deny);
}
