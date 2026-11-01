use std::{net::Ipv4Addr, num::NonZeroU16, sync::Arc};

use ipnet::Ipv4Net;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de, ser::SerializeMap};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyAction {
    AllowAll,
    DenyAll,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PolicySpec {
    V1(PolicyAction),
    V2(Box<V2Spec>),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct V2Spec {
    default: RuleAction,
    rules: Vec<PolicyRule>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PolicyRule {
    action: RuleAction,
    cidrs: Vec<Ipv4Net>,
    domains: Vec<String>,
    ports: Vec<PortSelector>,
    protocol_tcp_only: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuleAction {
    Allow,
    Deny,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PortSelector {
    Single(NonZeroU16),
    Range { from: NonZeroU16, to: NonZeroU16 },
}

impl Serialize for PolicySpec {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        match self {
            Self::V1(action) => {
                map.serialize_entry("schema_version", &1_u32)?;
                map.serialize_entry("action", action)?;
            }
            Self::V2(spec) => {
                map.serialize_entry("schema_version", &2_u32)?;
                map.serialize_entry("default", &spec.default)?;
                map.serialize_entry("rules", &spec.rules)?;
            }
        }
        map.end()
    }
}

impl Serialize for PolicyRule {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        map.serialize_entry("action", &self.action)?;
        if !self.cidrs.is_empty() {
            map.serialize_entry(
                "cidrs",
                &self
                    .cidrs
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>(),
            )?;
        }
        if !self.domains.is_empty() {
            map.serialize_entry("domains", &self.domains)?;
        }
        if !self.ports.is_empty() {
            map.serialize_entry("ports", &self.ports)?;
        }
        if self.protocol_tcp_only {
            map.serialize_entry("protocol", "tcp")?;
        }
        map.end()
    }
}

impl Serialize for PortSelector {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Self::Single(port) => serializer.serialize_u16(port.get()),
            Self::Range { from, to } => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("from", &from.get())?;
                map.serialize_entry("to", &to.get())?;
                map.end()
            }
        }
    }
}

impl PolicySpec {
    pub const fn allow_all() -> Self {
        Self::V1(PolicyAction::AllowAll)
    }

    pub const fn deny_all() -> Self {
        Self::V1(PolicyAction::DenyAll)
    }

    pub const fn schema_version(&self) -> u32 {
        match self {
            Self::V1(_) => 1,
            Self::V2(_) => 2,
        }
    }

    pub const fn action(&self) -> PolicyAction {
        match self {
            Self::V1(action) => *action,
            Self::V2(_) => PolicyAction::DenyAll,
        }
    }

    pub fn compile(&self, resolver_ipv4: Ipv4Addr) -> CompiledPolicy {
        CompiledPolicy {
            inner: Arc::new(CompiledInner::compile(self)),
            resolver_ipv4,
        }
    }

    pub fn for_assignment(assignment: Option<&Self>, resolver_ipv4: Ipv4Addr) -> CompiledPolicy {
        assignment
            .cloned()
            .unwrap_or_else(Self::deny_all)
            .compile(resolver_ipv4)
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawPolicyAction {
    AllowAll,
    DenyAll,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawRule {
    action: RuleAction,
    #[serde(default, deserialize_with = "strict_optional")]
    cidrs: Option<Vec<RawCidr>>,
    #[serde(default, deserialize_with = "strict_optional")]
    domains: Option<Vec<RawDomain>>,
    #[serde(default, deserialize_with = "strict_optional")]
    ports: Option<Vec<RawPort>>,
    #[serde(default, deserialize_with = "strict_optional_flag")]
    protocol: Option<RawProtocol>,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum RawProtocol {
    Tcp,
}

fn strict_optional<'de, D, T>(deserializer: D) -> Result<Option<Vec<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Vec::<T>::deserialize(deserializer).map(Some)
}

pub fn canonical_ipv4_net(text: &str) -> Option<Ipv4Net> {
    let network = text.parse::<Ipv4Net>().ok()?;
    if network.addr() != network.network() || network.to_string() != text {
        return None;
    }
    Some(network)
}

struct RawCidr(Ipv4Net);

impl<'de> Deserialize<'de> for RawCidr {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let network = canonical_ipv4_net(&text)
            .ok_or_else(|| de::Error::custom("invalid canonical IPv4 CIDR"))?;
        Ok(Self(network))
    }
}

struct RawDomain(String);

impl<'de> Deserialize<'de> for RawDomain {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let valid = text.len() <= 253
            && text.split('.').count() >= 2
            && text.split('.').all(|label| {
                (1..=63).contains(&label.len())
                    && label.bytes().all(|byte| {
                        byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'
                    })
                    && !label.starts_with('-')
                    && !label.ends_with('-')
            });
        if !valid {
            return Err(de::Error::custom("invalid policy domain name"));
        }
        Ok(Self(text))
    }
}

#[derive(Deserialize)]
#[serde(untagged)]
enum RawPort {
    Single(NonZeroU16),
    Range(RawPortRange),
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawPortRange {
    from: NonZeroU16,
    to: NonZeroU16,
}

impl<'de> Deserialize<'de> for PolicySpec {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;
        impl<'de> de::Visitor<'de> for Visitor {
            type Value = PolicySpec;

            fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
                formatter.write_str("an Antnest egress policy document")
            }

            fn visit_map<A: de::MapAccess<'de>>(self, mut map: A) -> Result<PolicySpec, A::Error> {
                let mut version = None;
                let mut action = None;
                let mut default = None;
                let mut rules = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "schema_version" => {
                            reject_duplicate(version.is_some())?;
                            version = Some(map.next_value::<u32>()?);
                        }
                        "action" => {
                            reject_duplicate(action.is_some())?;
                            action = Some(map.next_value::<RawPolicyAction>()?);
                        }
                        "default" => {
                            reject_duplicate(default.is_some())?;
                            default = Some(map.next_value::<RuleAction>()?);
                        }
                        "rules" => {
                            reject_duplicate(rules.is_some())?;
                            rules = Some(map.next_value::<Vec<RawRule>>()?);
                        }
                        other => {
                            return Err(de::Error::unknown_field(
                                other,
                                &["schema_version", "action", "default", "rules"],
                            ));
                        }
                    }
                }
                match version {
                    Some(1) => {
                        if default.is_some() || rules.is_some() {
                            return Err(de::Error::custom("schema_version 1 carries action only"));
                        }
                        let action = action.ok_or_else(|| de::Error::missing_field("action"))?;
                        Ok(PolicySpec::V1(match action {
                            RawPolicyAction::AllowAll => PolicyAction::AllowAll,
                            RawPolicyAction::DenyAll => PolicyAction::DenyAll,
                        }))
                    }
                    Some(2) => {
                        if action.is_some() {
                            return Err(de::Error::custom(
                                "schema_version 2 carries default and rules only",
                            ));
                        }
                        let default = default.ok_or_else(|| de::Error::missing_field("default"))?;
                        let rules = rules.ok_or_else(|| de::Error::missing_field("rules"))?;
                        if rules.len() > 128 {
                            return Err(de::Error::custom("policy rules exceed 128"));
                        }
                        let rules = rules
                            .into_iter()
                            .map(compile_raw_rule)
                            .collect::<Result<Vec<_>, _>>()?;
                        Ok(PolicySpec::V2(Box::new(V2Spec { default, rules })))
                    }
                    Some(_) => Err(de::Error::custom("unsupported policy schema version")),
                    None => Err(de::Error::missing_field("schema_version")),
                }
            }
        }
        deserializer.deserialize_map(Visitor)
    }
}

fn reject_duplicate<E: de::Error>(seen: bool) -> Result<(), E> {
    if seen {
        Err(de::Error::custom("duplicate policy field"))
    } else {
        Ok(())
    }
}

fn strict_optional_flag<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn compile_raw_rule<E: de::Error>(raw: RawRule) -> Result<PolicyRule, E> {
    if raw.cidrs.is_some() && raw.domains.is_some() {
        return Err(de::Error::custom(
            "cidrs and domains are mutually exclusive",
        ));
    }
    if raw
        .cidrs
        .as_ref()
        .is_some_and(|list| !(1..=64).contains(&list.len()))
        || raw
            .domains
            .as_ref()
            .is_some_and(|list| !(1..=64).contains(&list.len()))
        || raw
            .ports
            .as_ref()
            .is_some_and(|list| !(1..=64).contains(&list.len()))
    {
        return Err(de::Error::custom("selector lists hold 1-64 entries"));
    }
    let ports = raw
        .ports
        .unwrap_or_default()
        .into_iter()
        .map(|port| match port {
            RawPort::Single(value) => Ok(PortSelector::Single(value)),
            RawPort::Range(RawPortRange { from, to }) => {
                if from > to {
                    Err(de::Error::custom("port range requires from <= to"))
                } else {
                    Ok(PortSelector::Range { from, to })
                }
            }
        })
        .collect::<Result<Vec<_>, E>>()?;
    Ok(PolicyRule {
        action: raw.action,
        cidrs: raw
            .cidrs
            .unwrap_or_default()
            .into_iter()
            .map(|cidr| cidr.0)
            .collect(),
        domains: raw
            .domains
            .unwrap_or_default()
            .into_iter()
            .map(|domain| domain.0)
            .collect(),
        ports,
        protocol_tcp_only: raw.protocol.is_some(),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Decision {
    Allow,
    Deny,
}

#[derive(Clone, Debug)]
pub struct CompiledPolicy {
    inner: Arc<CompiledInner>,
    resolver_ipv4: Ipv4Addr,
}

impl PartialEq for CompiledPolicy {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
            || (self.resolver_ipv4 == other.resolver_ipv4 && *self.inner == *other.inner)
    }
}

impl Eq for CompiledPolicy {}

#[derive(Debug, Eq, PartialEq)]
enum CompiledInner {
    V1 { allow: bool },
    V2(V2Compiled),
}

#[derive(Debug, Eq, PartialEq)]
struct V2Compiled {
    default_allow: bool,
    nodes: Vec<TrieNode>,
    wildcard_mask: u128,
    domain_mask: u128,
    allow_mask: u128,
    port_segments: Vec<(u16, u128)>,
    domains: Vec<Vec<String>>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TrieNode {
    children: [u32; 2],
    mask: u128,
}

impl CompiledInner {
    fn compile(spec: &PolicySpec) -> Self {
        match spec {
            PolicySpec::V1(action) => Self::V1 {
                allow: *action == PolicyAction::AllowAll,
            },
            PolicySpec::V2(spec) => Self::V2(V2Compiled::compile(spec)),
        }
    }
}

impl V2Compiled {
    fn compile(spec: &V2Spec) -> Self {
        let mut nodes = vec![TrieNode::default()];
        let mut wildcard_mask = 0_u128;
        let mut domain_mask = 0_u128;
        let mut allow_mask = 0_u128;
        let mut domains = Vec::with_capacity(spec.rules.len());
        let mut boundaries: Vec<(u16, u16, u128)> = Vec::new();
        for (index, rule) in spec.rules.iter().enumerate() {
            let bit = 1_u128 << index;
            if rule.action == RuleAction::Allow {
                allow_mask |= bit;
            }
            if !rule.cidrs.is_empty() {
                for cidr in &rule.cidrs {
                    trie_insert(&mut nodes, cidr, bit);
                }
            } else if !rule.domains.is_empty() {
                domain_mask |= bit;
            } else {
                wildcard_mask |= bit;
            }
            domains.push(rule.domains.clone());
            if rule.ports.is_empty() {
                boundaries.push((1, u16::MAX, bit));
            } else {
                for selector in &rule.ports {
                    let (from, to) = match selector {
                        PortSelector::Single(port) => (port.get(), port.get()),
                        PortSelector::Range { from, to } => (from.get(), to.get()),
                    };
                    boundaries.push((from, to, bit));
                }
            }
        }
        let port_segments = compile_port_segments(&boundaries);
        Self {
            default_allow: spec.default == RuleAction::Allow,
            nodes,
            wildcard_mask,
            domain_mask,
            allow_mask,
            port_segments,
            domains,
        }
    }

    fn candidates(&self, destination: Ipv4Addr, port: u16, binding_mask: u128) -> u128 {
        let port_mask = self
            .port_segments
            .partition_point(|(start, _)| *start <= port)
            .checked_sub(1)
            .map_or(0, |index| self.port_segments[index].1);
        let trie_mask = trie_lookup(&self.nodes, destination);
        (trie_mask | self.wildcard_mask | (binding_mask & self.domain_mask)) & port_mask
    }

    fn domain_rule_mask(&self, name: &str) -> u128 {
        let mut mask = 0_u128;
        for (index, names) in self.domains.iter().enumerate() {
            if names.iter().any(|domain| domain == name) {
                mask |= 1_u128 << index;
            }
        }
        mask
    }
}

fn trie_insert(nodes: &mut Vec<TrieNode>, network: &Ipv4Net, bit: u128) {
    let address = u32::from(network.network());
    let mut index = 0_usize;
    for depth in 0..network.prefix_len() {
        let bit_index = 31 - depth;
        let child = ((address >> bit_index) & 1) as usize;
        let next = nodes[index].children[child];
        let next = if next == 0 {
            nodes.push(TrieNode::default());
            let created = (nodes.len() - 1) as u32;
            nodes[index].children[child] = created;
            created
        } else {
            next
        };
        index = next as usize;
    }
    nodes[index].mask |= bit;
}

fn trie_lookup(nodes: &[TrieNode], destination: Ipv4Addr) -> u128 {
    let mut mask = nodes[0].mask;
    let mut index = 0_usize;
    let address = u32::from(destination);
    for depth in 0..32 {
        let child = ((address >> (31 - depth)) & 1) as usize;
        let next = nodes[index].children[child];
        if next == 0 {
            break;
        }
        index = next as usize;
        mask |= nodes[index].mask;
    }
    mask
}

fn compile_port_segments(boundaries: &[(u16, u16, u128)]) -> Vec<(u16, u128)> {
    let mut points: Vec<u32> = vec![1, 65_536];
    for (from, to, _) in boundaries {
        points.push(u32::from(*from));
        points.push(u32::from(*to) + 1);
    }
    points.sort_unstable();
    points.dedup();
    let mut segments: Vec<(u16, u128)> = Vec::new();
    for window in points.windows(2) {
        let start = window[0];
        let mask = boundaries.iter().fold(0_u128, |mask, (from, to, bit)| {
            if u32::from(*from) <= start && start <= u32::from(*to) {
                mask | bit
            } else {
                mask
            }
        });
        if let Some((_, last)) = segments.last_mut()
            && *last == mask
        {
            continue;
        }
        segments.push((start as u16, mask));
    }
    segments
}

impl CompiledPolicy {
    pub fn decide(&self, destination: Ipv4Addr, destination_port: u16) -> Decision {
        self.decide_with_bindings(destination, destination_port, 0)
    }

    pub fn decide_with_bindings(
        &self,
        destination: Ipv4Addr,
        destination_port: u16,
        binding_mask: u128,
    ) -> Decision {
        match &*self.inner {
            CompiledInner::V1 { allow } => {
                if !allow {
                    return Decision::Deny;
                }
                if destination == self.resolver_ipv4 && destination_port == 53 {
                    return Decision::Allow;
                }
                if is_external_ipv4(destination) {
                    Decision::Allow
                } else {
                    Decision::Deny
                }
            }
            CompiledInner::V2(compiled) => {
                if destination == self.resolver_ipv4 && destination_port == 53 {
                    return Decision::Allow;
                }
                if is_hard_special_ipv4(destination) {
                    return Decision::Deny;
                }
                let candidates = compiled.candidates(destination, destination_port, binding_mask);
                if candidates != 0 {
                    let rule = candidates.trailing_zeros() as usize;
                    return if compiled.allow_mask & (1_u128 << rule) != 0 {
                        Decision::Allow
                    } else {
                        Decision::Deny
                    };
                }
                if compiled.default_allow && is_external_ipv4(destination) {
                    Decision::Allow
                } else {
                    Decision::Deny
                }
            }
        }
    }

    pub fn resolver_ipv4(&self) -> Ipv4Addr {
        self.resolver_ipv4
    }

    pub fn domain_rule_mask(&self, name: &str) -> u128 {
        match &*self.inner {
            CompiledInner::V1 { .. } => 0,
            CompiledInner::V2(compiled) => compiled.domain_rule_mask(name),
        }
    }

    pub fn explicit_any_port_allow(&self, destination: Ipv4Addr, domain_mask: u128) -> bool {
        let CompiledInner::V2(compiled) = &*self.inner else {
            return false;
        };
        if is_hard_special_ipv4(destination) {
            return false;
        }
        let base = trie_lookup(&compiled.nodes, destination)
            | compiled.wildcard_mask
            | (domain_mask & compiled.domain_mask);
        if base == 0 {
            return false;
        }
        compiled.port_segments.iter().any(|(_, segment)| {
            let matched = base & segment;
            matched != 0 && compiled.allow_mask & matched.isolate_lowest_one() != 0
        })
    }
}

pub const PROTECTED_IPV4_NETWORKS: &[Ipv4Net] = &[
    Ipv4Net::new_assert(Ipv4Addr::new(0, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(10, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(100, 64, 0, 0), 10),
    Ipv4Net::new_assert(Ipv4Addr::new(127, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(169, 254, 0, 0), 16),
    Ipv4Net::new_assert(Ipv4Addr::new(172, 16, 0, 0), 12),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 0, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 0, 2, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 88, 99, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 168, 0, 0), 16),
    Ipv4Net::new_assert(Ipv4Addr::new(198, 18, 0, 0), 15),
    Ipv4Net::new_assert(Ipv4Addr::new(198, 51, 100, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(203, 0, 113, 0), 24),
    Ipv4Net::new_assert(Ipv4Addr::new(224, 0, 0, 0), 4),
    Ipv4Net::new_assert(Ipv4Addr::new(240, 0, 0, 0), 4),
];

pub const RFC1918_IPV4_NETWORKS: &[Ipv4Net] = &[
    Ipv4Net::new_assert(Ipv4Addr::new(10, 0, 0, 0), 8),
    Ipv4Net::new_assert(Ipv4Addr::new(172, 16, 0, 0), 12),
    Ipv4Net::new_assert(Ipv4Addr::new(192, 168, 0, 0), 16),
];

pub fn is_external_ipv4(address: Ipv4Addr) -> bool {
    !PROTECTED_IPV4_NETWORKS
        .iter()
        .any(|network| network.contains(&address))
}

pub fn is_hard_special_ipv4(address: Ipv4Addr) -> bool {
    let private = RFC1918_IPV4_NETWORKS
        .iter()
        .any(|network| network.contains(&address));
    !private
        && PROTECTED_IPV4_NETWORKS
            .iter()
            .any(|network| network.contains(&address))
}
